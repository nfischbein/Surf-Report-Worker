// src/orchestrator.ts
//
// Walks a chain of upstream fetchers in priority order, returning the first
// usable result wrapped in the appropriate response variant.
//
// Three station-keyed chains, three station response builders, plus one
// request-keyed chain for forecast-wind:
//   - NDBC chain → BuoyStationResponse  (Phase 1 contract, unchanged)
//   - CO-OPS chain → TideStationResponse (Phase 2)
//   - METAR chain → MetarStationResponse (Phase 3)
//   - Forecast-wind chain → ForecastWindResponse (Phase 3, lat/lon/time-keyed)
//
// All four share a KV cache layer with per-data-class TTLs and a shared
// chain-walker pattern.

import type {
  Observation,
  StationMetadata,
  TideObservations,
  MetarObservation,
  WindForecast,
  UpstreamFetcher,
  UpstreamSource,
  Warning,
  BuoyStationResponse,
  TideStationResponse,
  MetarStationResponse,
  ForecastWindResponse,
  ForecastRequest,
  IdNamespace,
} from "./schema";
import { SCHEMA_VERSION } from "./schema";
import { ndbcRealtime2Fetcher } from "./fetchers/ndbcRealtime2";
import { buoyProFetcher } from "./fetchers/buoypro";
import { ndbcWidgetFetcher } from "./fetchers/ndbcWidget";
import { coopsApiFetcher } from "./fetchers/coopsApi";
import { aviationWeatherJsonFetcher } from "./fetchers/aviationweatherJson";
import { aviationWeatherRawFetcher } from "./fetchers/aviationweatherRaw";
import { nwsObservationsFetcher } from "./fetchers/nwsObservations";
import {
  nwsGridpointFetcher,
  type ForecastFetcher,
  type ForecastFetchArgs,
} from "./fetchers/nwsGridpoint";
import { nwsHourlyFetcher } from "./fetchers/nwsHourly";
import { openMeteoFetcher } from "./fetchers/openMeteo";

// =============================================================================
// Worker environment binding
// =============================================================================

// SURF_CACHE is a KV namespace bound in wrangler.toml. May be undefined in
// local dev or test environments without the binding — the cache helper
// degrades gracefully (every call goes to upstream, no caching).
//
// MONITORING_RELAY_URL and MONITORING_SECRET drive the /v1/report endpoint.
// Both are Wrangler secrets, not committed. When either is unset, /v1/report
// returns ok:false with a relay_error explaining the deployment is not
// configured for diagnostics; the rest of the Worker is unaffected.
export interface Env {
  SURF_CACHE?: KVNamespace;
  MONITORING_RELAY_URL?: string;
  MONITORING_SECRET?: string;
}

// Minimal KVNamespace surface we use. Avoids needing the full
// @cloudflare/workers-types dep at the call site.
interface KVNamespace {
  get(key: string, type: "json"): Promise<unknown | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void>;
}

// =============================================================================
// Fetcher chains
// =============================================================================

/**
 * NDBC fetcher chain.
 * Order:
 *   1. realtime2  — NOAA's canonical published feed (.txt + .spec). Most
 *                   complete tier-1 source: standard met + wind/atm/water
 *                   when station has those sensors, plus decomposed swell
 *                   vs. wind-wave components from .spec.
 *   2. ndbc_widget — official NOAA fallback. Decomposed swell/wind-wave
 *                   for SoCal nearshore stations; no wind/atm.
 *   3. buoypro    — third-party aggregator. Aggregate fields only (no
 *                   decomposition for SoCal nearshore stations); kept as
 *                   tertiary defense in depth in case both NDBC paths
 *                   degrade simultaneously.
 *
 * Demoted from primary in May 2026: previously buoypro was first because
 * realtime2 wasn't yet wired in. realtime2's .spec exposes decomposition
 * that BuoyPro doesn't, and citing NOAA's canonical published feed is
 * stronger provenance than a third-party mirror.
 */
export const NDBC_FETCHER_CHAIN: UpstreamFetcher[] = [
  ndbcRealtime2Fetcher,
  ndbcWidgetFetcher,
  buoyProFetcher,
];

/**
 * CO-OPS fetcher chain.
 * Currently single-fetcher: the CO-OPS API itself is the verified source per
 * RULE 5. If a future fallback (third-party tide aggregator) is added, it
 * slots in as a second chain entry.
 */
