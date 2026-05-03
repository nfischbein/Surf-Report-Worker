// src/fetchers/ndbcRealtime2.ts
//
// NDBC realtime2 upstream fetcher. NOAA's canonical published data feed.
//
// Two endpoints, fetched in parallel:
//
//   1. https://www.ndbc.noaa.gov/data/realtime2/<NDBC_ID>.txt
//      Standard meteorological observation. 19 fixed-width columns:
//        YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE
//      First two rows are `#`-prefixed headers (column names + units).
//      Subsequent rows are observations in REVERSE-CHRONOLOGICAL order
//      (most-recent first). `MM` is the missing-data sentinel.
//
//   2. https://www.ndbc.noaa.gov/data/realtime2/<NDBC_ID>.spec
//      Spectral wave decomposition. 15 fixed-width columns:
//        YY MM DD hh mm WVHT SwH SwP WWH WWP SwD WWD STEEPNESS APD MWD
//      Same `#`-header / reverse-chronological / `MM` conventions.
//      SwD and WWD are 16-point compass cardinals (e.g. "SW", "WNW")
//      despite the header line claiming WWD is degT. Real data wins.
//
// Why both? Stations vary in sensor coverage:
//   - Some stations only have wave sensors and no wind/atm sensors
//     (e.g. SoCal nearshore 46221/46222) — these have full .txt but
//     wind/atm columns are MM.
//   - Some stations have decomposed wave processing (.spec exists)
//     while others don't (only .txt available).
// The fetcher succeeds whenever at least one of the two feeds returns
// usable data, and merges what's available into a single observation.
//
// Per-field freshness model:
//   Within a feed, rows have different fields populated at different
//   cadences. NDBC reports DPD/APD/MWD on a slower cadence than WVHT.
//   Naively picking the latest row would treat a recently-arrived
//   WVHT-only row as "the" observation and drop period/direction.
//   Instead we walk rows from newest to oldest, taking the first
//   non-MM value per field. observed_at is the MAX timestamp across
//   the rows whose values were used. This mirrors how the BuoyPro
//   fetcher handles its per-field JSON time series.

import type {
  Observation,
  UpstreamFetcher,
  WaveComponent,
} from "../schema";

const NDBC_REALTIME2_USER_AGENT =
  "Surf-Report-Worker/0.1 (+https://github.com/nfischbein/Surf-Report-Worker)";

// Column index lookups derived from the documented header rows.
// We hard-code positions because the formats are stable and the
// alternative (parsing the header for column names) is more code with
// no realistic gain — NDBC has not changed these layouts in years.
const TXT_COL = {
  WDIR: 5,
  WSPD: 6,
  GST: 7,
  WVHT: 8,
  DPD: 9,
  APD: 10,
  MWD: 11,
  PRES: 12,
  ATMP: 13,
  WTMP: 14,
} as const;

const SPEC_COL = {
  WVHT: 5,
  SwH: 6,
  SwP: 7,
  WWH: 8,
  WWP: 9,
  SwD: 10,
  WWD: 11,
  STEEPNESS: 12,
  APD: 13,
  MWD: 14,
} as const;

const TXT_MIN_TOKENS = 19;
const SPEC_MIN_TOKENS = 15;

// Unit conversions
const M_TO_FT = 3.28084;
const MS_TO_KT = 1.94384;

// ---- Public fetcher ----

export const ndbcRealtime2Fetcher: UpstreamFetcher = {
  source: "ndbc_realtime2",
  async fetch(stationId: string) {
    const txtUrl = `https://www.ndbc.noaa.gov/data/realtime2/${stationId}.txt`;
    const specUrl = `https://www.ndbc.noaa.gov/data/realtime2/${stationId}.spec`;
    const fetchedAt = new Date().toISOString();

    const [txtParsed, specParsed] = await Promise.all([
      fetchAndParseTxt(txtUrl),
      fetchAndParseSpec(specUrl),
    ]);

    if (txtParsed === null && specParsed === null) {
      return null;
    }

    const observation = composeObservation({
      txt: txtParsed,
      spec: specParsed,
      fetchedAt,
    });

    if (observation === null) {
      return null;
    }

    // Prefer the .txt URL as the recorded upstream URL when available —
    // it's the canonical "standard met" feed that carries the bulk of the
    // observation. Falls back to .spec URL when only .spec succeeded.
    const recordedUrl = txtParsed !== null ? txtUrl : specUrl;

    return {
      observation,
      url: recordedUrl,
      fetched_at: fetchedAt,
    };
  },
};

