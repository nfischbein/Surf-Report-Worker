// src/fetchers/buoypro.ts
//
// BuoyPro upstream fetcher.
//
// BuoyPro is a third-party aggregator that pulls from NDBC and renders
// per-station pages with both visible cards (current values) and embedded
// JSON time-series (used to drive Chart.js charts on the page).
//
// Strategy: prefer JSON, fall back to cards.
//
// JSON path:
//   - Each Chart.js series is rendered into the HTML as
//     `{ label: 'Wave Height (ft)', data: [{"x":"...","y":3.61}, ...], ... }`
//   - Series labels we care about: 'Water Temperature (F)', 'Wave Height (ft)',
//     'Dominant Period (sec)', 'Average Period (sec)'
//   - For each series we want, take the LAST entry's x (timestamp) and y (value).
//   - The most recent timestamp across all present series becomes observed_at.
//
// Cards path (fallback for fields that are card-only, and full fallback if
// the JSON pattern can't be found):
//   - Each card is structured: <span class="card-subtitle ...">LABEL</span>
//     followed by <h3 class="card-title">VALUE...</h3>
//   - Labels of interest: 'Water Temperature', 'Wave Height',
//     'Average Wave Period', 'Dominant Wave Period', 'Mean Wave Direction'
//   - Mean Wave Direction is card-only (not in the JSON time-series).
//
// Stations vary in sensor coverage. 46221 has 4 wave/temp series; 46222 has
// only 3. The parser must not assume any series is present.

import type { Observation, UpstreamFetcher, WarningCode } from "../schema";

const BUOYPRO_USER_AGENT =
  "Mozilla/5.0 (compatible; SurfReportBuilderBot/1.0; +https://github.com/nfischbein/Surf-Report-Worker)";

interface SeriesPoint {
  x: string; // ISO timestamp
  y: number;
}

interface ParsedJsonSeries {
  waveHeightFt?: SeriesPoint;
  dominantPeriodS?: SeriesPoint;
  averagePeriodS?: SeriesPoint;
  waterTemperatureF?: SeriesPoint;
}

interface ParsedCards {
  waveHeightFt?: number;
  dominantPeriodS?: number;
  averagePeriodS?: number;
  waterTemperatureF?: number;
  meanWaveDirectionDeg?: number;
}

export const buoyProFetcher: UpstreamFetcher = {
  source: "buoypro",
  async fetch(stationId: string) {
    const url = `https://www.buoypro.com/stations/${stationId}`;
    const fetchedAt = new Date().toISOString();

    const response = await fetch(url, {
      headers: { "user-agent": BUOYPRO_USER_AGENT },
      // Cloudflare's fetch obeys redirects by default; that's correct here.
    });

    if (!response.ok) {
      // Non-2xx — let the orchestrator try the next fetcher.
      return null;
    }

    const html = await response.text();

    // Sanity check: does this page actually look like a BuoyPro station page?
    // Bad station IDs may return a generic page rather than 404.
    if (!html.includes("Buoy Weather") || !html.includes(stationId)) {
      return null;
    }

    const json = parseJsonSeries(html);
    const cards = parseCards(html);

    // Determine the observation timestamp from the most recent JSON point.
    // If no JSON series at all, we have no embedded timestamp — fall back to
    // the page fetch time (less accurate but better than nothing).
    const observedAt = mostRecentTimestamp(json) ?? fetchedAt;

    // Compose the observation. Prefer JSON values; fall back to card values
    // for any field that JSON didn't supply. Mean wave direction is always
    // from cards (not in JSON).
    const observation = composeObservation({
      observedAt,
      fetchedAt,
      json,
      cards,
    });

    if (!observation) {
      // Neither JSON nor cards yielded usable data.
      return null;
    }

    return {
      observation,
      url,
      fetched_at: fetchedAt,
    };
  },
};

// ---- JSON parsing ----