export const COOPS_FETCHER_CHAIN: UpstreamFetcher<TideObservations>[] = [
  coopsApiFetcher,
];

/**
 * METAR fetcher chain (Phase 3).
 * Order: aviationweather.gov JSON primary (fastest to parse, most reliable
 * envelope), aviationweather.gov raw text secondary (same backing data, used
 * if JSON shape changes), NWS api.weather.gov tertiary (independent path —
 * NWS exposes a different copy of the same observation data).
 */
export const METAR_FETCHER_CHAIN: UpstreamFetcher<MetarObservation>[] = [
  aviationWeatherJsonFetcher,
  aviationWeatherRawFetcher,
  nwsObservationsFetcher,
];

/**
 * Forecast-wind fetcher chain (Phase 3).
 * Order: NWS gridpoint primary (best resolution, native km/h units),
 *        NWS hourly secondary (string-format speeds, used if the gridpoint
 *        endpoint has a transient issue but /points still resolves),
 *        Open-Meteo tertiary (independent model, also covers non-NWS regions
 *        where /points 404s).
 *
 * Note: this chain uses ForecastFetcher (lat/lon/time-keyed), not
 * UpstreamFetcher (stationId-keyed). Different interface, different
 * orchestrator helper.
 */
export const FORECAST_WIND_FETCHER_CHAIN: ForecastFetcher[] = [
  nwsGridpointFetcher,
  nwsHourlyFetcher,
  openMeteoFetcher,
];

// =============================================================================
// Station directory
// =============================================================================

export interface StationDirectoryEntry {
  metadata: StationMetadata;
}

/**
 * Hard-coded station directory. Used for metadata enrichment (name, location,
 * operator) when the station is known. Stations not in the directory are still
 * served — the upstream may have data — but with placeholder metadata.
 */
export const STATION_DIRECTORY: Record<string, StationDirectoryEntry> = {
  "ndbc:46221": {
    metadata: {
      id: "46221",
      id_namespace: "ndbc",
      name: "Santa Monica Bay, CA",
      operator: "NOAA NDBC",
      location: {
        latitude: 33.855,
        longitude: -118.633,
        description: "Santa Monica Bay, west of El Segundo, CA",
      },
      type: "buoy",
    },
  },
  "ndbc:46222": {
    metadata: {
      id: "46222",
      id_namespace: "ndbc",
      name: "San Pedro, CA",
      operator: "NOAA NDBC",
      location: {
        latitude: 33.618,
        longitude: -118.317,
        description: "San Pedro, south of Los Angeles Harbor, CA",
      },
      type: "buoy",
    },
  },
  "coops:9410840": {
    metadata: {
      id: "9410840",
      id_namespace: "coops",
      name: "Santa Monica, CA",
      operator: "NOAA CO-OPS",
      location: {
        latitude: 34.0083,
        longitude: -118.5,
        description: "Santa Monica Pier, CA",
      },
      type: "tide_station",
    },
  },
  "icao:KLAX": {
    metadata: {
      id: "KLAX",
      id_namespace: "icao",
      name: "Los Angeles International Airport",
      operator: "FAA/NWS",
      location: {
        latitude: 33.9425,
        longitude: -118.4081,
        description: "Los Angeles, CA",
      },
      type: "metar",
    },
  },
  "icao:KSMO": {
    metadata: {
      id: "KSMO",
      id_namespace: "icao",
      name: "Santa Monica Municipal Airport",
      operator: "FAA/NWS",
      location: {
        latitude: 34.0158,
        longitude: -118.4513,
        description: "Santa Monica, CA",
      },
      type: "metar",
    },
  },
  "icao:KHHR": {
    metadata: {
      id: "KHHR",
      id_namespace: "icao",
      name: "Hawthorne Municipal Airport",
      operator: "FAA/NWS",
      location: {
        latitude: 33.9228,
        longitude: -118.3352,
        description: "Hawthorne, CA",
      },
      type: "metar",
    },
  },
};

