// src/schema.ts
//
// The contract between the Worker and everything downstream.
// Daughter prompts read this shape. The Sheets archive consumes this shape.
// Future station types (METAR, international buoys) extend this shape.
//
// Schema versioning:
//   - URL path version (/v1/) covers breaking changes
//   - schema_version field covers additive non-breaking changes
//
// When this schema changes, bump in lockstep:
//   - the schema_version literal here
//   - the README's documented schema version
//   - the CHANGELOG.md entry
//   - any consumers (daughter prompts, Sheets schema) that depend on it
//
// History:
//   1.0 — initial NDBC support (Phase 1)
//   1.1 — wave decomposition (swell + wind_wave) for NDBC widget upstream
//   1.2 — CO-OPS tide support (Phase 2): tide_station StationType, coops IdNamespace,
//         TideObservations channel block, TideStationResponse variant of StationResponse,
//         generic UpstreamFetcher<T> so tide and buoy fetchers can share one interface.
//         All additions strictly additive — buoy-side code paths unchanged.
//   1.2 — METAR + forecast-wind support (Phase 3, April 2026): icao IdNamespace,
//         metar StationType, MetarStationResponse variant, three new METAR
//         UpstreamSources, three new forecast UpstreamSources, ForecastWindResponse
//         (top-level — request-keyed, not station-keyed), WindForecast and
//         ValidityFreshness types, eight new WarningCodes covering METAR
//         and forecast-specific failure modes. Schema version not bumped because
//         these types were specified in the v1.2 contract from the start;
//         Phase 3 ships the implementation that makes the contract real.
//   1.2 — NDBC realtime2 fetcher (May 2026): adds "ndbc_realtime2" to the
//         UpstreamSource union and promotes it to NDBC chain primary.
//         Strictly additive — no field shape changes. The decomposition
//         fields under WaveData (added in 1.1) are now populated for SoCal
//         nearshore stations from realtime2's .spec feed; previously those
//         fields stayed empty for these stations because BuoyPro doesn't
//         expose decomposition for them. Schema version not bumped — same
//         precedent as the Phase 3 UpstreamSource additions.

export const SCHEMA_VERSION = "1.2";

// ---- Top-level response shape ----
//
// A StationResponse is one of three variants discriminated by station.type:
//   - "buoy"        → BuoyStationResponse, has `observation: Observation | null`
//   - "tide_station"→ TideStationResponse, has `observations: TideObservations`
//   - "metar"       → MetarStationResponse, has `observation: MetarObservation | null`
//
// Buoy variant has the identical shape it had in schema 1.1 — no breaking change.
// Consumers that branch on station.type get clean per-variant access. Consumers
// that only handle buoy data (Phase 1 daughter prompts) keep working without
// modification, because the buoy variant they expect is still the buoy variant.
//
// ForecastWindResponse is NOT a StationResponse — it's request-keyed (lat/lon/time)
// rather than station-keyed. It has its own top-level shape under the
// /v1/forecast/wind endpoint.

export type StationResponse =
  | BuoyStationResponse
  | TideStationResponse
  | MetarStationResponse;

export interface BuoyStationResponse {
  schema_version: typeof SCHEMA_VERSION;
  station: StationMetadata;       // station.type === "buoy"
  fetched_at: string;             // ISO 8601, when the Worker assembled this response
  upstream: UpstreamMetadata;
  observation: Observation | null; // null only when the entire fallback chain failed
  warnings: Warning[];
}

export interface TideStationResponse {
  schema_version: typeof SCHEMA_VERSION;
  station: StationMetadata;       // station.type === "tide_station"
  fetched_at: string;             // ISO 8601, when the Worker assembled this response
  upstream: UpstreamMetadata;
  observations: TideObservations; // plural — three channels (water_level, predictions, cross_check)
                                   // never null at the top level; individual channels may be null
                                   // when their source fetch failed
  warnings: Warning[];
}

