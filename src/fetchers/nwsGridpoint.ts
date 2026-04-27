// src/fetchers/nwsGridpoint.ts
//
// NWS gridded forecast-wind fetcher (primary upstream).
//
// Two-step lookup:
//   1. POINTS: GET https://api.weather.gov/points/<lat>,<lon>
//      Returns the gridpoint identifier (office + x + y) for the lat/lon.
//   2. GRIDPOINT: GET https://api.weather.gov/gridpoints/<office>/<x>,<y>
//      Returns the full gridded forecast across many fields, including
//      windSpeed, windDirection, windGust as time-series.
//
// The gridpoint forecast updates roughly hourly and provides hourly-or-better
// resolution for most fields. We extract the wind values valid at the
// requested time by walking the time-series and finding the entry whose
// validTime span contains the requested time.
//
// The points response also tells us the office's location info (city,
// state, distance from query point). We expose the resolved gridpoint in
// the response so callers can trace coverage.
//
// Failure paths handled here:
//   - HTTP non-2xx on either step → return null
//   - Lat/lon outside CONUS-or-territories coverage → /points returns 404 →
//     return null (orchestrator falls through to nws_hourly, then open_meteo)
//   - Gridpoint forecast missing wind series → return null
//   - Requested time beyond the forecast horizon → return a special result
//     with `forecast: null` and a `beyond_forecast_horizon` warning so the
//     orchestrator can surface it without continuing to fall through.
//
// observedAt vs validity: this is a forecast, not an observation. The
// returned Forecast has:
//   - issued_at: gridpoint properties.updateTime (when the model run was published)
//   - valid_at:  the time the wind value applies to (resolved from validTime)

import type {
  UpstreamFetcher,
  FetchContext,
  WindForecast,
  ValidityFreshness,
  Warning,
} from "../schema";

const FETCH_USER_AGENT =
  "(SurfReportBuilderBot/1.0, https://github.com/nfischbein/Surf-Report-Worker)";

const POINTS_BASE = "https://api.weather.gov/points";
const GRIDPOINT_BASE = "https://api.weather.gov/gridpoints";

// Distance threshold above which we attach gridpoint_distance_warning.
// 3 km matches the v1.2 spec's note that this is "rare, but worth surfacing
// for breaks near coverage edges."
const GRIDPOINT_DISTANCE_THRESHOLD_M = 3000;

// =============================================================================
// Result envelope
// =============================================================================
//
// The forecast-wind fetchers diverge from the station fetchers' contract:
// they take lat/lon/time instead of stationId, and they return additional
// metadata (resolved gridpoint, warnings) that the orchestrator weaves into
// the top-level ForecastWindResponse. To keep the orchestrator's chain-walker
// generic, we define a shared ForecastFetcher interface and a
// ForecastFetchResult envelope here.

export interface ForecastFetcherResult {
  forecast: WindForecast | null;
  url: string;
  fetched_at: string;
  // Optional gridpoint metadata — only set when an NWS upstream served.
  gridpoint?: {
    id_namespace: "nws_gridpoint";
    office: string;
    x: number;
    y: number;
    location: { latitude: number; longitude: number; description: string };
  };
  // Fetcher-emitted warnings that the orchestrator should propagate. Used for
  // beyond_forecast_horizon, gridpoint_distance_warning, forecast_wind_variable.
  warnings: Warning[];
}

export interface ForecastFetcher {
  source: "nws_gridpoint" | "nws_hourly" | "open_meteo";
  fetch(args: ForecastFetchArgs): Promise<ForecastFetcherResult | null>;
}

export interface ForecastFetchArgs {
  lat: number;
  lon: number;
  requestedTime: string;          // ISO 8601, must be in the future
  units: "kt" | "mph";
  lookbackHours: number | null;   // when set, refuse if issuance older than this
}

// =============================================================================
// Points endpoint response (subset)
// =============================================================================

interface NwsPointsResponse {
  properties?: {
    gridId?: string;          // office, e.g. "LOX"
    gridX?: number;
    gridY?: number;
    relativeLocation?: {
      properties?: {
        city?: string;
        state?: string;
        distance?: { value?: number; unitCode?: string };
      };
      geometry?: {
        coordinates?: [number, number];  // [lon, lat]
      };
    };
  };
}