function resolveMetadata(
  namespace: IdNamespace,
  stationId: string,
  defaultType: StationMetadata["type"]
): StationMetadata {
  // METAR IDs are case-normalized to upper-case for directory lookup.
  const lookupId = namespace === "icao" ? stationId.toUpperCase() : stationId;
  const directoryKey = `${namespace}:${lookupId}`;
  const entry = STATION_DIRECTORY[directoryKey];
  if (entry) return entry.metadata;
  return {
    id: lookupId,
    id_namespace: namespace,
    name: `Station ${lookupId}`,
    operator: "Unknown",
    location: {
      latitude: 0,
      longitude: 0,
      description: "Location not in directory",
    },
    type: defaultType,
  };
}

// =============================================================================
// Cache layer
// =============================================================================

// TTL strategy:
//   NDBC observation (any upstream)     : 5 min  — buoys post every 30-60 min.
//                                                  On cache hit, the orchestrator
//                                                  re-stamps top-level `fetched_at`
//                                                  to now and recomputes
//                                                  observation.age_seconds and
//                                                  observation.freshness against
//                                                  current time using
//                                                  observation.observed_at as the
//                                                  anchor. Cache age never inflates
//                                                  the freshness band, and the
//                                                  served response always reflects
//                                                  when it left the Worker.
//   CO-OPS tide observations            : 5 min  — bounded by water_level cadence
//                                                  (sensor reports every 6 min).
//                                                  Predictions are bundled into
//                                                  the same response; the shorter
//                                                  envelope TTL is fine since the
//                                                  upstream cost of a re-fetch is
//                                                  trivial (~22KB total per call).
//   METAR observation                   : 30 min — METAR cycle is hourly with
//                                                  optional SPECI mid-hour.
//                                                  30 min keeps responses from
//                                                  going more than 30 min stale
//                                                  inside the "current" band.
//   Forecast-wind                       : 60 min — gridpoint refreshes hourly-ish.
//                                                  60 min keeps cache served while
//                                                  comfortably inside the "current"
//                                                  validity_freshness band (<6h).
//
// On-serve recompute is currently NDBC-only. CO-OPS / METAR / forecast-wind
// have channel-specific freshness models (per-channel for CO-OPS, separate
// validity_freshness for forecast-wind) that don't map cleanly onto a single
// observed_at→now recompute. Their TTLs are short enough that within-window
// staleness on cache hit is bounded acceptably without recompute. If a future
// change wants on-serve recompute for those data classes, the per-namespace
// transform passed into cachedBuild is the extension point.
//
// Cache key shape: v2:station:<namespace>:<id>[:<window>] for stations,
//                  v2:forecast:wind:<rlat>:<rlon>:<rtime> for forecast-wind.
// The v-prefix lets us flush all entries cleanly on a schema-breaking change.
// Window suffix is only used for tide stations where days_requested affects
// response shape. Forecast-wind cache key rounds lat/lon to 3 decimals (~110m)
// and time to the nearest hour to avoid sub-meaningful fragmentation.
//
// Bumped v1→v2 to invalidate any leftover entries from earlier code revisions
// that may have been written without TTL or with longer-than-intended TTL.
// Any orphaned v1:* entries will sit unread until their (possibly long) TTLs
// expire; they are never read again.

const CACHE_KEY_PREFIX = "v2";
const CACHE_TTL_SECONDS = {
  ndbc: 5 * 60,
  coops: 5 * 60,
  metar: 30 * 60,
  forecast_wind: 60 * 60,
} as const;

function cacheKeyForBuoy(namespace: IdNamespace, stationId: string): string {
  return `${CACHE_KEY_PREFIX}:station:${namespace}:${stationId}`;
}

function cacheKeyForTide(
  namespace: IdNamespace,
  stationId: string,
  daysRequested: number
): string {
  return `${CACHE_KEY_PREFIX}:station:${namespace}:${stationId}:d${daysRequested}`;
}

function cacheKeyForMetar(namespace: IdNamespace, stationId: string): string {
  return `${CACHE_KEY_PREFIX}:station:${namespace}:${stationId.toUpperCase()}`;
}