// ---- Parsed feed shapes ----
//
// Each parsed feed exposes "the most recent non-MM value per field"
// alongside the timestamp of the row that contributed each value.
// The composer takes the max timestamp across used values as observed_at.

interface TxtFieldValue<T> {
  value: T;
  timestamp: string; // ISO 8601 UTC
}

interface ParsedTxt {
  windSpeedKt?: TxtFieldValue<number>;
  windGustKt?: TxtFieldValue<number>;
  windDirectionDeg?: TxtFieldValue<number>;
  significantHeightFt?: TxtFieldValue<number>;
  dominantPeriodS?: TxtFieldValue<number>;
  averagePeriodS?: TxtFieldValue<number>;
  meanWaveDirectionDeg?: TxtFieldValue<number>;
  pressureMb?: TxtFieldValue<number>;
  airTemperatureF?: TxtFieldValue<number>;
  waterTemperatureF?: TxtFieldValue<number>;
}

interface ParsedSpec {
  significantHeightFt?: TxtFieldValue<number>;
  averagePeriodS?: TxtFieldValue<number>;
  meanWaveDirectionDeg?: TxtFieldValue<number>;
  swell?: TxtFieldValue<WaveComponent>;
  windWave?: TxtFieldValue<WaveComponent>;
}

// ---- .txt parser ----

async function fetchAndParseTxt(url: string): Promise<ParsedTxt | null> {
  const response = await fetch(url, {
    headers: { "user-agent": NDBC_REALTIME2_USER_AGENT },
  });
  if (!response.ok) return null;

  const body = await response.text();
  const dataRows = extractDataRows(body, TXT_MIN_TOKENS);
  if (dataRows.length === 0) return null;

  const result: ParsedTxt = {};

  for (const { tokens, timestamp } of dataRows) {
    if (timestamp === null) continue;

    // Wind direction (degT) — int 0-360, 0 means due-true-north.
    if (result.windDirectionDeg === undefined) {
      const wdir = parseIntSentinel(tokens[TXT_COL.WDIR]);
      if (wdir !== null && wdir >= 0 && wdir <= 360) {
        result.windDirectionDeg = { value: wdir % 360, timestamp };
      }
    }

    // Wind speed (m/s → kt)
    if (result.windSpeedKt === undefined) {
      const wspd = parseFloatSentinel(tokens[TXT_COL.WSPD]);
      if (wspd !== null && wspd >= 0) {
        result.windSpeedKt = {
          value: round1(wspd * MS_TO_KT),
          timestamp,
        };
      }
    }

    // Gust (m/s → kt)
    if (result.windGustKt === undefined) {
      const gst = parseFloatSentinel(tokens[TXT_COL.GST]);
      if (gst !== null && gst >= 0) {
        result.windGustKt = {
          value: round1(gst * MS_TO_KT),
          timestamp,
        };
      }
    }

    // Significant wave height (m → ft)
    if (result.significantHeightFt === undefined) {
      const wvht = parseFloatSentinel(tokens[TXT_COL.WVHT]);
      if (wvht !== null && wvht >= 0) {
        result.significantHeightFt = {
          value: round1(wvht * M_TO_FT),
          timestamp,
        };
      }
    }

    // Dominant period (sec) — often integer-valued in .txt
    if (result.dominantPeriodS === undefined) {
      const dpd = parseFloatSentinel(tokens[TXT_COL.DPD]);
      if (dpd !== null && dpd > 0) {
        result.dominantPeriodS = { value: dpd, timestamp };
      }
    }

    // Average period (sec)
    if (result.averagePeriodS === undefined) {
      const apd = parseFloatSentinel(tokens[TXT_COL.APD]);
      if (apd !== null && apd > 0) {
        result.averagePeriodS = { value: apd, timestamp };
      }
    }

    // Mean wave direction (degT)
    if (result.meanWaveDirectionDeg === undefined) {
      const mwd = parseIntSentinel(tokens[TXT_COL.MWD]);
      if (mwd !== null && mwd >= 0 && mwd <= 360) {
        result.meanWaveDirectionDeg = {
          value: mwd % 360,
          timestamp,
        };
      }
    }

    // Pressure (hPa = mb)
    if (result.pressureMb === undefined) {
      const pres = parseFloatSentinel(tokens[TXT_COL.PRES]);
      if (pres !== null && pres > 0) {
        result.pressureMb = { value: pres, timestamp };
      }
    }

    // Air temp (°C → °F)
    if (result.airTemperatureF === undefined) {
      const atmp = parseFloatSentinel(tokens[TXT_COL.ATMP]);
      if (atmp !== null) {
        result.airTemperatureF = {
          value: round1(atmp * 9 / 5 + 32),
          timestamp,
        };
      }
    }

    // Water temp (°C → °F)
    if (result.waterTemperatureF === undefined) {
      const wtmp = parseFloatSentinel(tokens[TXT_COL.WTMP]);
      if (wtmp !== null) {
        result.waterTemperatureF = {
          value: round1(wtmp * 9 / 5 + 32),
          timestamp,
        };
      }
    }

    // Early exit if every field has been resolved.
    if (allFieldsResolved(result)) break;
  }

  // Did we get anything? If not, treat as failure so orchestrator falls through.
  if (
    result.windSpeedKt === undefined &&
    result.significantHeightFt === undefined &&
    result.waterTemperatureF === undefined &&
    result.pressureMb === undefined
  ) {
    return null;
  }

  return result;
}

