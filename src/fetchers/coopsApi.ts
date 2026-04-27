// src/fetchers/coopsApi.ts
//
// CO-OPS API fetcher.
//
// Fetches NOAA CO-OPS Data API for tide stations. Returns a TideObservations
// block with three channels:
//   - water_level : real-time observed sensor reading
//   - predictions : harmonic forecast for the requested window, with hi/lo
//                   events derived from 6-min samples
//   - cross_check : observed-vs-predicted at the latest observation timestamp,
//                   surge_indicated set per RULE 5's 0.5 ft threshold
//
// Strategy:
//   1. Fetch water_level for "today" — gives us the latest sensor reading.
//   2. Fetch predictions in 6-min resolution for the requested window — gives
//      us both the cross_check predicted value (matched timestamp) AND the
//      hi/lo events derived from local maxima/minima in the 6-min series.
//   3. Both fetches in parallel — independent; failure of one doesn't block
//      the other. Channel-level failure is reported in the returned
//      TideObservations (the affected channel is null) rather than failing
//      the whole fetcher; callers can still use the surviving channel.
//
// All timestamps requested in GMT (time_zone=gmt) for deterministic ISO 8601
// output without DST edge cases.
//
// Verified against live data April 2026 — see Closeout 2 for upstream
// verification work. Hi/lo derivation handles plateau peaks (consecutive
// equal-height samples at extrema, common at smooth tidal turning points
// when CO-OPS quantizes to thousandths of a foot).

import type {
  UpstreamFetcher,
  FetchContext,
  TideObservations,
  WaterLevelChannel,
  PredictionsChannel,
  CrossCheck,
  TidePrediction,
  Freshness,
} from "../schema";

const COOPS_API_BASE =
  "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter";
const APPLICATION = "SurfReportBuilder";
const FETCH_USER_AGENT =
  "Mozilla/5.0 (compatible; SurfReportBuilderBot/1.0; +https://github.com/nfischbein/Surf-Report-Worker)";

// Internal-only — used for hi/lo derivation and cross_check matching.
// Not exposed in the response.
interface PredictionSample {
  time: string;       // ISO 8601 UTC
  height_ft: number;
}

const SURGE_THRESHOLD_FT = 0.5;

// =============================================================================
// URL builders
// =============================================================================

function todayDateGMT(): string {
  const now = new Date();
  return formatDateGMT(now);
}

function dateGMTPlusDays(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  return formatDateGMT(d);
}