function cacheKeyForForecastWind(
  lat: number,
  lon: number,
  requestedTime: string,
  units: string,
  lookbackHours: number | null
): string {
  // Round lat/lon to 3 decimals (~110 m) to keep cache hot for nearby callers.
  const rlat = lat.toFixed(3);
  const rlon = lon.toFixed(3);
  // Round time to the nearest hour — that's the gridpoint resolution anyway.
  const requestedMs = Date.parse(requestedTime);
  const hourMs = Math.round(requestedMs / (60 * 60 * 1000)) * 60 * 60 * 1000;
  const rtime = new Date(hourMs).toISOString();
  const lookbackPart = lookbackHours !== null ? `:lb${lookbackHours}` : "";
  return `${CACHE_KEY_PREFIX}:forecast:wind:${rlat}:${rlon}:${rtime}:${units}${lookbackPart}`;
}

/**
 * NDBC freshness thresholds. All NDBC fetchers (ndbcRealtime2Fetcher,
 * ndbcWidgetFetcher, buoyProFetcher) carry their own copy of these
 * thresholds. The on-serve recompute below uses these to ensure cached
 * responses get reclassified consistently with what a fresh fetch would
 * produce. If any fetcher's thresholds change, change all four call
 * sites in lockstep — they intentionally match.
 */
const NDBC_FRESHNESS_THRESHOLDS = {
  current_max_hours: 3,
  stale_max_hours: 6,
  gap_max_hours: 24,
} as const;

function ndbcFreshnessFromAge(
  ageSeconds: number
): Observation["freshness"] {
  const hours = ageSeconds / 3600;
  if (hours < NDBC_FRESHNESS_THRESHOLDS.current_max_hours) return "current";
  if (hours < NDBC_FRESHNESS_THRESHOLDS.stale_max_hours) return "stale";
  if (hours < NDBC_FRESHNESS_THRESHOLDS.gap_max_hours) return "gap";
  return "offline";
}

/**
 * Re-stamps a cached BuoyStationResponse for serve.
 *   - Top-level `fetched_at` is set to current time so callers see when the
 *     response left the Worker (not when the cache entry was built).
 *   - `observation.age_seconds` is recomputed as (now - observed_at).
 *   - `observation.freshness` is reclassified from the new age.
 *   - `upstream.fetched_at` and `observation.observed_at` are intentionally
 *     unchanged — those are properties of the underlying data and shouldn't
 *     drift just because the response was served from cache.
 *
 * If the cached response is a "no observation" envelope (chain exhausted at
 * build time), the freshness recompute is skipped and only `fetched_at` is
 * re-stamped.
 *
 * Defends against the bug class where a cache entry written by an earlier
 * code revision (or with an unintended long TTL) is served verbatim and
 * appears confidently-current to callers despite being hours or days old.
 */
function restampBuoyResponseOnServe(
  cached: BuoyStationResponse
): BuoyStationResponse {
  const nowIso = new Date().toISOString();

  if (cached.observation === null) {
    return { ...cached, fetched_at: nowIso };
  }

  const observedMs = Date.parse(cached.observation.observed_at);
  if (Number.isNaN(observedMs)) {
    // Defensive: if observed_at is unparseable, leave the observation block
    // alone but still re-stamp the envelope. The fresh-fetch path would not
    // have produced an unparseable observed_at, so this is a "shouldn't
    // happen" branch — we don't try to repair it here.
    return { ...cached, fetched_at: nowIso };
  }

  const ageSeconds = Math.max(
    0,
    Math.round((Date.parse(nowIso) - observedMs) / 1000)
  );
  const freshness = ndbcFreshnessFromAge(ageSeconds);

  return {
    ...cached,
    fetched_at: nowIso,
    observation: {
      ...cached.observation,
      age_seconds: ageSeconds,
      freshness,
    },
  };
}


/**
 * Fetch a value through the KV cache, building it via `builder` on miss.
 *
 * On cache hit: returns the cached value, optionally passed through
 *   `transformOnHit` to re-stamp serve-time fields (e.g. top-level fetched_at,
 *   recomputed freshness). If `transformOnHit` is omitted, the cached value
 *   is returned as-is.
 * On cache miss: runs the builder, caches the result, returns it.
 * If env.SURF_CACHE is undefined (no binding): falls through to the builder
 * every call, no caching. This makes local dev and test environments work
 * without requiring KV provisioning.
 *
 * Failure responses (where the entire chain failed) are deliberately NOT
 * cached — we want the next request to retry the chain rather than serve
 * a stale "everything is offline" envelope.
 */
