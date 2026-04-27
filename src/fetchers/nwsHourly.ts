// src/fetchers/nwsHourly.ts
//
// NWS hourly forecast-wind fetcher (secondary upstream).
//
// Endpoint:
//   GET https://api.weather.gov/gridpoints/<office>/<x>,<y>/forecast/hourly
//
// Hits the same /points endpoint as nwsGridpoint to resolve lat/lon, then
// fetches the human-friendly hourly forecast (the one used by weather.gov's
// website hourly view) instead of the raw gridded values.
//
// This is a fallback rather than a primary because:
//   - The hourly forecast is itself derived from the gridded forecast.
//     If the gridded endpoint is broken, the hourly endpoint usually is too.
//   - Shape is more limited (windSpeed is a string like "15 mph" rather
//     than a numeric km/h — we have to parse it).
//
// Used when nws_gridpoint fails for reasons other than coverage. If the
// /points lookup itself failed in nws_gridpoint, this fetcher will likely
// fail the same way; the orchestrator will then fall through to open_meteo.

import {
  validityFreshnessFromAge,
  type ForecastFetcher,
  type ForecastFetchArgs,
  type ForecastFetcherResult,
} from "./nwsGridpoint";
import type { Warning, WindForecast } from "../schema";

const FETCH_USER_AGENT =
  "(SurfReportBuilderBot/1.0, https://github.com/nfischbein/Surf-Report-Worker)";

const POINTS_BASE = "https://api.weather.gov/points";

interface NwsPointsResponse {
  properties?: {
    forecastHourly?: string;       // Direct URL — preferred over reconstructing
    gridId?: string;
    gridX?: number;
    gridY?: number;
    relativeLocation?: {
      properties?: { city?: string; state?: string };
      geometry?: { coordinates?: [number, number] };
    };
  };
}

interface NwsHourlyResponse {
  properties?: {
    updateTime?: string;
    periods?: Array<{
      number?: number;
      startTime?: string;          // ISO 8601 with timezone offset
      endTime?: string;
      windSpeed?: string;          // e.g. "15 mph" or "10 to 15 mph"
      windGust?: string;           // e.g. "20 mph" — sometimes absent
      windDirection?: string;      // e.g. "WSW"
    }>;
  };
}

