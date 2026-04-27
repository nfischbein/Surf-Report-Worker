# Changelog

All notable changes to the Surf Report Worker. The Worker is the data-source
half of the Surf Report Builder system; the schema it emits is the authoritative
contract for daughter prompts and the System Builder Prompt.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Worker package version (`package.json`) and schema version (`SCHEMA_VERSION` in
`src/schema.ts`) move independently — the schema version follows the Builder
Prompt's contract, and the package version tracks deploy state.

## [worker 0.0.5] — 2026-04-27 — schema 1.2 Phase 3 (METAR + forecast-wind)

Phase 3 ships the implementation of two endpoint families that have been part
of the v1.2 contract since it was written. The schema version stays at `1.2`
because no contract changes — these were spec'd in v1.2 from the start;
Phase 3 is the implementation that makes the contract real.

### Added

- **METAR observations** at `/v1/station/icao/<id>` with three-upstream
  fallback chain: `aviationweather_json` → `aviationweather_raw` →
  `nws_observations`. Returns `MetarStationResponse` with structured
  wind/atmosphere/sky and the verbatim METAR text preserved as `raw_metar`.
- **Forecast wind** at `/v1/forecast/wind?lat=&lon=&time=[&units=][&lookback=]`
  with three-upstream fallback chain: `nws_gridpoint` → `nws_hourly` →
  `open_meteo`. Request-keyed (lat/lon/time) rather than station-keyed.
  Returns `ForecastWindResponse` with `WindForecast` carrying issuance time,
  validity window, and a `validity_freshness` band per RULE 3.
- **Shared METAR text parser** at `src/parsers/metar.ts`. Hand-rolled regex,
  zero new dependencies. Handles standard reports, SPECI, calm wind, VRB,
  direction variation (`dddVddd`), KT/MPS/KMH wind units, fractional and
  international visibility (with `9999` ICAO sentinel), all sky-cover codes
  including `VV` and `CLR/SKC/NSC/NCD`, negative temperatures, both `A####`
  and `Q####` altimeter formats, and SLP decoding from RMK.
- **Three METAR upstream fetchers** (`aviationweatherJson.ts`,
  `aviationweatherRaw.ts`, `nwsObservations.ts`) that share a single
  `composeMetarObservation()` helper to keep all three producing identical
  shapes from identical parsed input.
- **Three forecast-wind upstream fetchers** (`nwsGridpoint.ts`,
  `nwsHourly.ts`, `openMeteo.ts`) implementing the new `ForecastFetcher`
  interface (lat/lon/time/units/lookback args, richer return envelope
  including resolved gridpoint metadata and per-fetcher warnings).
- **Schema additions (additive only):**
  - `IdNamespace` adds `"icao"`.
  - `StationType` adds `"metar"` (matching the v1.2 RULE 2 spec literal).
  - `StationResponse` union grows to include `MetarStationResponse`.
  - New top-level `ForecastWindResponse` with `ForecastRequest`,
    `GridpointMetadata`, `WindForecast`, `ForecastWindData`,
    `ValidityFreshness`.
  - `MetarObservation` plus `MetarWindData`, `MetarAtmosphereData`, `SkyLayer`.
  - `UpstreamSource` adds `aviationweather_json`, `aviationweather_raw`,
    `nws_observations`, `nws_gridpoint`, `nws_hourly`, `open_meteo`.
  - `WarningCode` adds `no_metar_issued`, `visibility_below_minimum`,
    `beyond_forecast_horizon`, `gridpoint_distance_warning`,
    `non_nws_upstream`, `forecast_too_stale`, `forecast_wind_variable`.
- **Station directory entries** for KLAX, KSMO, KHHR.
- **Cache TTLs:** METAR 30 min (matching the hourly METAR cycle with SPECI
  margin), forecast-wind 60 min (matching the hourly gridpoint refresh).
- **Forecast-wind cache key** rounds lat/lon to 3 decimals (~110 m) and time
  to nearest hour to keep the cache hot for nearby callers without
  fragmenting on sub-meaningful coordinate or time differences.

### Changed

- Service-info root response (`/`) now reports version `0.0.5`, the new
  endpoint list, and the expanded `supported_namespaces` array. Prior text
  noting "METAR/wind support pending in Phase 3" removed.