async function cachedBuild<T>(
  env: Env,
  cacheKey: string,
  ttlSeconds: number,
  builder: () => Promise<T>,
  shouldCache: (result: T) => boolean,
  transformOnHit?: (cached: T) => T
): Promise<T> {
  if (!env.SURF_CACHE) {
    return builder();
  }

  try {
    const cached = (await env.SURF_CACHE.get(cacheKey, "json")) as T | null;
    if (cached) {
      return transformOnHit ? transformOnHit(cached) : cached;
    }
  } catch {
    // Cache read errors are non-fatal — fall through to builder.
  }

  const fresh = await builder();

  if (shouldCache(fresh)) {
    try {
      await env.SURF_CACHE.put(cacheKey, JSON.stringify(fresh), {
        expirationTtl: ttlSeconds,
      });
    } catch {
      // Cache write errors are non-fatal — return the response anyway.
    }
  }

  return fresh;
}

// =============================================================================
// Buoy response builder (existing Phase 1 contract)
// =============================================================================

export interface GetBuoyArgs {
  namespace: IdNamespace;
  stationId: string;
  chain: UpstreamFetcher[];
  env: Env;
}

export async function getBuoyStationResponse(
  args: GetBuoyArgs
): Promise<BuoyStationResponse> {
  const { namespace, stationId, chain, env } = args;
  const cacheKey = cacheKeyForBuoy(namespace, stationId);

  return cachedBuild<BuoyStationResponse>(
    env,
    cacheKey,
    CACHE_TTL_SECONDS.ndbc,
    () => buildBuoyStationResponse(namespace, stationId, chain),
    (resp) =>
      resp.observation !== null &&
      !resp.warnings.some((w) => w.code === "fallback_chain_exhausted"),
    restampBuoyResponseOnServe
  );
}

async function buildBuoyStationResponse(
  namespace: IdNamespace,
  stationId: string,
  chain: UpstreamFetcher[]
): Promise<BuoyStationResponse> {
  const metadata = resolveMetadata(namespace, stationId, "buoy");
  const fallbackChainTried: UpstreamSource[] = [];
  const warnings: Warning[] = [];

  for (const fetcher of chain) {
    fallbackChainTried.push(fetcher.source);
    try {
      const result = await fetcher.fetch(stationId);
      if (result) {
        if (fallbackChainTried.length > 1) {
          warnings.push({
            code: "fallback_used",
            message: `Primary upstream(s) failed; served from ${fetcher.source}`,
            detail: { tried: fallbackChainTried.slice() },
          });
        }
        if (
          result.observation.freshness === "stale" ||
          result.observation.freshness === "gap"
        ) {
          warnings.push({
            code: "stale_observation",
            message: `Observation is ${result.observation.freshness} (age ${result.observation.age_seconds}s)`,
          });
        }
        if (result.observation.data_quality !== "complete") {
          warnings.push({
            code: "partial_data",
            message: `Observation is ${result.observation.data_quality}; missing: ${result.observation.missing_fields.join(", ")}`,
          });
        }

        return {
          schema_version: SCHEMA_VERSION,
          station: metadata,
          fetched_at: new Date().toISOString(),
          upstream: {
            source: fetcher.source,
            url: result.url,
            fetched_at: result.fetched_at,
            fallback_chain_used: fallbackChainTried.slice(),
          },
          observation: result.observation,
          warnings,
        };
      }
    } catch (err) {
      warnings.push({
        code: "parse_warning",
        message: `Fetcher ${fetcher.source} threw: ${(err as Error).message}`,
      });
    }
  }

  // All fetchers failed.
  warnings.push({
    code: "fallback_chain_exhausted",
    message: "No upstream returned usable data",
    detail: { tried: fallbackChainTried.slice() },
  });

  return {
    schema_version: SCHEMA_VERSION,
    station: metadata,
    fetched_at: new Date().toISOString(),
    upstream: {
      source: chain[0]?.source ?? "buoypro",
      url: "",
      fetched_at: new Date().toISOString(),
      fallback_chain_used: fallbackChainTried.slice(),
    },
    observation: null,
    warnings,
  };
}

// =============================================================================
// Tide response builder (Phase 2)
// =============================================================================

export interface GetTideArgs {
  namespace: IdNamespace;
  stationId: string;
  chain: UpstreamFetcher<TideObservations>[];
  daysRequested: number;
  env: Env;
}

