// src/fetchers/ndbcWidget.ts
//
// NDBC widget upstream fetcher.
//
// The widget endpoint returns a small static HTML page — no JavaScript
// rendering required, no embedded JSON. It's the official NOAA fallback
// when BuoyPro is unavailable, and for some stations it carries information
// BuoyPro doesn't expose: decomposed swell vs. wind-wave components.
//
// URL pattern: https://www.ndbc.noaa.gov/widgets/station_page.php?station=<NDBC_ID>
//
// What the page exposes (verified against 46221 and 46222, April 2026):
//
//   First <p> block (summary):
//     1:26 pm PDT
//     2026 GMT 04/26/2026             <- timestamp: HHMM GMT MM/DD/YYYY
//     Seas: 3.0 ft                    <- significant wave height (Hs)
//     Peak Period: 4 sec              <- dominant/peak period
//     Water Temp: 62.1 °F
//
//   Second <p> block (Wave Summary, decomposed):
//     1:26 pm PDT
//     2026 GMT 04/26/2026
//     Swell: 1.0 ft                   <- swell component height
//     Period: 12.5 sec                <- swell component period
//     Direction: SSW                  <- swell component direction (cardinal)
//     Wind Wave: 3.0 ft               <- wind-wave component height
//     Period: 4.3 sec                 <- wind-wave component period
//     Direction: W                    <- wind-wave component direction (cardinal)
//
// Notes:
//   - "Seas" and "Wind Wave" heights may be identical when wind-wave dominates Hs,
//     which is normal SoCal-morning behavior. Not a parse bug.
//   - The widget does NOT expose an aggregate mean_wave_direction_deg; the
//     decomposed direction fields are the only direction info. Aggregate
//     direction stays undefined for widget reads.
//   - The widget does NOT expose wind data (the buoys themselves don't carry
//     wind sensors at these SoCal nearshore locations). Wind comes from
//     METAR via Phase 3.
//   - Directions are 16-point compass cardinals (N, NNE, NE, ..., NW, NNW),
//     converted to degrees centered on the cardinal band. The original cardinal
//     string is preserved alongside the conversion to honestly signal the
//     ~22.5° precision band.
//   - Timestamp parsing: the GMT line is "HHMM GMT MM/DD/YYYY" where HHMM is
//     24-hour UTC time as a four-digit string (e.g. "2026" = 20:26 UTC, NOT
//     the year). Year appears in the trailing date portion.

import type { Observation, UpstreamFetcher, WaveComponent } from "../schema";

const NDBC_WIDGET_USER_AGENT =
  "Surf-Report-Worker/0.1 (+https://github.com/nfischbein/Surf-Report-Worker)";

interface ParsedSummary {
  observedAt?: string;          // ISO 8601 UTC
  seasFt?: number;
  peakPeriodS?: number;
  waterTempF?: number;
}

interface ParsedWaveSummary {
  swell?: WaveComponent;
  windWave?: WaveComponent;
}