// Match Chart.js series declarations of the form:
//   { label: 'Wave Height (ft)', data: [...] , borderColor: ... }
// We capture the label and the data array as a string, then JSON.parse the
// data array separately.
//
// The HTML escapes nothing inside these arrays (they're real JSON), but we
// match non-greedily and stop at the first `]` to avoid eating across series.
const SERIES_REGEX =
  /\{\s*label:\s*'([^']+)',\s*data:\s*(\[[^\]]*\])/g;

const SERIES_LABEL_MAP: Record<string, keyof ParsedJsonSeries> = {
  "Wave Height (ft)": "waveHeightFt",
  "Dominant Period (sec)": "dominantPeriodS",
  "Average Period (sec)": "averagePeriodS",
  "Water Temperature (F)": "waterTemperatureF",
};

function parseJsonSeries(html: string): ParsedJsonSeries {
  const result: ParsedJsonSeries = {};
  let match: RegExpExecArray | null;

  // Reset regex state since it has the global flag.
  SERIES_REGEX.lastIndex = 0;

  while ((match = SERIES_REGEX.exec(html)) !== null) {
    const label = match[1];
    const dataStr = match[2];
    const targetField = SERIES_LABEL_MAP[label];
    if (!targetField) continue;

    let points: SeriesPoint[];
    try {
      points = JSON.parse(dataStr) as SeriesPoint[];
    } catch {
      continue; // malformed series, skip
    }

    if (!Array.isArray(points) || points.length === 0) continue;

    const last = points[points.length - 1];
    if (
      last &&
      typeof last.x === "string" &&
      typeof last.y === "number" &&
      !Number.isNaN(last.y)
    ) {
      result[targetField] = last;
    }
  }

  return result;
}

function mostRecentTimestamp(json: ParsedJsonSeries): string | null {
  const stamps = [
    json.waveHeightFt?.x,
    json.dominantPeriodS?.x,
    json.averagePeriodS?.x,
    json.waterTemperatureF?.x,
  ].filter((s): s is string => typeof s === "string");

  if (stamps.length === 0) return null;

  // Lexicographic comparison works for ISO 8601 timestamps with consistent format.
  return stamps.reduce((latest, current) => (current > latest ? current : latest));
}

// ---- Card parsing ----

// Match a card: subtitle (label) followed by card-title (value).
// We do this in two passes — find labels, then for each label find the
// immediately-following <h3 class="card-title"> block — to avoid greedy
// regex pitfalls with HTML.
//
// Subtitle format:
//   <span class="card-subtitle mb-2 text-muted">[possibly an <i> icon] LABEL</span>
const SUBTITLE_REGEX =
  /<span class="card-subtitle[^"]*"[^>]*>(?:\s*<i[^>]*><\/i>)?\s*([^<]+?)\s*<\/span>\s*<h3 class="card-title">([\s\S]*?)<\/h3>/g;

const CARD_LABEL_MAP: Record<string, keyof ParsedCards> = {
  "Water Temperature": "waterTemperatureF",
  "Wave Height": "waveHeightFt",
  "Average Wave Period": "averagePeriodS",
  "Dominant Wave Period": "dominantPeriodS",
  "Mean Wave Direction": "meanWaveDirectionDeg",
};

function parseCards(html: string): ParsedCards {
  const result: ParsedCards = {};
  let match: RegExpExecArray | null;

  SUBTITLE_REGEX.lastIndex = 0;

  while ((match = SUBTITLE_REGEX.exec(html)) !== null) {
    const label = match[1].trim();
    const valueHtml = match[2];
    const field = CARD_LABEL_MAP[label];
    if (!field) continue;

    const numericValue = extractFirstNumber(valueHtml);
    if (numericValue !== null) {
      result[field] = numericValue;
    }
  }

  return result;
}