- `cachedBuild<T>` is now generic over `T` (no longer constrained to
  `StationResponse` subtypes) so the same helper handles forecast-wind too.
- The forecast-wind builder special-cases two warning codes
  (`beyond_forecast_horizon`, `forecast_too_stale`) — when an upstream emits
  one of these with a null forecast, the builder returns immediately rather
  than walking the rest of the chain. The next upstream would have the same
  problem; falling through would just append duplicate warnings.

### Notes

- `open_meteo` always emits a `non_nws_upstream` warning when it serves.
  This is by design — daughter prompts can use it to know that model
  provenance differs from the canonical US forecast.
- Open-Meteo's free forecast endpoint doesn't expose model issuance time;
  we approximate `issuance_age_seconds` at 60 minutes. This keeps validity
  in the `current` band per RULE 3 while being honest about the
  approximation via the `non_nws_upstream` warning.
- NWS upstreams use a parenthesized User-Agent
  (`(SurfReportBuilderBot/1.0, https://github.com/nfischbein/Surf-Report-Worker)`)
  per their access policy. aviationweather.gov and Open-Meteo continue to
  use the standard repo-identifying User-Agent.
- `no_metar_issued` is defined in the schema but the orchestrator currently
  emits `fallback_chain_exhausted` for both "valid ICAO with no METAR" and
  "METAR exists but unreachable" cases. Distinguishing them perfectly
  requires per-fetcher signaling we'll add in a follow-up.

## [schema 1.2] — Phase 2 (CO-OPS tide stations)

Released alongside Phase 2 deploy of the Worker. Strictly additive over 1.1
on the buoy code paths.

### Added

- `coops` IdNamespace and `tide_station` StationType.
- `TideStationResponse` variant of `StationResponse` carrying three channels
  under `observations`: `water_level`, `predictions`, `cross_check`.
- `TideObservations`, `WaterLevelChannel`, `PredictionsChannel`,
  `TidePrediction`, `CrossCheck` types.
- Generic `UpstreamFetcher<T>` so the CO-OPS fetcher and the buoy fetchers
  can share the same chain-walking machinery.
- `FetchContext` optional second arg to fetchers; CO-OPS uses it for
  `daysRequested` (1–7 day predictions window). Buoy fetchers ignore it.
- New WarningCodes: `water_level_unavailable`, `predictions_unavailable`,
  `cross_check_unavailable`.
- RULE 5 surge-detection: `cross_check.surge_indicated` fires when
  `abs_delta_ft >= 0.5 ft`.
- `/v1/station/coops/<id>?days=<1-7>` route. Default window is 2 days.
- METAR + forecast-wind contract spec'd in this release. Implementation
  shipped in Phase 3 (Worker 0.0.5, above).

## [schema 1.1] — Phase 1.5 (wave decomposition)

### Added

- `WaveData.swell` and `WaveData.wind_wave` sub-blocks (`WaveComponent`
  type) for fetchers that expose wave components separately. Used by the
  NDBC widget upstream; BuoyPro continues to populate the aggregate fields.
- Each component carries `height_ft`, `period_s`, `direction_deg`, and an
  optional `direction_cardinal` preserved when the source provides cardinals
  rather than exact headings.

## [schema 1.0] — Phase 1 (NDBC buoys)

Initial Worker release.

### Added

- `/v1/station/ndbc/<id>` endpoint with two-upstream fallback chain:
  `buoypro` (HTML scrape with embedded JSON time-series) →
  `ndbc_widget` (NDBC's own per-station widget endpoint).
- Core schema: `BuoyStationResponse`, `Observation`, `WaveData`, `WindData`,
  `WaterData`, `AtmosphereData`, `StationMetadata`, `UpstreamMetadata`,
  `Warning`, plus `Freshness` and `DataQuality` enumerations.
- RULE 3 freshness bands (current / stale / gap / offline) computed by the
  Worker on every response.
- KV-backed reactive cache (5 min TTL for buoy responses) via
  `SURF_CACHE` binding. Worker degrades gracefully when KV is unbound.
- Hard-coded station directory for known SoCal stations (NDBC 46221, 46222).
