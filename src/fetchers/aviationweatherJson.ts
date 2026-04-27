// src/fetchers/aviationweatherJson.ts
//
// Aviation Weather Center JSON METAR fetcher (primary upstream).
//
// Endpoint:
//   https://aviationweather.gov/api/data/metar?ids=<ICAO>&format=json&taf=false&hours=2
//
// Returns a JSON array of recent METAR/SPECI reports for the station, ordered
// most-recent-first. We take element [0] and use its rawOb field as the canonical
// METAR text, then run it through the shared parser.
//
// Strategy: prefer the JSON envelope's rawOb over the JSON's parsed fields.
// Reasons:
//   - The JSON has its own field decoding but it isn't 100% reliable for
//     edge cases (calm wind, light-and-variable, RMK SLP). Round-tripping
//     through our own parser keeps decoding logic consistent across all
//     three METAR upstreams.
//   - The `obsTime` epoch in the JSON envelope is authoritative for
//     observed_at — slightly more reliable than parsing the DDHHMMZ token
//     when month wrap is involved. We use it when present.
//
// Returns null on any of:
//   - HTTP non-2xx
//   - Empty array (station valid but no METAR in the requested window)
//   - Missing rawOb on element [0]
//   - Parser throws (malformed METAR)
//
// `hours=2` covers the routine 1-hour cadence plus enough margin that we
// pick up SPECI reports issued in the past hour without a window gap. Also
// keeps payload small.

import type {
  UpstreamFetcher,
  MetarObservation,
  Freshness,
} from "../schema";
import { parseMetar } from "../parsers/metar";

const FETCH_USER_AGENT =
  "Mozilla/5.0 (compatible; SurfReportBuilderBot/1.0; +https://github.com/nfischbein/Surf-Report-Worker)";

const ENDPOINT_BASE = "https://aviationweather.gov/api/data/metar";

interface AviationWeatherMetarRecord {
  rawOb?: string;
  obsTime?: number;     // epoch seconds, UTC
  receiptTime?: string; // ISO-ish
  metar_type?: string;  // "METAR" or "SPECI"
  // ... many other fields, none of which we use directly
}

export const aviationWeatherJsonFetcher: UpstreamFetcher<MetarObservation> = {
  source: "aviationweather_json",
  async fetch(stationId: string) {
    const id = stationId.toUpperCase();
    const url = `${ENDPOINT_BASE}?ids=${encodeURIComponent(id)}&format=json&taf=false&hours=2`;
    const fetchedAt = new Date().toISOString();

    const response = await fetch(url, {
      headers: {
        "user-agent": FETCH_USER_AGENT,
        accept: "application/json",
      },
    });

    if (!response.ok) {
      return null;
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      return null;
    }

    if (!Array.isArray(payload) || payload.length === 0) {
      return null;
    }

    const record = payload[0] as AviationWeatherMetarRecord;
    if (!record.rawOb || typeof record.rawOb !== "string") {
      return null;
    }

    let parsed;
    try {
      parsed = parseMetar(record.rawOb);
    } catch {
      return null;
    }

    // Prefer envelope obsTime over parsed observed_at when present — it's
    // authoritative on month/year boundaries.
    const observedAt =
      typeof record.obsTime === "number"
        ? new Date(record.obsTime * 1000).toISOString()
        : parsed.observed_at;

    const ageSeconds = Math.max(
      0,
      Math.round((Date.parse(fetchedAt) - Date.parse(observedAt)) / 1000)
    );
    const freshness = freshnessFromAge(ageSeconds);

    const observation = composeMetarObservation({
      observedAt,
      ageSeconds,
      freshness,
      parsed,
    });

    return {
      observation,
      url,
      fetched_at: fetchedAt,
    };
  },
};

// =============================================================================
// Composition (shared shape with the other two METAR fetchers)
// =============================================================================
//
// Lives here in the primary fetcher; the other two import it. Keeping the
// composition logic central means all three fetchers produce identical
// MetarObservation shapes from identical ParsedMetar inputs — no drift.

import type { ParsedMetar } from "../parsers/metar";

export function composeMetarObservation(args: {
  observedAt: string;
  ageSeconds: number;
  freshness: Freshness;
  parsed: ParsedMetar;
}): MetarObservation {
  const { observedAt, ageSeconds, freshness, parsed } = args;

  // Required-fields accounting per v1.2 RULE 2 spec.
  // Wind is always present in the schema (calm = 0/0/null with variable=false);
  // therefore wind is missing only if the METAR had no wind token at all.
  const missingFields: string[] = [];
  const windPresent = parsed.wind_token_present;
  if (!windPresent) {
    missingFields.push("wind");
  }
  if (parsed.visibility_sm === null) missingFields.push("atmosphere.visibility_sm");
  if (parsed.temperature_f === null) missingFields.push("atmosphere.temperature_f");
  if (parsed.dewpoint_f === null) missingFields.push("atmosphere.dewpoint_f");
  if (parsed.altimeter_inhg === null) missingFields.push("atmosphere.altimeter_inhg");

  // sea_level_pressure_mb is only sometimes present (RMK SLP). Not counted.
  // sky is allowed to be empty (CLR).

  const dataQuality =
    missingFields.length === 0
      ? "complete"
      : windPresent && parsed.temperature_f !== null
        ? "partial"
        : "degraded";

  // Calm wind: 00000KT → speed 0, direction 0, variable false (per spec).
  // Light-and-variable: VRB → direction null, variable true.
  // Numeric direction: variable true only if dddVddd was present.
  return {
    observed_at: observedAt,
    age_seconds: ageSeconds,
    freshness,
    data_quality: dataQuality,
    missing_fields: missingFields,
    wind: {
      direction_deg: parsed.wind_direction_deg,
      speed_kt: parsed.wind_speed_kt,
      gust_kt: parsed.wind_gust_kt,
      variable: parsed.wind_variable,
    },
    atmosphere: {
      visibility_sm: parsed.visibility_sm,
      temperature_f: parsed.temperature_f ?? 0,
      dewpoint_f: parsed.dewpoint_f ?? 0,
      altimeter_inhg: parsed.altimeter_inhg ?? 0,
      sea_level_pressure_mb: parsed.sea_level_pressure_mb,
      sky: parsed.sky.map((layer) => ({
        cover: layer.cover,
        altitude_ft: layer.altitude_ft,
      })),
    },
    raw_metar: parsed.raw_metar,
  };
}

export function freshnessFromAge(ageSeconds: number): Freshness {
  const hours = ageSeconds / 3600;
  if (hours < 3) return "current";
  if (hours < 6) return "stale";
  if (hours < 24) return "gap";
  return "offline";
}

// Helper exported for tests / debugging.
export const _internal = {
  composeMetarObservation,
  freshnessFromAge,
};