function allFieldsResolved(p: ParsedTxt): boolean {
  return (
    p.windSpeedKt !== undefined &&
    p.windGustKt !== undefined &&
    p.windDirectionDeg !== undefined &&
    p.significantHeightFt !== undefined &&
    p.dominantPeriodS !== undefined &&
    p.averagePeriodS !== undefined &&
    p.meanWaveDirectionDeg !== undefined &&
    p.pressureMb !== undefined &&
    p.airTemperatureF !== undefined &&
    p.waterTemperatureF !== undefined
  );
}

// ---- .spec parser ----

async function fetchAndParseSpec(url: string): Promise<ParsedSpec | null> {
  const response = await fetch(url, {
    headers: { "user-agent": NDBC_REALTIME2_USER_AGENT },
  });
  if (!response.ok) return null;

  const body = await response.text();
  const dataRows = extractDataRows(body, SPEC_MIN_TOKENS);
  if (dataRows.length === 0) return null;

  const result: ParsedSpec = {};

  for (const { tokens, timestamp } of dataRows) {
    if (timestamp === null) continue;

    // Aggregate WVHT (m → ft) — duplicated across .txt and .spec; either's fine.
    if (result.significantHeightFt === undefined) {
      const wvht = parseFloatSentinel(tokens[SPEC_COL.WVHT]);
      if (wvht !== null && wvht >= 0) {
        result.significantHeightFt = {
          value: round1(wvht * M_TO_FT),
          timestamp,
        };
      }
    }

    // Average period (sec)
    if (result.averagePeriodS === undefined) {
      const apd = parseFloatSentinel(tokens[SPEC_COL.APD]);
      if (apd !== null && apd > 0) {
        result.averagePeriodS = { value: apd, timestamp };
      }
    }

    // Mean wave direction (degT)
    if (result.meanWaveDirectionDeg === undefined) {
      const mwd = parseIntSentinel(tokens[SPEC_COL.MWD]);
      if (mwd !== null && mwd >= 0 && mwd <= 360) {
        result.meanWaveDirectionDeg = {
          value: mwd % 360,
          timestamp,
        };
      }
    }

    // Swell component
    if (result.swell === undefined) {
      const swH = parseFloatSentinel(tokens[SPEC_COL.SwH]);
      const swP = parseFloatSentinel(tokens[SPEC_COL.SwP]);
      const swDCardinal = parseStringSentinel(tokens[SPEC_COL.SwD]);
      // Treat 0.0 height as "no swell component for this row" (genuine
      // condition, not missing data) — but only if period is also unset.
      // If we have a real height OR a real period OR a real direction,
      // record what we have.
      if (
        (swH !== null && swH > 0) ||
        (swP !== null && swP > 0) ||
        swDCardinal !== null
      ) {
        const swell: WaveComponent = {};
        if (swH !== null && swH >= 0) swell.height_ft = round1(swH * M_TO_FT);
        if (swP !== null && swP > 0) swell.period_s = swP;
        if (swDCardinal !== null) {
          const swDDeg = cardinalToDegrees(swDCardinal);
          if (swDDeg !== undefined) swell.direction_deg = swDDeg;
          swell.direction_cardinal = swDCardinal;
        }
        result.swell = { value: swell, timestamp };
      }
    }

    // Wind-wave component
    if (result.windWave === undefined) {
      const wwH = parseFloatSentinel(tokens[SPEC_COL.WWH]);
      const wwP = parseFloatSentinel(tokens[SPEC_COL.WWP]);
      const wwDCardinal = parseStringSentinel(tokens[SPEC_COL.WWD]);
      if (
        (wwH !== null && wwH > 0) ||
        (wwP !== null && wwP > 0) ||
        wwDCardinal !== null
      ) {
        const windWave: WaveComponent = {};
        if (wwH !== null && wwH >= 0) windWave.height_ft = round1(wwH * M_TO_FT);
        if (wwP !== null && wwP > 0) windWave.period_s = wwP;
        if (wwDCardinal !== null) {
          const wwDDeg = cardinalToDegrees(wwDCardinal);
          if (wwDDeg !== undefined) windWave.direction_deg = wwDDeg;
          windWave.direction_cardinal = wwDCardinal;
        }
        result.windWave = { value: windWave, timestamp };
      }
    }

    if (
      result.significantHeightFt !== undefined &&
      result.averagePeriodS !== undefined &&
      result.meanWaveDirectionDeg !== undefined &&
      result.swell !== undefined &&
      result.windWave !== undefined
    ) break;
  }

  if (
    result.significantHeightFt === undefined &&
    result.swell === undefined &&
    result.windWave === undefined
  ) {
    return null;
  }

  return result;
}