export async function getTideStationResponse(
  args: GetTideArgs
): Promise<TideStationResponse> {
  const { namespace, stationId, chain, daysRequested, env } = args;
  const cacheKey = cacheKeyForTide(namespace, stationId, daysRequested);

  return cachedBuild<TideStationResponse>(
    env,
    cacheKey,
    CACHE_TTL_SECONDS.coops,
    () =>
      buildTideStationResponse(namespace, stationId, chain, daysRequested),
    (resp) =>
      // Cache only if we got at least one usable channel
      resp.observations.water_level !== null ||
      resp.observations.predictions !== null
  );
}

async function buildTideStationResponse(
  namespace: IdNamespace,
  stationId: string,
  chain: UpstreamFetcher<TideObservations>[],
  daysRequested: number
): Promise<TideStationResponse> {
  const metadata = resolveMetadata(namespace, stationId, "tide_station");
  const fallbackChainTried: UpstreamSource[] = [];
  const warnings: Warning[] = [];

  for (const fetcher of chain) {
    fallbackChainTried.push(fetcher.source);
    try {
      const result = await fetcher.fetch(stationId, { daysRequested });
      if (result) {
        const obs = result.observation;

        if (fallbackChainTried.length > 1) {
          warnings.push({
            code: "fallback_used",
            message: `Primary upstream(s) failed; served from ${fetcher.source}`,
            detail: { tried: fallbackChainTried.slice() },
          });
        }

        // Channel-level warnings — surfaced even on the success path so
        // daughter prompts know which channel(s) survived.
        if (obs.water_level === null) {
          warnings.push({
            code: "water_level_unavailable",
            message: "CO-OPS water_level product returned no usable data",
          });
        } else if (
          obs.water_level.freshness === "stale" ||
          obs.water_level.freshness === "gap"
        ) {
          warnings.push({
            code: "stale_observation",
            message: `water_level is ${obs.water_level.freshness} (age ${obs.water_level.age_seconds}s)`,
          });
        }

        if (obs.predictions === null) {
          warnings.push({
            code: "predictions_unavailable",
            message: "CO-OPS predictions product returned no usable data",
          });
        }

        if (obs.cross_check === null) {
          warnings.push({
            code: "cross_check_unavailable",
            message:
              "Cannot compute observed-vs-predicted (one or both input channels missing)",
          });
        }

        return {
          schema_version: SCHEMA_VERSION,
          station: metadata,
          fetched_at: new Date().toISOString(),
          upstream: {
            source: fetcher.source,
            url: result.url,
            fetched_at: result.fetched_at,
            fallback_chain_used: fallbackChainTried.slice(),
          },
          observations: obs,
          warnings,
        };
      }
    } catch (err) {
      warnings.push({
        code: "parse_warning",
        message: `Fetcher ${fetcher.source} threw: ${(err as Error).message}`,
      });
    }
  }

  // All fetchers failed.
  warnings.push({
    code: "fallback_chain_exhausted",
    message: "No upstream returned usable data",
    detail: { tried: fallbackChainTried.slice() },
  });

  return {
    schema_version: SCHEMA_VERSION,
    station: metadata,
    fetched_at: new Date().toISOString(),
    upstream: {
      source: chain[0]?.source ?? "coops_api",
      url: "",
      fetched_at: new Date().toISOString(),
      fallback_chain_used: fallbackChainTried.slice(),
    },
    observations: {
      water_level: null,
      predictions: null,
      cross_check: null,
    },
    warnings,
  };
}

// =============================================================================
// METAR response builder (Phase 3)
// =============================================================================

export interface GetMetarArgs {
  namespace: IdNamespace;             // always "icao" for now
  stationId: string;                  // ICAO code; case-normalized internally
  chain: UpstreamFetcher<MetarObservation>[];
  env: Env;
}

export async function getMetarStationResponse(
  args: GetMetarArgs
): Promise<MetarStationResponse> {
  const { namespace, stationId, chain, env } = args;
  const cacheKey = cacheKeyForMetar(namespace, stationId);

  return cachedBuild<MetarStationResponse>(
    env,
    cacheKey,
    CACHE_TTL_SECONDS.metar,
    () => buildMetarStationResponse(namespace, stationId, chain),
    (resp) =>
      resp.observation !== null &&
      !resp.warnings.some((w) => w.code === "fallback_chain_exhausted")
  );
}

