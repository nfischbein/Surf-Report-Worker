# Changelog

All notable changes to the Surf Report Worker. The Worker is the data-source
half of the Surf Report Builder system; the schema it emits is the authoritative
contract for daughter prompts and the System Builder Prompt.

The format is loosely based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Worker package version (`package.json`) and schema version (`SCHEMA_VERSION` in
`src/schema.ts`) move independently — the schema version follows the Builder
Prompt's contract, and the package version tracks deploy state.

## [worker 0.0.6] — 2026-05-03 — NDBC realtime2 fetcher promoted to chain primary

Adds a new NDBC fetcher that reads NOAA's canonical published realtime2
feeds (`.txt` standard meteorological + `.spec` spectral wave decomposition)
and promotes it to NDBC chain primary. Demotes BuoyPro to tertiary; NDBC
widget stays at secondary. No schema shape change — the decomposition
fields under `WaveData` (added in schema 1.1) are now populated for SoCal
nearshore stations from realtime2's `.spec` feed; previously those fields
stayed empty for these stations because BuoyPro doesn't expose
decomposition for them.

Coordinated Builder edits to HARD RULE 2 in `system_builder_prompt.txt`
are deliberately deferred — they happen in a separate Builder thread after
3–7 days of empirical validation that the realtime2 `.spec` decomposition
produces noticeably better Tier 1 prose.

### Added

- **`src/fetchers/ndbcRealtime2.ts`** — new fetcher implementing the
  `UpstreamFetcher` interface. Fetches `.txt` and `.spec` in parallel
  via `Promise.all`. Parses fixed-column whitespace-tokenized data,
  skipping `#`-prefixed header rows and treating `MM` as the missing-data
  sentinel.
- **Per-field freshness model.** Within each feed, walks rows from
  newest to oldest and records the most-recent non-`MM` value per field
  alongside its row timestamp. `observed_at` on the composed Observation
  is the max timestamp across all contributing rows. This is necessary
  because NDBC reports DPD/APD/MWD on a slower cadence than WVHT — naively
  picking the latest row would miss period/direction values that are
  available one or two rows back. Mirrors how the BuoyPro fetcher handles
  its per-field JSON time series.
- **16-point compass → degrees lookup.** `.spec` reports SwD and WWD as
  compass cardinals (e.g. "SW", "WNW") despite the header line claiming
  WWD is degT. The lookup table is duplicated locally rather than
  imported from `ndbcWidget.ts`; if a third fetcher ever needs the same
  conversion, refactoring to a shared utility becomes worth doing.
- **`UpstreamSource` literal `"ndbc_realtime2"`** added to the schema's
  union. Strictly additive — no consumer code branches on the prior set
  of literals exhaustively. Schema version not bumped, same precedent as
  the Phase 3 UpstreamSource additions (METAR + forecast-wind).

### Changed

- **`NDBC_FETCHER_CHAIN` order in `src/orchestrator.ts`:**
  realtime2 → ndbc_widget → buoypro. Previously buoypro → ndbc_widget.
  No surftruths entry — the previously-documented "supplementary" tier
  was never actually wired into the orchestrator.
- **`SERVICE_INFO.version` in `src/index.ts`:** 0.0.5 → 0.0.6.
- **NDBC freshness threshold comment in `src/orchestrator.ts`:** generalized
  from "lifted from buoyProFetcher" to "all NDBC fetchers carry their own
  copy" since realtime2 now also carries the same thresholds locally.
- **Schema history comment in `src/schema.ts`:** new history line documenting
  the realtime2 addition.

### Notes

- **Decomposition character.** For SoCal nearshore stations like 46221 /
  46222, schema 1.1's `swell` and `wind_wave` sub-blocks under `WaveData`
  were previously left empty. They now populate with realtime2 `.spec`
  data: per-component height (m → ft), period (sec), and direction (compass
  cardinal preserved alongside degree conversion to signal the ~22.5°
  precision band).
- **STEEPNESS field.** `.spec` exposes a categorical steepness classification
  (STEEP / VERY_STEEP / AVERAGE / SWELL) that the parser currently discards.
  Adding it would require a schema field; deferred as a possible future
  enhancement.
- **Wind / atmosphere / water.** For stations with the relevant sensors,
  realtime2 also populates `wind`, `atmosphere`, and `water` sub-blocks.
  For stations without (most SoCal nearshore wave buoys), those columns
  are `MM` in `.txt` and the corresponding sub-blocks stay absent — matching
  the existing BuoyPro / widget behavior for the same stations.
- **Lockstep dependency on Builder Prompt.** HARD RULE 2 in
  `system_builder_prompt.txt` (separate Builder repo) currently states
  that decomposition is unavailable from BuoyPro for SoCal nearshore
  stations and frames BuoyPro as the verified primary. Both framings are
  obsolete after this ship but remain operationally harmless during the
  3–7 day empirical validation window — the rule's source-selection
  guidance still works because the Worker handles chain selection.
  Builder edits land in a separate Builder thread after validation.
- **Pre-existing version drift.** `package.json` reports `"version":
  "0.0.1"` while `SERVICE_INFO` (and thus the version exposed at the
  Worker root) is now `"0.0.6"`. This drift predates Item 25; not fixed
  here to keep the change focused on the realtime2 work.

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