// ---- Shared row extraction ----

interface DataRow {
  tokens: string[];
  timestamp: string | null;
}

/**
 * Splits the realtime2 body into tokenized data rows. Strips `#`-prefixed
 * header rows and any rows with too few tokens to be valid observations.
 * Each row is returned with its parsed UTC timestamp (or null if the
 * timestamp itself was malformed).
 */
function extractDataRows(body: string, minTokens: number): DataRow[] {
  const lines = body.split(/\r?\n/);
  const result: DataRow[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const tokens = trimmed.split(/\s+/);
    if (tokens.length < minTokens) continue;

    const timestamp = parseRealtime2Timestamp(tokens);
    result.push({ tokens, timestamp });
  }

  return result;
}

/**
 * Parses the leading `YYYY MM DD hh mm` columns into an ISO 8601 UTC string.
 * Returns null if any component is malformed.
 */
function parseRealtime2Timestamp(tokens: string[]): string | null {
  if (tokens.length < 5) return null;
  const [yyyy, mm, dd, hh, mi] = tokens;
  // Quick sanity check on lengths.
  if (yyyy.length !== 4 || mm.length !== 2 || dd.length !== 2) return null;
  const iso = `${yyyy}-${mm}-${dd}T${hh.padStart(2, "0")}:${mi.padStart(2, "0")}:00Z`;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return iso;
}

// ---- Sentinel-aware token parsing ----

function parseFloatSentinel(token: string | undefined): number | null {
  if (token === undefined || token === "MM") return null;
  const n = parseFloat(token);
  return Number.isFinite(n) ? n : null;
}

function parseIntSentinel(token: string | undefined): number | null {
  if (token === undefined || token === "MM") return null;
  const n = parseInt(token, 10);
  return Number.isFinite(n) ? n : null;
}

function parseStringSentinel(token: string | undefined): string | null {
  if (token === undefined || token === "MM" || token === "") return null;
  return token;
}