// =============================================================================
// Gridpoint endpoint response (subset — we extract only wind series)
// =============================================================================

interface NwsTimeSeriesEntry {
  validTime: string;          // ISO 8601 + ISO 8601 duration, e.g. "2026-04-27T06:00:00+00:00/PT1H"
  value: number | null;
}

interface NwsGridpointResponse {
  properties?: {
    updateTime?: string;      // ISO 8601 — when the model run was published
    forecastOffice?: string;  // URL like "https://api.weather.gov/offices/LOX"
    windSpeed?: { uom?: string; values?: NwsTimeSeriesEntry[] };
    windDirection?: { uom?: string; values?: NwsTimeSeriesEntry[] };
    windGust?: { uom?: string; values?: NwsTimeSeriesEntry[] };
  };
}

// =============================================================================
// Fetcher
// =============================================================================

export const nwsGridpointFetcher: ForecastFetcher = {
  source: "nws_gridpoint",
  async fetch(args: ForecastFetchArgs): Promise<ForecastFetcherResult | null> {
    const { lat, lon, requestedTime, units, lookbackHours } = args;
    const fetchedAt = new Date().toISOString();
    const warnings: Warning[] = [];

    // Step 1: resolve lat/lon to gridpoint.
    const pointsUrl = `${POINTS_BASE}/${formatCoord(lat)},${formatCoord(lon)}`;
    const pointsResp = await fetch(pointsUrl, {
      headers: { "user-agent": FETCH_USER_AGENT, accept: "application/geo+json" },
    });
    if (!pointsResp.ok) {
      return null;
    }

    let pointsBody: NwsPointsResponse;
    try {
      pointsBody = (await pointsResp.json()) as NwsPointsResponse;
    } catch {
      return null;
    }

    const props = pointsBody?.properties;
    if (!props?.gridId || typeof props.gridX !== "number" || typeof props.gridY !== "number") {
      return null;
    }

    const office = props.gridId;
    const gridX = props.gridX;
    const gridY = props.gridY;

    // Distance warning — relativeLocation gives city centroid distance, which
    // is a proxy for gridpoint-to-query distance. Not exact but good enough
    // for the "near coverage edge" signal.
    const distanceM = extractDistanceMeters(props);
    if (distanceM !== null && distanceM > GRIDPOINT_DISTANCE_THRESHOLD_M) {
      warnings.push({
        code: "gridpoint_distance_warning",
        message: `Resolved gridpoint is ${Math.round(distanceM)} m from requested point`,
        detail: { distance_m: distanceM },
      });
    }

    const relCoords = props.relativeLocation?.geometry?.coordinates;
    const resolvedLat = relCoords?.[1] ?? lat;
    const resolvedLon = relCoords?.[0] ?? lon;
    const description = formatLocationDescription(props);

    // Step 2: fetch the gridpoint forecast.
    const gridpointUrl = `${GRIDPOINT_BASE}/${encodeURIComponent(office)}/${gridX},${gridY}`;
    const gridpointResp = await fetch(gridpointUrl, {
      headers: { "user-agent": FETCH_USER_AGENT, accept: "application/geo+json" },
    });
    if (!gridpointResp.ok) {
      return null;
    }

    let gridpointBody: NwsGridpointResponse;
    try {
      gridpointBody = (await gridpointResp.json()) as NwsGridpointResponse;
    } catch {
      return null;
    }

    const gridProps = gridpointBody?.properties;
    if (!gridProps?.updateTime) {
      return null;
    }

    const issuedAt = new Date(gridProps.updateTime).toISOString();
    const issuanceAgeSeconds = Math.max(
      0,
      Math.round((Date.parse(fetchedAt) - Date.parse(issuedAt)) / 1000)
    );

    // Lookback enforcement.
    if (lookbackHours !== null && issuanceAgeSeconds > lookbackHours * 3600) {
      warnings.push({
        code: "forecast_too_stale",
        message: `Gridpoint issuance is ${issuanceAgeSeconds}s old; lookback threshold ${lookbackHours}h`,
      });
      return {
        forecast: null,
        url: gridpointUrl,
        fetched_at: fetchedAt,
        gridpoint: {
          id_namespace: "nws_gridpoint",
          office,
          x: gridX,
          y: gridY,
          location: { latitude: resolvedLat, longitude: resolvedLon, description },
        },
        warnings,
      };
    }

    const validityFreshness = validityFreshnessFromAge(issuanceAgeSeconds);

    // Resolve the requested time within wind series.
    const speedSeries = gridProps.windSpeed?.values ?? [];
    const directionSeries = gridProps.windDirection?.values ?? [];
    const gustSeries = gridProps.windGust?.values ?? [];

    const speedEntry = findTimeSeriesEntry(speedSeries, requestedTime);
    const directionEntry = findTimeSeriesEntry(directionSeries, requestedTime);
    const gustEntry = findTimeSeriesEntry(gustSeries, requestedTime);

    if (!speedEntry) {
      // No wind speed for the requested time — could be beyond horizon.
      const horizonEnd = lastEntryEndTime(speedSeries);
      if (horizonEnd && Date.parse(requestedTime) > Date.parse(horizonEnd)) {
        warnings.push({
          code: "beyond_forecast_horizon",
          message: `Requested time ${requestedTime} is beyond gridpoint forecast horizon (ends ${horizonEnd})`,
        });
      }
      return {
        forecast: null,
        url: gridpointUrl,
        fetched_at: fetchedAt,
        gridpoint: {
          id_namespace: "nws_gridpoint",
          office,
          x: gridX,
          y: gridY,
          location: { latitude: resolvedLat, longitude: resolvedLon, description },
        },
        warnings,
      };
    }

    // Resolve units. NWS gridpoint reports wind speed in km/h ("wmoUnit:km_h-1")
    // and direction in degrees true ("wmoUnit:degree_(angle)"). Convert.
    const speedKmh = speedEntry.entry.value;
    const speedKt = speedKmh !== null ? Math.round(speedKmh * 0.539957) : 0;
    const speedReturned = units === "mph" && speedKmh !== null
      ? Math.round(speedKmh * 0.621371)
      : speedKt;

    let directionDeg: number | null = null;
    let variable = false;
    if (directionEntry?.entry.value !== null && directionEntry?.entry.value !== undefined) {
      directionDeg = Math.round(directionEntry.entry.value) % 360;
    } else {
      // Some NWS gridpoint responses use a null direction for variable wind.
      variable = true;
      warnings.push({
        code: "forecast_wind_variable",
        message: "Gridpoint forecast direction is variable at the resolved valid time",
      });
    }

    const gustKmh = gustEntry?.entry.value ?? null;
    const gustKt = gustKmh !== null ? Math.round(gustKmh * 0.539957) : null;
    const gustReturned = units === "mph" && gustKmh !== null
      ? Math.round(gustKmh * 0.621371)
      : gustKt;

    const validAt = speedEntry.startISO;
    const requestedToValidOffsetSeconds = Math.round(
      (Date.parse(validAt) - Date.parse(requestedTime)) / 1000
    );

    const missingFields: string[] = [];
    if (gustKmh === null) missingFields.push("wind.gust_kt");
    if (variable) missingFields.push("wind.direction_deg");

    const dataQuality =
      missingFields.length === 0
        ? "complete"
        : speedKmh !== null
          ? "partial"
          : "degraded";

    const forecast: WindForecast = {
      issued_at: issuedAt,
      issuance_age_seconds: issuanceAgeSeconds,
      valid_at: validAt,
      requested_to_valid_offset_seconds: requestedToValidOffsetSeconds,
      validity_freshness: validityFreshness,
      data_quality: dataQuality,
      missing_fields: missingFields,
      wind: {
        direction_deg: directionDeg,
        speed_kt: speedReturned,
        gust_kt: gustReturned,
      },
    };

    return {
      forecast,
      url: gridpointUrl,
      fetched_at: fetchedAt,
      gridpoint: {
        id_namespace: "nws_gridpoint",
        office,
        x: gridX,
        y: gridY,
        location: { latitude: resolvedLat, longitude: resolvedLon, description },
      },
      warnings,
    };
  },
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Format a coordinate to 4 decimal places — NWS /points accepts this and
 * returns 404 for over-precise inputs.
 */
function formatCoord(n: number): string {
  return n.toFixed(4);
}

/**
 * Find the time-series entry whose validTime span contains `targetISO`.
 * NWS validTime is ISO 8601 + ISO 8601 duration: "2026-04-27T06:00:00+00:00/PT1H"
 */
export function findTimeSeriesEntry(
  series: NwsTimeSeriesEntry[],
  targetISO: string
): { entry: NwsTimeSeriesEntry; startISO: string } | null {
  const targetMs = Date.parse(targetISO);
  if (Number.isNaN(targetMs)) return null;

  for (const entry of series) {
    const span = parseValidTime(entry.validTime);
    if (!span) continue;
    if (targetMs >= span.startMs && targetMs < span.endMs) {
      return { entry, startISO: span.startISO };
    }
  }
  return null;
}

interface ValidTimeSpan {
  startMs: number;
  endMs: number;
  startISO: string;
}

/**
 * Parse a validTime field like "2026-04-27T06:00:00+00:00/PT1H" into a
 * span. Supports duration formats PT#H, PT#M, P#DT#H — what NWS actually
 * returns is mostly PT1H, occasionally PT2H or larger for low-resolution
 * fields.
 */
export function parseValidTime(raw: string): ValidTimeSpan | null {
  const slashIdx = raw.indexOf("/");
  if (slashIdx === -1) return null;

  const startStr = raw.slice(0, slashIdx);
  const durationStr = raw.slice(slashIdx + 1);

  const startMs = Date.parse(startStr);
  if (Number.isNaN(startMs)) return null;

  const durationMs = parseDurationMs(durationStr);
  if (durationMs === null) return null;

  return {
    startMs,
    endMs: startMs + durationMs,
    startISO: new Date(startMs).toISOString(),
  };
}

/**
 * Parse an ISO 8601 duration like P#DT#H#M into milliseconds. Limited to the
 * subset NWS uses (days, hours, minutes — no months or years).
 */
function parseDurationMs(raw: string): number | null {
  const match = raw.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/);
  if (!match) return null;
  const days = parseInt(match[1] ?? "0", 10);
  const hours = parseInt(match[2] ?? "0", 10);
  const minutes = parseInt(match[3] ?? "0", 10);
  if (days === 0 && hours === 0 && minutes === 0) return null;
  return ((days * 24 + hours) * 60 + minutes) * 60 * 1000;
}