export interface MetarStationResponse {
  schema_version: typeof SCHEMA_VERSION;
  station: StationMetadata;            // station.type === "metar"
  fetched_at: string;
  upstream: UpstreamMetadata;
  observation: MetarObservation | null; // null only when the entire chain failed
  warnings: Warning[];
}

// ---- Forecast-wind response (Phase 3, request-keyed) ----
//
// The forecast-wind endpoint takes lat/lon/time rather than a station ID, so
// its response carries a `request` block instead of `station`. When an NWS
// upstream serves, the response also carries a `gridpoint` block describing
// the resolved NWS gridpoint (for traceability of how the lat/lon was
// resolved). Open-Meteo responses have no gridpoint block.

export interface ForecastWindResponse {
  schema_version: typeof SCHEMA_VERSION;
  request: ForecastRequest;
  gridpoint?: GridpointMetadata;       // present when an NWS upstream served
  fetched_at: string;
  upstream: UpstreamMetadata;
  forecast: WindForecast | null;       // null when chain exhausted, beyond horizon, etc.
  warnings: Warning[];
}

export interface ForecastRequest {
  lat: number;
  lon: number;
  requested_time: string;              // ISO 8601, must be in the future
  units: "kt" | "mph";
  lookback_hours?: number;             // present only when caller passed `lookback`
}

export interface GridpointMetadata {
  id_namespace: "nws_gridpoint";
  office: string;                      // e.g. "LOX"
  x: number;
  y: number;
  location: {
    latitude: number;                  // resolved gridpoint center
    longitude: number;
    description: string;               // human-readable, e.g. "Los Angeles, CA"
  };
}

// ---- Station identity ----