export const ndbcWidgetFetcher: UpstreamFetcher = {
  source: "ndbc_widget",
  async fetch(stationId: string) {
    const url = `https://www.ndbc.noaa.gov/widgets/station_page.php?station=${stationId}`;
    const fetchedAt = new Date().toISOString();

    const response = await fetch(url, {
      headers: { "user-agent": NDBC_WIDGET_USER_AGENT },
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();

    // Sanity check: does this page actually look like the widget we expect?
    // Bad station IDs return a page with no observation paragraphs at all.
    if (!html.includes(`Station ${stationId}`)) {
      return null;
    }

    const summary = parseSummaryBlock(html);
    const waveSummary = parseWaveSummaryBlock(html);

    const observation = composeObservation({ summary, waveSummary, fetchedAt });
    if (observation === null) return null;

    return {
      observation,
      url,
      fetched_at: fetchedAt,
    };
  },
};

// ---- Block extraction ----

// The widget page has two <p> blocks of interest. We isolate each block by
// its leading anchor text, then parse fields out of it.
//
// The first block has no header — it starts directly with the timestamp.
// The second block starts with "Wave Summary".

function extractBlock(html: string, anchor: string, terminator: string): string | null {
  const start = html.indexOf(anchor);
  if (start === -1) return null;
  const end = html.indexOf(terminator, start);
  if (end === -1) return null;
  return html.slice(start, end);
}

// ---- Summary block parsing ----

function parseSummaryBlock(html: string): ParsedSummary {
  // The summary block is the first <p>...</p> inside <main>.
  // It contains "Seas:", "Peak Period:", "Water Temp:" labels.
  // We anchor on "Seas:" to be robust against the varying station-name
  // paragraph that precedes it.
  const block = extractBlock(html, "Seas:", "</p>");
  if (!block) return {};

  // Pull GMT timestamp from the same <p> block — but the timestamp lines
  // come BEFORE "Seas:", so we need a wider extract for that. We grab
  // back to the most recent "<p>" before "Seas:".
  const pStart = html.lastIndexOf("<p>", html.indexOf("Seas:"));
  const pBlock = pStart !== -1
    ? html.slice(pStart, html.indexOf("</p>", pStart))
    : block;

  const observedAt = parseGmtTimestamp(pBlock);
  const seasFt = parseLabeledNumber(block, /Seas:\s*([0-9.]+)\s*ft/);
  const peakPeriodS = parseLabeledNumber(block, /Peak Period:\s*([0-9.]+)\s*sec/);
  const waterTempF = parseLabeledNumber(block, /Water Temp:\s*([0-9.]+)\s*&#176;F/);

  return { observedAt, seasFt, peakPeriodS, waterTempF };
}

// ---- Wave Summary block parsing ----

function parseWaveSummaryBlock(html: string): ParsedWaveSummary {
  const start = html.indexOf("Wave Summary");
  if (start === -1) return {};
  const end = html.indexOf("</p>", start);
  if (end === -1) return {};
  const block = html.slice(start, end);

  // Inside this block: Swell appears first, then Wind Wave. Each component
  // has its own height, period, and direction. The labels "Period:" and
  // "Direction:" appear twice — we partition the block at "Wind Wave:".
  const windWaveStart = block.indexOf("Wind Wave:");
  const swellSection = windWaveStart !== -1 ? block.slice(0, windWaveStart) : block;
  const windWaveSection = windWaveStart !== -1 ? block.slice(windWaveStart) : "";

  const swell = parseComponent(swellSection, /Swell:\s*([0-9.]+)\s*ft/);
  const windWave = parseComponent(windWaveSection, /Wind Wave:\s*([0-9.]+)\s*ft/);

  return { swell, windWave };
}

function parseComponent(
  section: string,
  heightRegex: RegExp,
): WaveComponent | undefined {
  const heightFt = parseLabeledNumber(section, heightRegex);
  const periodS = parseLabeledNumber(section, /Period:\s*([0-9.]+)\s*sec/);
  const directionCardinal = parseLabeledString(section, /Direction:\s*([A-Z]{1,3})\b/);

  if (
    heightFt === undefined &&
    periodS === undefined &&
    directionCardinal === undefined
  ) {
    return undefined;
  }

  const directionDeg =
    directionCardinal !== undefined
      ? cardinalToDegrees(directionCardinal)
      : undefined;

  return {
    height_ft: heightFt,
    period_s: periodS,
    direction_deg: directionDeg,
    direction_cardinal: directionCardinal,
  };
}

// ---- Field-level parsing helpers ----

function parseLabeledNumber(text: string, regex: RegExp): number | undefined {
  const m = text.match(regex);
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  return Number.isNaN(n) ? undefined : n;
}

function parseLabeledString(text: string, regex: RegExp): string | undefined {
  const m = text.match(regex);
  return m ? m[1] : undefined;
}

// ---- GMT timestamp parsing ----
//
// Input format: "2026 GMT 04/26/2026"
//   - First token: HHMM as 4-digit UTC time (so "2026" means 20:26 UTC)
//   - Last token: MM/DD/YYYY date
//
// We're explicit about this because the time-string and the year happen to
// look identical for the next ~75 years.

const GMT_TIMESTAMP_REGEX = /(\d{4})\s+GMT\s+(\d{2})\/(\d{2})\/(\d{4})/;

function parseGmtTimestamp(text: string): string | undefined {
  const m = text.match(GMT_TIMESTAMP_REGEX);
  if (!m) return undefined;

  const hhmm = m[1];
  const month = m[2];
  const day = m[3];
  const year = m[4];

  const hours = hhmm.slice(0, 2);
  const minutes = hhmm.slice(2, 4);

  // Construct ISO 8601 UTC string.
  const iso = `${year}-${month}-${day}T${hours}:${minutes}:00Z`;

  // Validate by round-tripping through Date.
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;

  return iso;
}

// ---- Cardinal-to-degrees conversion ----
//
// 16-point compass. Each cardinal occupies a 22.5° band centered on its
// canonical heading. We return the canonical heading as the degree value.
// The original cardinal string is preserved separately to signal that the
// underlying precision is ~22.5°, not exact.

const CARDINAL_TO_DEGREES: Record<string, number> = {
  N: 0,
  NNE: 22.5,
  NE: 45,
  ENE: 67.5,
  E: 90,
  ESE: 112.5,
  SE: 135,
  SSE: 157.5,
  S: 180,
  SSW: 202.5,
  SW: 225,
  WSW: 247.5,
  W: 270,
  WNW: 292.5,
  NW: 315,
  NNW: 337.5,
};

function cardinalToDegrees(cardinal: string): number | undefined {
  return CARDINAL_TO_DEGREES[cardinal.toUpperCase()];
}

// ---- Composition ----

function composeObservation(args: {
  summary: ParsedSummary;
  waveSummary: ParsedWaveSummary;
  fetchedAt: string;
}): Observation | null {
  const { summary, waveSummary, fetchedAt } = args;

  // observedAt comes from the summary block's GMT timestamp. The Wave Summary
  // block has its own timestamp but in practice it's the same reading time.
  const observedAt = summary.observedAt ?? fetchedAt;

  const hasAnyData =
    summary.seasFt !== undefined ||
    summary.peakPeriodS !== undefined ||
    summary.waterTempF !== undefined ||
    waveSummary.swell !== undefined ||
    waveSummary.windWave !== undefined;

  if (!hasAnyData) {
    return null;
  }

  const ageSeconds = Math.max(
    0,
    Math.round((Date.parse(fetchedAt) - Date.parse(observedAt)) / 1000),
  );

  const freshness = freshnessFromAge(ageSeconds);

  // Build waves block. The widget exposes:
  //   - aggregate height (Seas) and period (Peak Period)
  //   - decomposed swell and wind_wave components
  //   - NO aggregate direction (only per-component direction)
  const wavesHasAggregate =
    summary.seasFt !== undefined || summary.peakPeriodS !== undefined;
  const wavesHasComponents =
    waveSummary.swell !== undefined || waveSummary.windWave !== undefined;

  const waves =
    wavesHasAggregate || wavesHasComponents
      ? {
          significant_height_ft: summary.seasFt,
          dominant_period_s: summary.peakPeriodS,
          // average_period_s and mean_wave_direction_deg intentionally
          // undefined — the widget doesn't expose them.
          swell: waveSummary.swell,
          wind_wave: waveSummary.windWave,
        }
      : undefined;

  const water =
    summary.waterTempF !== undefined
      ? { temperature_f: summary.waterTempF }
      : undefined;

  // Compute missing_fields and data_quality.
  // Expected fields for an NDBC-via-widget buoy: Hs, peak period, water temp,
  // and at least one decomposed component. The widget never gives aggregate
  // direction, so its absence does NOT count as missing.
  const missingFields: string[] = [];
  if (summary.seasFt === undefined) missingFields.push("waves.significant_height_ft");
  if (summary.peakPeriodS === undefined) missingFields.push("waves.dominant_period_s");
  if (summary.waterTempF === undefined) missingFields.push("water.temperature_f");
  if (waveSummary.swell === undefined && waveSummary.windWave === undefined) {
    missingFields.push("waves.components");
  }

  const dataQuality =
    missingFields.length === 0
      ? "complete"
      : summary.seasFt !== undefined
        ? "partial"
        : "degraded";

  return {
    observed_at: observedAt,
    age_seconds: ageSeconds,
    freshness,
    data_quality: dataQuality,
    missing_fields: missingFields,
    waves,
    water,
    // wind and atmosphere intentionally absent — widget doesn't supply them
    // for SoCal nearshore stations.
  };
}

function freshnessFromAge(ageSeconds: number): Observation["freshness"] {
  const hours = ageSeconds / 3600;
  if (hours < 3) return "current";
  if (hours < 6) return "stale";
  if (hours < 24) return "gap";
  return "offline";
}

// Helpers exported for tests / debugging.
export const _internal = {
  parseSummaryBlock,
  parseWaveSummaryBlock,
  parseComponent,
  parseGmtTimestamp,
  cardinalToDegrees,
  freshnessFromAge,
  composeObservation,
};