// Extract the first decimal number from an HTML fragment.
// Card values look like:
//   "62 <text>&deg;</text> <small ...>F</small>"
//   "3.6 <small ...>ft</small>"
//   "<i class='wi wi-wind from-275-deg'></i> 275<text>&deg;</text>"
// In the last case the icon class also contains "275" — but the icon comes
// before the visible text, and the visible "275" is what we want anyway.
// Either copy is fine. To be safe we strip <i> tags before scanning.
function extractFirstNumber(htmlFragment: string): number | null {
  const stripped = htmlFragment.replace(/<i\b[^>]*>.*?<\/i>/g, "");
  const match = stripped.match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const n = parseFloat(match[0]);
  return Number.isNaN(n) ? null : n;
}

// ---- Composition ----

function composeObservation(args: {
  observedAt: string;
  fetchedAt: string;
  json: ParsedJsonSeries;
  cards: ParsedCards;
}): Observation | null {
  const { observedAt, fetchedAt, json, cards } = args;

  // Prefer JSON values; fall back to cards for fields JSON didn't supply.
  const waveHeightFt = json.waveHeightFt?.y ?? cards.waveHeightFt;
  const dominantPeriodS = json.dominantPeriodS?.y ?? cards.dominantPeriodS;
  const averagePeriodS = json.averagePeriodS?.y ?? cards.averagePeriodS;
  const waterTemperatureF = json.waterTemperatureF?.y ?? cards.waterTemperatureF;
  const meanWaveDirectionDeg = cards.meanWaveDirectionDeg; // card-only

  // If we got nothing, fail.
  if (
    waveHeightFt === undefined &&
    dominantPeriodS === undefined &&
    averagePeriodS === undefined &&
    waterTemperatureF === undefined &&
    meanWaveDirectionDeg === undefined
  ) {
    return null;
  }

  const ageSeconds = Math.max(
    0,
    Math.round(
      (Date.parse(fetchedAt) - Date.parse(observedAt)) / 1000
    )
  );

  const freshness = freshnessFromAge(ageSeconds);

  const waves =
    waveHeightFt !== undefined ||
    dominantPeriodS !== undefined ||
    averagePeriodS !== undefined ||
    meanWaveDirectionDeg !== undefined
      ? {
          significant_height_ft: waveHeightFt,
          dominant_period_s: dominantPeriodS,
          average_period_s: averagePeriodS,
          mean_wave_direction_deg: meanWaveDirectionDeg,
        }
      : undefined;

  const water =
    waterTemperatureF !== undefined
      ? { temperature_f: waterTemperatureF }
      : undefined;

  // Compute missing_fields / data_quality.
  // Expected fields for an NDBC-via-BuoyPro buoy: waves (height + at least one
  // period + direction), water temp. Wind/atmosphere are not expected from
  // BuoyPro — their absence does NOT count as missing.
  const missingFields: string[] = [];
  if (waveHeightFt === undefined) missingFields.push("waves.significant_height_ft");
  if (dominantPeriodS === undefined && averagePeriodS === undefined) {
    missingFields.push("waves.period");
  }
  if (meanWaveDirectionDeg === undefined) missingFields.push("waves.mean_wave_direction_deg");
  if (waterTemperatureF === undefined) missingFields.push("water.temperature_f");

  const dataQuality =
    missingFields.length === 0
      ? "complete"
      : waveHeightFt !== undefined
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
    // wind and atmosphere intentionally absent — BuoyPro doesn't supply them
    // for SoCal nearshore stations. Other station types/fetchers will fill these.
  };
}

function freshnessFromAge(ageSeconds: number): Observation["freshness"] {
  const hours = ageSeconds / 3600;
  if (hours < 3) return "current";
  if (hours < 6) return "stale";
  if (hours < 24) return "gap";
  return "offline";
}

// Helper exported for tests / debugging — not part of the fetcher's runtime path.
export const _internal = {
  parseJsonSeries,
  parseCards,
  mostRecentTimestamp,
  freshnessFromAge,
  composeObservation,
};