export interface StationMetadata {
  id: string;                  // e.g. "46221", "9410840", "KLAX"
  id_namespace: IdNamespace;   // "ndbc", "coops", "icao", "ukmo", "bom"
  name: string;                // "Santa Monica Bay, CA"
  operator: string;            // "NOAA NDBC", "NOAA CO-OPS", "FAA/NWS"
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
  | "icao"      // ICAO airport codes for METAR weather reports (Phase 3)
  | "ukmo"      // future: UK Met Office
  | "bom";      // future: Australian Bureau of Meteorology

export type StationType =
  | "buoy"
  | "tide_station"
  | "weather_station"
  | "metar";    // changed from airport_metar to match v1.2 RULE 2 spec exactly

// ---- Upstream provenance ----

export interface UpstreamMetadata {
  source: UpstreamSource;
  url: string;                 // the actual URL the Worker successfully read
  fetched_at: string;          // ISO 8601, when this specific upstream was hit
  fallback_chain_used: UpstreamSource[];  // ordered list, success path
}

export type UpstreamSource =
  // Buoy
  | "ndbc_realtime2"
  | "buoypro"
  | "ndbc_widget"
  | "surftruths"
  // Tide
  | "coops_api"
  // METAR (Phase 3)
  | "aviationweather_json"
  | "aviationweather_raw"
  | "nws_observations"
  // Forecast-wind (Phase 3)
  | "nws_gridpoint"
  | "nws_hourly"
  | "open_meteo";

// ---- Observation payload (BUOY) ----

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

// ---- Observation payload (METAR, Phase 3) ----
//
// Shape matches v1.2 RULE 2 spec. wind is always present (calm = 0/0/null/false);
// atmosphere is always present though some sub-fields may be null. raw_metar
// carries the verbatim METAR or SPECI text including the prefix.

export interface MetarObservation {
  observed_at: string;
  age_seconds: number;
  freshness: Freshness;
  data_quality: DataQuality;
  missing_fields: string[];
  wind: MetarWindData;
  atmosphere: MetarAtmosphereData;
  raw_metar: string;
}

export interface MetarWindData {
  direction_deg: number | null;     // null for variable-direction (VRB) wind
  speed_kt: number;                  // 0 for calm
  gust_kt: number | null;
  variable: boolean;                 // true for VRB or for dddVddd direction variation
}

export interface MetarAtmosphereData {
  visibility_sm: number | null;
  temperature_f: number;
  dewpoint_f: number;
  altimeter_inhg: number;
  sea_level_pressure_mb: number | null;  // from RMK SLPxxx; often unavailable
  sky: SkyLayer[];
}

export interface SkyLayer {
  cover: "FEW" | "SCT" | "BKN" | "OVC" | "VV";
  altitude_ft: number;
}

// ---- Forecast payload (Phase 3) ----
//
// Shape matches v1.2 RULE 2 spec. Used by the /v1/forecast/wind endpoint.
// validity_freshness is forecast-specific vocabulary distinct from observation
// freshness — see RULE 3 for the band definitions.

export interface WindForecast {
  issued_at: string;                          // when the model run was published
  issuance_age_seconds: number;
  valid_at: string;                           // the hour the forecast values are for
  requested_to_valid_offset_seconds: number;  // signed: positive = valid is after requested
  validity_freshness: ValidityFreshness;
  data_quality: DataQuality;
  missing_fields: string[];
  wind: ForecastWindData;
}

export interface ForecastWindData {
  direction_deg: number | null;
  speed_kt: number;
  gust_kt: number | null;
}

// RULE 3 forecast issuance bands. Distinct vocabulary from `Freshness` —
// the type system prevents accidental mixing.
export type ValidityFreshness =
  | "current"     // < 6 hours since issuance
  | "stale"       // 6-12 hours since issuance
  | "gap"         // 12-24 hours since issuance
  | "offline";    // > 24 hours since issuance

// RULE 3 observation freshness bands, pre-computed by the Worker
export type Freshness =
  | "current"     // < 3 hours old
  | "stale"       // 3-6 hours old
  | "gap"         // 6-24 hours old
  | "offline";    // > 24 hours old, or no data returned

// Coverage quality of an observation or forecast block
export type DataQuality =
  | "complete"    // all fields the source normally provides are present
  | "partial"     // some expected fields missing
  | "degraded";   // critical fields missing or fallback returned thin data

// ---- Domain-nested measurements (BUOY) ----

export interface WaveData {
  // Aggregate fields — significant wave height and overall period/direction
  significant_height_ft?: number;
  dominant_period_s?: number;
  average_period_s?: number;
  mean_wave_direction_deg?: number;