export const nwsHourlyFetcher: ForecastFetcher = {
  source: "nws_hourly",
  async fetch(args: ForecastFetchArgs): Promise<ForecastFetcherResult | null> {
    const { lat, lon, requestedTime, units, lookbackHours } = args;
    const fetchedAt = new Date().toISOString();
    const warnings: Warning[] = [];

    // Step 1: resolve lat/lon to office and pull the forecastHourly URL.
    const pointsUrl = `${POINTS_BASE}/${lat.toFixed(4)},${lon.toFixed(4)}`;
    const pointsResp = await fetch(pointsUrl, {
      headers: { "user-agent": FETCH_USER_AGENT, accept: "application/geo+json" },
    });
    if (!pointsResp.ok) return null;

    let points: NwsPointsResponse;
    try {
      points = (await pointsResp.json()) as NwsPointsResponse;
    } catch {
      return null;
    }

    const hourlyUrl = points.properties?.forecastHourly;
    const office = points.properties?.gridId;
    const gridX = points.properties?.gridX;
    const gridY = points.properties?.gridY;
    if (!hourlyUrl || !office || gridX === undefined || gridY === undefined) {
      return null;
    }

    const relCoords = points.properties?.relativeLocation?.geometry?.coordinates;
    const resolvedLat = relCoords?.[1] ?? lat;
    const resolvedLon = relCoords?.[0] ?? lon;
    const description = formatDescription(points);

    // Step 2: pull the hourly forecast.
    const hourlyResp = await fetch(hourlyUrl, {
      headers: { "user-agent": FETCH_USER_AGENT, accept: "application/geo+json" },
    });
    if (!hourlyResp.ok) return null;

    let hourly: NwsHourlyResponse;
    try {
      hourly = (await hourlyResp.json()) as NwsHourlyResponse;
    } catch {
      return null;
    }

    const updateTime = hourly.properties?.updateTime;
    const periods = hourly.properties?.periods ?? [];
    if (!updateTime || periods.length === 0) return null;

    const issuedAt = new Date(updateTime).toISOString();
    const issuanceAgeSeconds = Math.max(
      0,
      Math.round((Date.parse(fetchedAt) - Date.parse(issuedAt)) / 1000)
    );

    if (lookbackHours !== null && issuanceAgeSeconds > lookbackHours * 3600) {
      warnings.push({
        code: "forecast_too_stale",
        message: `Hourly forecast issuance is ${issuanceAgeSeconds}s old; lookback threshold ${lookbackHours}h`,
      });
      return {
        forecast: null,
        url: hourlyUrl,
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

    // Find the period that covers the requested time.
    const targetMs = Date.parse(requestedTime);
    if (Number.isNaN(targetMs)) return null;

    const matchingPeriod = periods.find((p) => {
      if (!p.startTime || !p.endTime) return false;
      const startMs = Date.parse(p.startTime);
      const endMs = Date.parse(p.endTime);
      return targetMs >= startMs && targetMs < endMs;
    });

    if (!matchingPeriod) {
      // Out of range — beyond horizon or before the first period.
      const lastPeriod = periods[periods.length - 1];
      if (lastPeriod?.endTime && targetMs > Date.parse(lastPeriod.endTime)) {
        warnings.push({
          code: "beyond_forecast_horizon",
          message: `Requested time ${requestedTime} is beyond hourly forecast horizon (ends ${lastPeriod.endTime})`,
        });
      }
      return {
        forecast: null,
        url: hourlyUrl,
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

    const speedMph = parseSpeedString(matchingPeriod.windSpeed);
    const gustMph = parseSpeedString(matchingPeriod.windGust);
    const directionDeg = compassToDeg(matchingPeriod.windDirection);

    // NWS hourly returns mph; convert to kt or keep mph based on caller.
    const speedKt = speedMph !== null ? Math.round(speedMph * 0.868976) : 0;
    const gustKt = gustMph !== null ? Math.round(gustMph * 0.868976) : null;
    const speedReturned = units === "mph" ? speedMph ?? 0 : speedKt;
    const gustReturned = units === "mph" ? gustMph : gustKt;

    let variable = false;
    if (directionDeg === null) {
      variable = true;
      warnings.push({
        code: "forecast_wind_variable",
        message: "Hourly forecast direction is not parseable as a compass cardinal",
      });
    }

    const validAt = new Date(Date.parse(matchingPeriod.startTime!)).toISOString();
    const requestedToValidOffsetSeconds = Math.round(
      (Date.parse(validAt) - Date.parse(requestedTime)) / 1000
    );

    const missingFields: string[] = [];
    if (gustMph === null) missingFields.push("wind.gust_kt");
    if (variable) missingFields.push("wind.direction_deg");

    const dataQuality =
      missingFields.length === 0
        ? "complete"
        : speedMph !== null
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
      url: hourlyUrl,
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
// Parsing helpers
// =============================================================================

/**
 * Parse a string like "15 mph" or "10 to 15 mph". Returns the upper bound
 * in mph, or null if unparseable. NWS often gives a range; the upper bound
 * is the safer call for surf-condition planning (you'd plan around the
 * higher wind, not the lower).
 */
export function parseSpeedString(raw: string | undefined): number | null {
  if (!raw) return null;
  // Match all numbers in the string and take the largest. Handles "15 mph",
  // "10 to 15 mph", "10-15 mph".
  const numbers = Array.from(raw.matchAll(/\d+/g)).map((m) => parseInt(m[0], 10));
  if (numbers.length === 0) return null;
  return Math.max(...numbers);
}

const COMPASS_DEG: Record<string, number> = {
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

export function compassToDeg(raw: string | undefined): number | null {
  if (!raw) return null;
  const upper = raw.trim().toUpperCase();
  if (upper in COMPASS_DEG) {
    return Math.round(COMPASS_DEG[upper]);
  }
  return null;
}

function formatDescription(points: NwsPointsResponse): string {
  const city = points.properties?.relativeLocation?.properties?.city;
  const state = points.properties?.relativeLocation?.properties?.state;
  if (city && state) return `${city}, ${state}`;
  if (city) return city;
  return "NWS gridpoint";
}

// Helper exported for tests / debugging.
export const _internal = {
  parseSpeedString,
  compassToDeg,
};