function formatDateGMT(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${y}${m}${dd}`;
}

function buildWaterLevelUrl(stationId: string): string {
  const params = new URLSearchParams({
    date: "today",
    station: stationId,
    product: "water_level",
    datum: "MLLW",
    time_zone: "gmt",
    units: "english",
    application: APPLICATION,
    format: "xml",
  });
  return `${COOPS_API_BASE}?${params.toString()}`;
}

function buildPredictionsUrl(stationId: string, daysRequested: number): string {
  const begin = todayDateGMT();
  const end = dateGMTPlusDays(daysRequested - 1);
  const params = new URLSearchParams({
    begin_date: begin,
    end_date: end,
    station: stationId,
    product: "predictions",
    datum: "MLLW",
    time_zone: "gmt",
    units: "english",
    application: APPLICATION,
    format: "xml",
    // No interval param = 6-min resolution
  });
  return `${COOPS_API_BASE}?${params.toString()}`;
}

// =============================================================================
// XML parsing (lightweight regex — CO-OPS XML is flat self-closing tags only)
// =============================================================================

// Convert "2026-04-26 16:24" (GMT) to "2026-04-26T16:24:00Z"
function coopsTimeToISO(coopsTime: string): string {
  return coopsTime.trim().replace(" ", "T") + ":00Z";
}

// Decode CO-OPS f="a,b,c,d" flags. Position 0: max sensor exceeded;
// 1: min exceeded; 2: rate-of-change exceeded; 3: temperature out of range.
function decodeFlags(flagsAttr: string | undefined): string[] {
  if (!flagsAttr) return [];
  const parts = flagsAttr.split(",").map((s) => s.trim());
  const flags: string[] = [];
  if (parts[0] === "1") flags.push("max_exceeded");
  if (parts[1] === "1") flags.push("min_exceeded");
  if (parts[2] === "1") flags.push("rate_exceeded");
  if (parts[3] === "1") flags.push("temperature_exceeded");
  return flags;
}

function decodeQuality(
  q: string | undefined
): "preliminary" | "verified" | "rejected" {
  if (q === "v") return "verified";
  if (q === "r") return "rejected";
  return "preliminary"; // "p" or unknown — treat unknown as preliminary
}

// Generic attribute parser for self-closing XML tags like:
//   <wl t="2026-04-26 16:24" v="2.723" s="0.207" f="1,0,0,0" q="p" />
function parseAttrs(attrString: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /(\w+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(attrString)) !== null) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

interface ParsedWaterLevel {
  observations: Array<{
    time: string;
    height_ft: number | null;
    sigma_ft: number | null;
    flags: string[];
    quality: "preliminary" | "verified" | "rejected";
  }>;
  errorMessage: string | null;
}

function parseWaterLevelXml(xml: string): ParsedWaterLevel {
  const errMatch = xml.match(/<error[^>]*>([\s\S]*?)<\/error>/i);
  if (errMatch) {
    return { observations: [], errorMessage: errMatch[1].trim() };
  }

  const observations: ParsedWaterLevel["observations"] = [];
  const wlRegex = /<wl\s+([^/]+?)\/>/g;
  let match: RegExpExecArray | null;
  while ((match = wlRegex.exec(xml)) !== null) {
    const attrs = parseAttrs(match[1]);
    if (!attrs.t) continue;
    const heightStr = attrs.v;
    const sigmaStr = attrs.s;
    observations.push({
      time: coopsTimeToISO(attrs.t),
      height_ft:
        heightStr && heightStr.trim() !== "" ? parseFloat(heightStr) : null,
      sigma_ft:
        sigmaStr && sigmaStr.trim() !== "" ? parseFloat(sigmaStr) : null,
      flags: decodeFlags(attrs.f),
      quality: decodeQuality(attrs.q),
    });
  }

  return { observations, errorMessage: null };
}

interface ParsedPredictions {
  samples: PredictionSample[];
  errorMessage: string | null;
}

function parsePredictionsXml(xml: string): ParsedPredictions {
  const errMatch = xml.match(/<error[^>]*>([\s\S]*?)<\/error>/i);
  if (errMatch) {
    return { samples: [], errorMessage: errMatch[1].trim() };
  }

  const samples: PredictionSample[] = [];
  const prRegex = /<pr\s+([^/]+?)\/>/g;
  let match: RegExpExecArray | null;
  while ((match = prRegex.exec(xml)) !== null) {
    const attrs = parseAttrs(match[1]);
    if (!attrs.t || !attrs.v) continue;
    samples.push({
      time: coopsTimeToISO(attrs.t),
      height_ft: parseFloat(attrs.v),
    });
  }
  return { samples, errorMessage: null };
}

// =============================================================================
// Hi/Lo derivation from 6-min series
// =============================================================================

// A local max is "strictly rising into the sample, flat-or-falling out of it":
//   curr > prev AND curr >= next
// This picks the first sample of a plateau peak (consecutive 6-min samples with
// the same quantized height) and only the first, since the second sample of the
// plateau has curr === prev which fails the strict-greater-than condition.
//
// Symmetric for local min: curr < prev AND curr <= next.
//
// Why this matters: tide predictions are quantized to thousandths of a foot,
// the curve is smooth at extrema, so equal-height adjacent samples at peaks
// are common. A strict >/< rule drops them; a permissive >=/<= rule
// double-counts them. This asymmetric definition is the right answer.
// Verified empirically — see test logs from Phase 2 development.
function deriveHiLo(samples: PredictionSample[]): TidePrediction[] {
  if (samples.length < 3) return [];
  const events: TidePrediction[] = [];
  for (let i = 1; i < samples.length - 1; i++) {
    const prev = samples[i - 1].height_ft;
    const curr = samples[i].height_ft;
    const next = samples[i + 1].height_ft;
    if (curr > prev && curr >= next) {
      events.push({ time: samples[i].time, type: "H", height_ft: curr });
    } else if (curr < prev && curr <= next) {
      events.push({ time: samples[i].time, type: "L", height_ft: curr });
    }
  }
  return events;
}

// =============================================================================
// Cross-check computation
// =============================================================================

function computeCrossCheck(
  latestObs: { time: string; height_ft: number } | null,
  predictionSamples: PredictionSample[]
): CrossCheck | null {
  if (!latestObs) return null;
  if (predictionSamples.length === 0) return null;

  // Both products use the same 6-min grid, so exact-match lookup works.
  const matched = predictionSamples.find((p) => p.time === latestObs.time);
  if (matched) {
    return buildCrossCheck(latestObs, matched);
  }

  // Fallback: closest sample within 6 minutes — safety net for grid-edge cases.
  const obsMs = Date.parse(latestObs.time);
  let closest: PredictionSample | null = null;
  let closestDelta = Infinity;
  for (const sample of predictionSamples) {
    const delta = Math.abs(Date.parse(sample.time) - obsMs);
    if (delta < closestDelta) {
      closestDelta = delta;
      closest = sample;
    }
  }
  if (!closest || closestDelta > 6 * 60 * 1000) return null;
  return buildCrossCheck(latestObs, closest);
}

function buildCrossCheck(
  latestObs: { time: string; height_ft: number },
  predicted: PredictionSample
): CrossCheck {
  const delta = latestObs.height_ft - predicted.height_ft;
  return {
    at: latestObs.time,
    observed_ft: latestObs.height_ft,
    predicted_ft: predicted.height_ft,
    delta_ft: round3(delta),
    abs_delta_ft: round3(Math.abs(delta)),
    surge_indicated: Math.abs(delta) >= SURGE_THRESHOLD_FT,
    surge_threshold_ft: 0.5,
  };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// =============================================================================
// Channel builders
// =============================================================================

function freshnessFromAge(ageSeconds: number): Freshness {
  const hours = ageSeconds / 3600;
  if (hours < 3) return "current";
  if (hours < 6) return "stale";
  if (hours < 24) return "gap";
  return "offline";
}

function buildWaterLevelChannel(
  parsed: ParsedWaterLevel,
  fetchedAt: string
): WaterLevelChannel | null {
  if (parsed.observations.length === 0) return null;

  // Walk backwards to find the most recent entry with a real height_ft.
  let latest: ParsedWaterLevel["observations"][number] | null = null;
  for (let i = parsed.observations.length - 1; i >= 0; i--) {
    if (parsed.observations[i].height_ft !== null) {
      latest = parsed.observations[i];
      break;
    }
  }
  if (!latest) return null;

  const ageSeconds = Math.max(
    0,
    Math.round(
      (Date.parse(fetchedAt) - Date.parse(latest.time)) / 1000
    )
  );

  const freshness = freshnessFromAge(ageSeconds);

  // For tide stations, "complete" means we have a height. Other fields
  // (sigma, flags, quality) are metadata, not coverage.
  const dataQuality = "complete" as const;

  return {
    observed_at: latest.time,
    age_seconds: ageSeconds,
    freshness,
    data_quality: dataQuality,
    missing_fields: [],
    height_ft: latest.height_ft,
    datum: "MLLW",
    sigma_ft: latest.sigma_ft,
    flags: latest.flags,
    quality: latest.quality,
  };
}

function buildPredictionsChannel(
  samples: PredictionSample[],
  daysRequested: number,
  generatedAt: string
): PredictionsChannel | null {
  if (samples.length === 0) return null;

  const hilo = deriveHiLo(samples);
  return {
    generated_at: generatedAt,
    window: {
      start: samples[0].time,
      end: samples[samples.length - 1].time,
      days_requested: daysRequested,
    },
    datum: "MLLW",
    hilo,
  };
}

// =============================================================================
// Fetcher
// =============================================================================

async function fetchXml(
  url: string
): Promise<{ status: number; body: string }> {
  const resp = await fetch(url, {
    headers: {
      "user-agent": FETCH_USER_AGENT,
      accept: "application/xml,text/xml",
    },
  });
  const body = await resp.text();
  return { status: resp.status, body };
}

export const coopsApiFetcher: UpstreamFetcher<TideObservations> = {
  source: "coops_api",

  async fetch(stationId: string, context?: FetchContext) {
    const daysRequested = context?.daysRequested ?? 2;

    const wlUrl = buildWaterLevelUrl(stationId);
    const predUrl = buildPredictionsUrl(stationId, daysRequested);
    const fetchedAt = new Date().toISOString();

    // Fire both requests in parallel — independent; failure of one doesn't
    // block the other. Channel-level failure is reported via null in the
    // returned TideObservations.
    const [wlResult, predResult] = await Promise.all([
      fetchXml(wlUrl).catch((e: Error) => ({
        status: 0,
        body: `network_error: ${e.message}`,
      })),
      fetchXml(predUrl).catch((e: Error) => ({
        status: 0,
        body: `network_error: ${e.message}`,
      })),
    ]);

    // Parse water_level
    let waterLevel: WaterLevelChannel | null = null;
    if (wlResult.status === 200) {
      const parsed = parseWaterLevelXml(wlResult.body);
      if (!parsed.errorMessage) {
        waterLevel = buildWaterLevelChannel(parsed, fetchedAt);
      }
    }

    // Parse predictions
    let predictions: PredictionsChannel | null = null;
    let predictionSamples: PredictionSample[] = [];
    if (predResult.status === 200) {
      const parsed = parsePredictionsXml(predResult.body);
      if (!parsed.errorMessage) {
        predictionSamples = parsed.samples;
        predictions = buildPredictionsChannel(
          parsed.samples,
          daysRequested,
          fetchedAt
        );
      }
    }

    // If both channels failed, the fetcher itself failed — return null so
    // the orchestrator can surface fallback_chain_exhausted. (CO-OPS chain
    // currently has only this one fetcher, but the contract is correct
    // regardless.)
    if (waterLevel === null && predictions === null) {
      return null;
    }

    // Compute cross_check — requires both channels with usable data.
    let crossCheck: CrossCheck | null = null;
    if (
      waterLevel &&
      waterLevel.height_ft !== null &&
      predictionSamples.length > 0
    ) {
      crossCheck = computeCrossCheck(
        { time: waterLevel.observed_at, height_ft: waterLevel.height_ft },
        predictionSamples
      );
    }

    const observations: TideObservations = {
      water_level: waterLevel,
      predictions,
      cross_check: crossCheck,
    };

    // For provenance: pick water_level URL as primary (it's the "actual data"
    // anchor). The orchestrator wraps this with the source identifier and
    // fallback_chain_used. The predictions URL is part of the same upstream
    // (coops_api) — if a future consumer needs the exact predictions URL
    // they can reconstruct it from the response shape (station id +
    // window.days_requested).
    return {
      observation: observations,
      url: wlUrl,
      fetched_at: fetchedAt,
    };
  },
};

// Helper exported for tests / debugging — not part of the fetcher's runtime path.
export const _internal = {
  parseWaterLevelXml,
  parsePredictionsXml,
  deriveHiLo,
  computeCrossCheck,
  buildWaterLevelUrl,
  buildPredictionsUrl,
  buildWaterLevelChannel,
  buildPredictionsChannel,
  decodeFlags,
  decodeQuality,
  freshnessFromAge,
};
