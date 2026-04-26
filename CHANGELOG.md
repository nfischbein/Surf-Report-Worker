# Schema Changelog

The Worker's response schema is versioned. The major version is in the URL
path (`/v1/`); minor versions are additive and reported in the
`schema_version` field of every response.

## 1.1 — 2026-04-26

Added optional decomposed wave components to support fetchers that expose
swell and wind-wave separately (NDBC widget). Daughter prompts that have
access to decomposition can write sharper surf interpretation —
distinguishing the surfable swell component from wind-wave chop — without
losing the aggregate `significant_height_ft` reading.

**Added:**

- `WaveComponent` interface — shared shape for swell and wind-wave sub-blocks:
  `height_ft`, `period_s`, `direction_deg`, `direction_cardinal`.
- `waves.swell?: WaveComponent` — present when the upstream exposes a
  decomposed swell component.
- `waves.wind_wave?: WaveComponent` — present when the upstream exposes a
  decomposed wind-wave component.

**Notes:**

- `direction_cardinal` (e.g. `"SSW"`) is preserved alongside the degrees
  conversion to honestly signal the underlying ~22.5° precision band when
  the upstream gave us cardinals rather than exact degrees.
- The aggregate `waves.mean_wave_direction_deg` field is unchanged. Some
  fetchers (NDBC widget) won't populate it because they don't expose an
  aggregate direction, only per-component directions.

**Backward compatibility:**

- Existing aggregate fields (`waves.significant_height_ft`,
  `waves.dominant_period_s`, `waves.average_period_s`,
  `waves.mean_wave_direction_deg`) are unchanged.
- Consumers that only read aggregate fields are unaffected by this bump.
- `waves.swell` and `waves.wind_wave` are both optional. Fetchers that
  don't expose decomposition (BuoyPro for SoCal nearshore, as of writing)
  leave them undefined.

## 1.0 — 2026-04-26

Initial schema. Defines `StationResponse`, `StationMetadata`, `Observation`,
`UpstreamMetadata`, `WaveData`, `WindData`, `WaterData`, `AtmosphereData`,
and the freshness/data-quality vocabularies.