async function buildMetarStationResponse(
  namespace: IdNamespace,
  stationId: string,
  chain: UpstreamFetcher<MetarObservation>[]
): Promise<MetarStationResponse> {
  const metadata = resolveMetadata(namespace, stationId, "metar");
  const fallbackChainTried: UpstreamSource[] = [];
  const warnings: Warning[] = [];

  for (const fetcher of chain) {
    fallbackChainTried.push(fetcher.source);
    try {
      const result = await fetcher.fetch(stationId);
      if (result) {
        if (fallbackChainTried.length > 1) {
          warnings.push({
            code: "fallback_used",
            message: `Primary upstream(s) failed; served from ${fetcher.source}`,
            detail: { tried: fallbackChainTried.slice() },
          });
        }
        if (
          result.observation.freshness === "stale" ||
          result.observation.freshness === "gap"
        ) {
          warnings.push({
            code: "stale_observation",
            message: `Observation is ${result.observation.freshness} (age ${result.observation.age_seconds}s)`,
          });
        }
        if (result.observation.data_quality !== "complete") {
          warnings.push({
            code: "partial_data",
            message: `Observation is ${result.observation.data_quality}; missing: ${result.observation.missing_fields.join(", ")}`,
          });
        }
        // Surface visibility_below_minimum as a non-fatal note when
        // visibility drops below 1 SM — useful for surf condition context
        // (heavy fog often correlates with glassy surface).
        const vsm = result.observation.atmosphere.visibility_sm;
        if (vsm !== null && vsm < 1) {
          warnings.push({
            code: "visibility_below_minimum",
            message: `Visibility is ${vsm} SM`,
          });
        }

        return {
          schema_version: SCHEMA_VERSION,
          station: metadata,
          fetched_at: new Date().toISOString(),
          upstream: {
            source: fetcher.source,
            url: result.url,
            fetched_at: result.fetched_at,
            fallback_chain_used: fallbackChainTried.slice(),
          },
          observation: result.observation,
          warnings,
        };
      }
    } catch (err) {
      warnings.push({
        code: "parse_warning",
        message: `Fetcher ${fetcher.source} threw: ${(err as Error).message}`,
      });
    }
  }

  // Distinguishing "no METAR ever issued" from "METAR exists but unreachable":
  // if every upstream returned 200-but-empty (rather than 4xx/5xx), it's
  // plausibly a "valid ICAO with no METAR program" case. Detecting this
  // perfectly requires per-fetcher signaling we don't currently have; for
  // now, we surface fallback_chain_exhausted and let the caller distinguish
  // by manual lookup if needed. A future iteration can have the fetchers
  // signal "valid identifier but no data" specifically.
  warnings.push({
    code: "fallback_chain_exhausted",
    message: "No upstream returned usable data",
    detail: { tried: fallbackChainTried.slice() },
  });

  return {
    schema_version: SCHEMA_VERSION,
    station: metadata,
    fetched_at: new Date().toISOString(),
    upstream: {
      source: chain[0]?.source ?? "aviationweather_json",
      url: "",
      fetched_at: new Date().toISOString(),
      fallback_chain_used: fallbackChainTried.slice(),
    },
    observation: null,
    warnings,
  };
}

// =============================================================================
// Forecast-wind response builder (Phase 3)
// =============================================================================

export interface GetForecastWindArgs {
  lat: number;
  lon: number;
  requestedTime: string;
  units: "kt" | "mph";
  lookbackHours: number | null;
  chain: ForecastFetcher[];
  env: Env;
}

export async function getForecastWindResponse(
  args: GetForecastWindArgs
): Promise<ForecastWindResponse> {
  const { lat, lon, requestedTime, units, lookbackHours, chain, env } = args;
  const cacheKey = cacheKeyForForecastWind(lat, lon, requestedTime, units, lookbackHours);

  return cachedBuild<ForecastWindResponse>(
    env,
    cacheKey,
    CACHE_TTL_SECONDS.forecast_wind,
    () => buildForecastWindResponse({ lat, lon, requestedTime, units, lookbackHours, chain }),
    (resp) =>
      resp.forecast !== null &&
      !resp.warnings.some((w) => w.code === "fallback_chain_exhausted")
  );
}