/**
 * Find the end-time of the latest entry in a time series, for
 * beyond_forecast_horizon detection.
 */
function lastEntryEndTime(series: NwsTimeSeriesEntry[]): string | null {
  if (series.length === 0) return null;
  const last = series[series.length - 1];
  const span = parseValidTime(last.validTime);
  return span ? new Date(span.endMs).toISOString() : null;
}

function extractDistanceMeters(props: NwsPointsResponse["properties"]): number | null {
  const distance = props?.relativeLocation?.properties?.distance;
  if (!distance) return null;
  const value = distance.value;
  if (typeof value !== "number") return null;
  // unitCode is typically "wmoUnit:m"; assume meters if not otherwise specified.
  return value;
}

function formatLocationDescription(props: NwsPointsResponse["properties"]): string {
  const city = props?.relativeLocation?.properties?.city;
  const state = props?.relativeLocation?.properties?.state;
  if (city && state) return `${city}, ${state}`;
  if (city) return city;
  return "NWS gridpoint";
}

export function validityFreshnessFromAge(ageSeconds: number): ValidityFreshness {
  // RULE 3 forecast bands: <6h current, 6-12 stale, 12-24 gap, >24 offline.
  const hours = ageSeconds / 3600;
  if (hours < 6) return "current";
  if (hours < 12) return "stale";
  if (hours < 24) return "gap";
  return "offline";
}

// Helper exported for tests / debugging.
export const _internal = {
  findTimeSeriesEntry,
  parseValidTime,
  validityFreshnessFromAge,
};
