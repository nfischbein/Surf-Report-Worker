// src/schema.ts
//
// The contract between the Worker and everything downstream.
// Daughter prompts read this shape. The Sheets archive consumes this shape.
// Future station types (tide, METAR, international buoys) extend this shape.
//
// Schema versioning:
//   - URL path version (/v1/) covers breaking changes
//   - schema_version field covers additive non-breaking changes
//
// When this schema changes, bump in lockstep:
//   - the schema_version literal here
//   - the README's documented schema version
//   - any consumers (daughter prompts, Sheets schema) that depend on it

export const SCHEMA_VERSION = "1.0";

// ---- Top-level response shape ----

export interface StationResponse {
  schema_version: typeof SCHEMA_VERSION;
  station: StationMetadata;
  fetched_at: string;          // ISO 8601, when the Worker assembled this response
  upstream: UpstreamMetadata;
  observation: Observation | null;  // null only when the entire fallback chain failed
  warnings: Warning[];
}

// ---- Station identity ----

export interface StationMetadata {
  id: string;                  // e.g. "46221"
  id_namespace: IdNamespace;   // "ndbc", "coops", "metar", "ukmo", "bom", ...
  name: string;                // "Santa Monica Bay, CA"
  operator: string;            // "NOAA NDBC"
  location: {
    latitude: number;
    longitude: number;
    description: string;       // human-readable, e.g. "West of El Segundo, CA"
  };
  type: StationType;
}

export type IdNamespace =
  | "ndbc"      // US NOAA National Data Buoy Center
  | "coops"     // US NOAA CO-OPS tide stations
  | "metar"     // ICAO airport codes for METAR weather reports
  | "ukmo"      // future: UK Met Office
  | "bom";      // future: Australian Bureau of Meteorology

export type StationType =
  | "buoy"
  | "tide_station"
  | "weather_station"
  | "airport_metar";

// ---- Upstream provenance ----

export interface UpstreamMetadata {
  source: UpstreamSource;
  url: string;                 // the actual URL the Worker successfully read
  fetched_at: string;          // ISO 8601, when this specific upstream was hit
  fallback_chain_used: UpstreamSource[];  // ordered list, success path
}

export type UpstreamSource =
  | "buoypro"
  | "ndbc_widget"
  | "surftruths"
  | "coops_api"
  | "aviationweather_metar";

// ---- Observation payload ----

export interface Observation {
  observed_at: string;         // ISO 8601, timestamp visible on upstream page
  age_seconds: number;         // computed: fetched_at - observed_at
  freshness: Freshness;
  data_quality: DataQuality;
  missing_fields: string[];    // e.g. ["wind", "atmosphere"] — empty array if none
  waves?: WaveData;
  wind?: WindData;
  water?: WaterData;
  atmosphere?: AtmosphereData;
}

// RULE 3 freshness bands, pre-computed by the Worker
export type Freshness =
  | "current"     // < 3 hours old
  | "stale"       // 3-6 hours old
  | "gap"         // 6-24 hours old
  | "offline";    // > 24 hours old, or no data returned

// Coverage quality of the observation block
export type DataQuality =
  | "complete"    // all fields the station type normally provides are present
  | "partial"     // some expected fields missing (e.g. waves present, wind absent)
  | "degraded";   // critical fields missing or fallback returned thin data

// ---- Domain-nested measurements ----

export interface WaveData {
  significant_height_ft?: number;
  dominant_period_s?: number;
  average_period_s?: number;
  mean_wave_direction_deg?: number;
}

export interface WindData {
  speed_kt?: number;
  gust_kt?: number;
  direction_deg?: number;
}

export interface WaterData {
  temperature_f?: number;
}

export interface AtmosphereData {
  pressure_mb?: number;
  air_temperature_f?: number;
}

// ---- Warnings ----

export interface Warning {
  code: WarningCode;
  message: string;             // human-readable, may surface in daughter prompts
  detail?: Record<string, unknown>;  // optional structured context
}

export type WarningCode =
  | "fallback_used"             // primary upstream failed, fell back successfully
  | "partial_data"              // observation present but missing expected fields
  | "stale_observation"         // freshness is "stale" or worse
  | "parse_warning"             // upstream returned data but parsing was lossy
  | "fallback_chain_exhausted"; // all upstreams failed (paired with observation: null)

// ---- Fetcher interface (parser modules implement this) ----
//
// Each upstream source is a plug-in module exposing this single function.
// The orchestration layer in the endpoint walks the chain and calls fetch()
// on each in order until one returns a usable result.

export interface UpstreamFetcher {
  source: UpstreamSource;
  /**
   * Returns a complete or partial Observation if the upstream returned usable data.
   * Returns null if the upstream was unreachable, returned empty data, or returned
   * data that failed validation. Throwing is also acceptable and is treated as
   * "this upstream failed, try the next one."
   */
  fetch(stationId: string): Promise<{
    observation: Observation;
    url: string;
    fetched_at: string;
  } | null>;
}