// ---- 16-point compass → degrees ----
//
// Duplicated from ndbcWidget.ts intentionally. Both fetchers carry their
// own copy so changes to one don't silently affect the other; if a third
// fetcher needs this in the future, factoring it into a shared utility
// becomes worth doing.

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
  txt: ParsedTxt | null;
  spec: ParsedSpec | null;
  fetchedAt: string;
}): Observation | null {
  const { txt, spec, fetchedAt } = args;

  // Collect the timestamps actually used so observed_at reflects the
  // newest value contributing to the observation, not just the newest
  // row in either feed.
  const usedTimestamps: string[] = [];
  const collect = <T>(field: TxtFieldValue<T> | undefined): T | undefined => {
    if (field === undefined) return undefined;
    usedTimestamps.push(field.timestamp);
    return field.value;
  };

  // Wave aggregates — prefer .txt when available, fall back to .spec.
  const significantHeightFt =
    collect(txt?.significantHeightFt) ?? collect(spec?.significantHeightFt);
  const dominantPeriodS = collect(txt?.dominantPeriodS);
  const averagePeriodS =
    collect(txt?.averagePeriodS) ?? collect(spec?.averagePeriodS);
  const meanWaveDirectionDeg =
    collect(txt?.meanWaveDirectionDeg) ?? collect(spec?.meanWaveDirectionDeg);

  // Wave components — only from .spec.
  const swell = collect(spec?.swell);
  const windWave = collect(spec?.windWave);

  // Wind / atmosphere / water — only from .txt.
  const windSpeedKt = collect(txt?.windSpeedKt);
  const windGustKt = collect(txt?.windGustKt);
  const windDirectionDeg = collect(txt?.windDirectionDeg);
  const pressureMb = collect(txt?.pressureMb);
  const airTemperatureF = collect(txt?.airTemperatureF);
  const waterTemperatureF = collect(txt?.waterTemperatureF);

  if (usedTimestamps.length === 0) {
    return null;
  }

  // observed_at = max timestamp across contributing fields.
  const observedAt = usedTimestamps.reduce((max, t) => (t > max ? t : max));

  const ageSeconds = Math.max(
    0,
    Math.round((Date.parse(fetchedAt) - Date.parse(observedAt)) / 1000)
  );
  const freshness = freshnessFromAge(ageSeconds);

  // Build sub-blocks. A block is included only when at least one of its
  // fields has a value; otherwise it stays absent in the response.
  const wavesPresent =
    significantHeightFt !== undefined ||
    dominantPeriodS !== undefined ||
    averagePeriodS !== undefined ||
    meanWaveDirectionDeg !== undefined ||
    swell !== undefined ||
    windWave !== undefined;

  const waves = wavesPresent
    ? {
        significant_height_ft: significantHeightFt,
        dominant_period_s: dominantPeriodS,
        average_period_s: averagePeriodS,
        mean_wave_direction_deg: meanWaveDirectionDeg,
        swell,
        wind_wave: windWave,
      }
    : undefined;

  const windPresent =
    windSpeedKt !== undefined ||
    windGustKt !== undefined ||
    windDirectionDeg !== undefined;

  const wind = windPresent
    ? {
        speed_kt: windSpeedKt,
        gust_kt: windGustKt,
        direction_deg: windDirectionDeg,
      }
    : undefined;

  const water =
    waterTemperatureF !== undefined
      ? { temperature_f: waterTemperatureF }
      : undefined;

  const atmospherePresent =
    pressureMb !== undefined || airTemperatureF !== undefined;

  const atmosphere = atmospherePresent
    ? {
        pressure_mb: pressureMb,
        air_temperature_f: airTemperatureF,
      }
    : undefined;

  // missing_fields / data_quality.
  //
  // Realtime2 station coverage varies. We treat a field as "expected but
  // missing" only when both feeds had a chance to supply it and neither
  // did, AND its absence meaningfully degrades the observation.
  //
  // The following are always expected if either feed succeeded:
  //   - waves.significant_height_ft (Hs is the headline number)
  //
  // The following are expected when the relevant feed is present:
  //   - .spec present → waves.swell or waves.wind_wave
  //   - .txt present → at least one of waves.dominant_period_s /
  //     waves.average_period_s
  //
  // Wind/atmosphere/water are NOT counted as missing when absent, since
  // many stations don't carry those sensors. This matches how the
  // existing buoyPro and ndbcWidget fetchers handle the same fields.
  const missingFields: string[] = [];
  if (significantHeightFt === undefined) {
    missingFields.push("waves.significant_height_ft");
  }
  if (
    txt !== null &&
    dominantPeriodS === undefined &&
    averagePeriodS === undefined
  ) {
    missingFields.push("waves.period");
  }
  if (spec !== null && swell === undefined && windWave === undefined) {
    missingFields.push("waves.components");
  }

  const dataQuality =
    missingFields.length === 0
      ? "complete"
      : significantHeightFt !== undefined
        ? "partial"
        : "degraded";

  return {
    observed_at: observedAt,
    age_seconds: ageSeconds,
    freshness,
    data_quality: dataQuality,
    missing_fields: missingFields,
    waves,
    wind,
    water,
    atmosphere,
  };
}

// ---- Freshness ----
//
// Same thresholds as buoyProFetcher, ndbcWidgetFetcher, and the
// orchestrator's on-serve recompute. Duplicated locally rather than
// imported to keep this fetcher self-contained; if these thresholds ever
// change, all four call sites must change in lockstep.

function freshnessFromAge(ageSeconds: number): Observation["freshness"] {
  const hours = ageSeconds / 3600;
  if (hours < 3) return "current";
  if (hours < 6) return "stale";
  if (hours < 24) return "gap";
  return "offline";
}

// ---- Helpers ----

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

// Internals exported for tests / debugging.
export const _internal = {
  fetchAndParseTxt,
  fetchAndParseSpec,
  extractDataRows,
  parseRealtime2Timestamp,
  parseFloatSentinel,
  parseIntSentinel,
  parseStringSentinel,
  cardinalToDegrees,
  freshnessFromAge,
  composeObservation,
};