  // Decomposed components — added in schema 1.1 to support fetchers that
  // expose swell and wind-wave separately (NDBC widget). Each sub-block
  // is independently optional: a fetcher might supply only swell, only
  // wind_wave, both, or neither.
  swell?: WaveComponent;
  wind_wave?: WaveComponent;
}

export interface WaveComponent {
  height_ft?: number;
  period_s?: number;
  direction_deg?: number;
  direction_cardinal?: string;  // e.g. "SSW" — preserved when source gives cardinals
                                 // (precision is ~22.5° band, not exact heading)
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

// ---- Tide channels (CO-OPS, new in 1.2) ----
//
// A tide station response carries three channels under `observations`:
//   - water_level  : real-time observed sensor reading (the "actual data" anchor)
//   - predictions  : harmonic forecast covering the requested window
//   - cross_check  : observed-vs-predicted at the latest observation timestamp,
//                    pre-computed so daughter prompts don't have to do the math.
//                    surge_indicated fires at the RULE 5 threshold (0.5 ft delta).
//
// Each channel is independently nullable. water_level can be null while predictions
// is healthy (real failure mode for some CO-OPS stations during sensor maintenance);
// the inverse is rare but possible. cross_check is null whenever either input is.

export interface TideObservations {
  water_level: WaterLevelChannel | null;
  predictions: PredictionsChannel | null;
  cross_check: CrossCheck | null;
}

export interface WaterLevelChannel {
  observed_at: string;          // ISO 8601 UTC
  age_seconds: number;          // computed by Worker
  freshness: Freshness;         // RULE 3 classification, computed by Worker
  data_quality: DataQuality;
  missing_fields: string[];
  height_ft: number | null;
  datum: string;                // "MLLW" by default
  sigma_ft: number | null;      // CO-OPS sensor uncertainty in feet
  flags: string[];              // CO-OPS f-attribute decoded — e.g. ["max_exceeded"]
  quality: "preliminary" | "verified" | "rejected";  // CO-OPS q-attribute: p / v / r
}

export interface TidePrediction {
  time: string;                 // ISO 8601 UTC
  type: "H" | "L";
  height_ft: number;
}

export interface PredictionsChannel {
  generated_at: string;         // ISO 8601 UTC, when Worker fetched
  window: {
    start: string;              // ISO 8601 UTC
    end: string;                // ISO 8601 UTC
    days_requested: number;     // 1-7
  };
  datum: string;                // "MLLW"
  hilo: TidePrediction[];       // derived from 6-min predictions samples
}

export interface CrossCheck {
  at: string;                   // ISO 8601 UTC, moment of comparison
  observed_ft: number;
  predicted_ft: number;
  delta_ft: number;             // observed - predicted, signed
  abs_delta_ft: number;
  surge_indicated: boolean;     // true if abs_delta_ft >= surge_threshold_ft (RULE 5)
  surge_threshold_ft: 0.5;
}

// ---- Warnings ----

export interface Warning {
  code: WarningCode;
  message: string;             // human-readable, may surface in daughter prompts
  detail?: Record<string, unknown>;  // optional structured context
}

export type WarningCode =
  // Universal
  | "fallback_used"             // primary upstream failed, fell back successfully
  | "partial_data"              // observation present but missing expected fields
  | "stale_observation"         // freshness is "stale" or worse
  | "parse_warning"             // upstream returned data but parsing was lossy
  | "fallback_chain_exhausted"  // all upstreams failed (paired with observation: null)
  // Tide-specific (1.2):
  | "water_level_unavailable"   // CO-OPS water_level product failed; predictions may still be present
  | "predictions_unavailable"   // CO-OPS predictions product failed; water_level may still be present
  | "cross_check_unavailable"   // can't compute cross_check (one or both input channels missing)
  // METAR-specific (Phase 3):
  | "no_metar_issued"           // valid ICAO but no METAR issued (e.g. station decommissioned, never issued)
  | "visibility_below_minimum"  // visibility under 1 SM — surface as a non-fatal note
  // Forecast-wind specific (Phase 3):
  | "beyond_forecast_horizon"   // requested time beyond what the served upstream provides
  | "gridpoint_distance_warning" // resolved gridpoint > 3 km from requested point
  | "non_nws_upstream"          // forecast came from open_meteo, not NWS
  | "forecast_too_stale"        // caller passed lookback and issuance was older than threshold
  | "forecast_wind_variable";   // upstream returned variable direction at the valid time

// ---- Fetcher interface (parser modules implement this) ----
//
// Each upstream source is a plug-in module exposing this single function.
// The orchestration layer in the endpoint walks the chain and calls fetch()
// on each in order until one returns a usable result.
//
// Generic over T (defaults to Observation for backward compat with Phase 1
// fetchers): NDBC fetchers implement UpstreamFetcher (= UpstreamFetcher<Observation>),
// CO-OPS fetcher implements UpstreamFetcher<TideObservations>, METAR fetchers
// implement UpstreamFetcher<MetarObservation>.
//
// The fetcher's argument shape stays a bare stationId for buoys; the CO-OPS
// fetcher takes a StationFetchContext to receive `daysRequested` for the
// predictions window. Most fetchers don't need this; we pass it as an
// optional second arg so the existing buoy fetchers keep their (stationId)
// signature unchanged.
//
// Forecast-wind fetchers do NOT implement UpstreamFetcher — they have a
// different shape (lat/lon/time instead of stationId, plus richer return
// envelope including gridpoint and warnings). They implement ForecastFetcher
// defined in src/fetchers/nwsGridpoint.ts.

export interface FetchContext {
  daysRequested?: number;       // CO-OPS predictions window (1-7); ignored by buoy/METAR fetchers
}

export interface UpstreamFetcher<T = Observation> {
  source: UpstreamSource;
  /**
   * Returns a complete or partial observation if the upstream returned usable data.
   * Returns null if the upstream was unreachable, returned empty data, or returned
   * data that failed validation. Throwing is also acceptable and is treated as
   * "this upstream failed, try the next one."
   */
  fetch(stationId: string, context?: FetchContext): Promise<{
    observation: T;
    url: string;
    fetched_at: string;
  } | null>;
}

// =============================================================================
// Diagnostic relay (POST /v1/report)
// =============================================================================
//
// Daughter prompts POST to /v1/report after rendering a report. The Worker
// validates the payload and relays it to a central Google Apps Script that
// appends rows to a monitoring sheet. The relay is intended only for
// observability — it must never block, alter, or surface inside the report
// the user reads.
//
// Privacy contract (referenced in the homepage FAQ):
//   - No personal identity (name, email, account, IP) is captured here.
//   - Break name and runtime identity ARE captured; both are public-facing.
//   - The Worker does not pass through cf-connecting-ip or User-Agent to
//     the relay sheet. Cloudflare's own request logs are out of scope.
//
// This endpoint is open inbound (no caller secret). The outbound relay
// to Apps Script is authenticated by MONITORING_SECRET held as a Worker
// secret env var; daughter prompts never see it.

export const DIAGNOSTIC_RUNTIMES = [
  "claude_web",
  "claude_api",
  "chatgpt_plus",
  "chatgpt_free",
  "perplexity_pro",
  "perplexity_free",
  "other",
] as const;

export const DIAGNOSTIC_REPORT_TYPES = ["session", "long_range"] as const;

export const DIAGNOSTIC_CONFIDENCE_VALUES = [
  "High",
  "Medium",
  "Low",
  "Speculative",
] as const;

export const DIAGNOSTIC_FETCH_PATHS = [
  "default",
  "code_exec_http",
  "search_only",
  "mixed",
  "unknown",
] as const;

export type DiagnosticRuntime = typeof DIAGNOSTIC_RUNTIMES[number];
export type DiagnosticReportType = typeof DIAGNOSTIC_REPORT_TYPES[number];
export type DiagnosticConfidence = typeof DIAGNOSTIC_CONFIDENCE_VALUES[number];
export type DiagnosticFetchPath = typeof DIAGNOSTIC_FETCH_PATHS[number];

// Field length caps. These mirror the Apps Script's caps so that anything
// the Worker accepts will also be accepted by the relay. The Worker truncates
// (not rejects) over-length values, matching relay behavior.
export const DIAGNOSTIC_LIMITS = {
  RUN_ID_MAX: 64,
  KIT_VERSION_MAX: 16,
  BREAK_NAME_MAX: 200,
  DATA_GAPS_MAX: 500,
  DEVIATION_NOTES_MAX: 500,
} as const;

// What daughter prompts POST to /v1/report. All fields required except
// data_gaps and deviation_notes which may be empty strings.
export interface DiagnosticPayload {
  run_id: string;
  kit_version: string;
  runtime: DiagnosticRuntime;
  report_type: DiagnosticReportType;
  break_name: string;
  confidence: DiagnosticConfidence;
  fetch_path: DiagnosticFetchPath;
  data_gaps: string;        // comma-separated state vocab values, or ""
  deviation_notes: string;  // free text, or ""
}

// What the Worker returns to the caller after relaying.
export interface DiagnosticResponse {
  ok: boolean;
  received_at: string | null;   // server timestamp from relay; null on failure
  relay_status: "ok" | "duplicate" | "relay_error" | "validation_error";
  error?: string;               // populated when ok === false
}