async function buildForecastWindResponse(args: {
  lat: number;
  lon: number;
  requestedTime: string;
  units: "kt" | "mph";
  lookbackHours: number | null;
  chain: ForecastFetcher[];
}): Promise<ForecastWindResponse> {
  const { lat, lon, requestedTime, units, lookbackHours, chain } = args;
  const fallbackChainTried: UpstreamSource[] = [];
  const accumulatedWarnings: Warning[] = [];

  const requestBlock: ForecastRequest = {
    lat,
    lon,
    requested_time: requestedTime,
    units,
    ...(lookbackHours !== null ? { lookback_hours: lookbackHours } : {}),
  };

  const fetchArgs: ForecastFetchArgs = {
    lat,
    lon,
    requestedTime,
    units,
    lookbackHours,
  };

  for (const fetcher of chain) {
    fallbackChainTried.push(fetcher.source);
    try {
      const result = await fetcher.fetch(fetchArgs);
      if (result) {
        // Merge fetcher-emitted warnings into the accumulated set.
        accumulatedWarnings.push(...result.warnings);

        if (result.forecast !== null) {
          // Successful forecast — return immediately with full envelope.
          if (fallbackChainTried.length > 1) {
            accumulatedWarnings.push({
              code: "fallback_used",
              message: `Primary upstream(s) failed; served from ${fetcher.source}`,
              detail: { tried: fallbackChainTried.slice() },
            });
          }
          if (result.forecast.data_quality !== "complete") {
            accumulatedWarnings.push({
              code: "partial_data",
              message: `Forecast is ${result.forecast.data_quality}; missing: ${result.forecast.missing_fields.join(", ")}`,
            });
          }

          return {
            schema_version: SCHEMA_VERSION,
            request: requestBlock,
            ...(result.gridpoint ? { gridpoint: result.gridpoint } : {}),
            fetched_at: new Date().toISOString(),
            upstream: {
              source: fetcher.source,
              url: result.url,
              fetched_at: result.fetched_at,
              fallback_chain_used: fallbackChainTried.slice(),
            },
            forecast: result.forecast,
            warnings: accumulatedWarnings,
          };
        }

        // Forecast was null — fetcher resolved coverage but couldn't supply
        // a forecast for the requested time (beyond_forecast_horizon,
        // forecast_too_stale). The fetcher already emitted the appropriate
        // warning. Return that envelope directly rather than falling
        // through — the next upstream will have the same problem.
        if (
          result.warnings.some(
            (w) =>
              w.code === "beyond_forecast_horizon" ||
              w.code === "forecast_too_stale"
          )
        ) {
          return {
            schema_version: SCHEMA_VERSION,
            request: requestBlock,
            ...(result.gridpoint ? { gridpoint: result.gridpoint } : {}),
            fetched_at: new Date().toISOString(),
            upstream: {
              source: fetcher.source,
              url: result.url,
              fetched_at: result.fetched_at,
              fallback_chain_used: fallbackChainTried.slice(),
            },
            forecast: null,
            warnings: accumulatedWarnings,
          };
        }

        // Other null-forecast cases (e.g. no matching time series entry but
        // not classified as horizon-beyond) — fall through to next upstream.
      }
    } catch (err) {
      accumulatedWarnings.push({
        code: "parse_warning",
        message: `Fetcher ${fetcher.source} threw: ${(err as Error).message}`,
      });
    }
  }

  // All fetchers failed.
  accumulatedWarnings.push({
    code: "fallback_chain_exhausted",
    message: "No upstream returned usable forecast data",
    detail: { tried: fallbackChainTried.slice() },
  });

  return {
    schema_version: SCHEMA_VERSION,
    request: requestBlock,
    fetched_at: new Date().toISOString(),
    upstream: {
      source: chain[0]?.source ?? "nws_gridpoint",
      url: "",
      fetched_at: new Date().toISOString(),
      fallback_chain_used: fallbackChainTried.slice(),
    },
    forecast: null,
    warnings: accumulatedWarnings,
  };
}

// =============================================================================
// Backward-compat shim
// =============================================================================

// Phase 1 entry point name kept as an alias so any external caller that
// imported `getStationResponse` (or any nfischbein/Surf-Report-Builder code
// that referenced it) still compiles. New code should call the variant-
// specific builders directly.
export const getStationResponse = getBuoyStationResponse;
