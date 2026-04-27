// src/index.ts
//
// Entry point. Routes /v1/station/<namespace>/<id> and /v1/forecast/wind to
// the orchestrator. Other paths return a small service-info JSON.
//
// Phase 1: NDBC buoys via /v1/station/ndbc/<id>.
// Phase 2: CO-OPS tide stations via /v1/station/coops/<id>?days=<1-7>.
// Phase 3: METAR observations via /v1/station/icao/<id>.
//          Forecast wind via /v1/forecast/wind?lat=&lon=&time=&units=&lookback=.

import {
  getBuoyStationResponse,
  getTideStationResponse,
  getMetarStationResponse,
  getForecastWindResponse,
  NDBC_FETCHER_CHAIN,
  COOPS_FETCHER_CHAIN,
  METAR_FETCHER_CHAIN,
  FORECAST_WIND_FETCHER_CHAIN,
  type Env,
} from "./orchestrator";
import { SCHEMA_VERSION, type IdNamespace } from "./schema";

const SERVICE_INFO = {
  service: "surf-report-worker",
  version: "0.0.5",
  schema_version: SCHEMA_VERSION,
  endpoints: [
    "/v1/station/ndbc/<id>",
    "/v1/station/coops/<id>?days=<1-7>",
    "/v1/station/icao/<id>",
    "/v1/forecast/wind?lat=<lat>&lon=<lon>&time=<ISO>[&units=kt|mph][&lookback=<hours>]",
  ],
  supported_namespaces: ["ndbc", "coops", "icao"],
  notes:
    "Phase 3 — buoy + tide + METAR + forecast-wind support. International namespaces (ukmo, bom) reserved.",
};

const SUPPORTED_NAMESPACES: IdNamespace[] = ["ndbc", "coops", "icao"];

// CO-OPS predictions window bounds.
const COOPS_DAYS_MIN = 1;
const COOPS_DAYS_MAX = 7;
const COOPS_DAYS_DEFAULT = 2;

// Forecast-wind lookback bounds (in hours). Caller-provided cap on issuance age.
const FORECAST_LOOKBACK_MIN = 1;
const FORECAST_LOOKBACK_MAX = 24;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, ""); // strip trailing slash

    // /v1/station/<namespace>/<id>
    const stationMatch = path.match(
      /^\/v1\/station\/([a-z]+)\/([A-Za-z0-9_-]+)$/
    );
    if (stationMatch) {
      const [, namespace, stationId] = stationMatch;

      if (!SUPPORTED_NAMESPACES.includes(namespace as IdNamespace)) {
        return jsonResponse(
          {
            error: "unsupported_namespace",
            namespace,
            supported: SUPPORTED_NAMESPACES,
            note: "International namespaces (ukmo, bom) are reserved but not yet implemented.",
          },
          400
        );
      }

      if (namespace === "ndbc") {
        const response = await getBuoyStationResponse({
          namespace: "ndbc",
          stationId,
          chain: NDBC_FETCHER_CHAIN,
          env,
        });
        return jsonResponse(response, 200);
      }

      if (namespace === "coops") {
        const daysParam = url.searchParams.get("days");
        const daysParsed = parseDaysParam(daysParam);
        if (daysParsed.error) {
          return jsonResponse(
            {
              error: "invalid_days",
              days: daysParam,
              valid_range: `${COOPS_DAYS_MIN}-${COOPS_DAYS_MAX}`,
              detail: daysParsed.error,
            },
            400
          );
        }

        const response = await getTideStationResponse({
          namespace: "coops",
          stationId,
          chain: COOPS_FETCHER_CHAIN,
          daysRequested: daysParsed.days,
          env,
        });
        return jsonResponse(response, 200);
      }

      if (namespace === "icao") {
        const response = await getMetarStationResponse({
          namespace: "icao",
          stationId,
          chain: METAR_FETCHER_CHAIN,
          env,
        });
        return jsonResponse(response, 200);
      }

      // Unreachable given SUPPORTED_NAMESPACES check above, but keeps the
      // type checker honest.
      return jsonResponse(
        { error: "unsupported_namespace", namespace },
        400
      );
    }

    // /v1/forecast/wind
    if (path === "/v1/forecast/wind") {
      const parsed = parseForecastWindParams(url.searchParams);
      if (parsed.error) {
        return jsonResponse(
          { error: parsed.error.code, detail: parsed.error.message },
          400
        );
      }
      const response = await getForecastWindResponse({
        lat: parsed.lat,
        lon: parsed.lon,
        requestedTime: parsed.requestedTime,
        units: parsed.units,
        lookbackHours: parsed.lookbackHours,
        chain: FORECAST_WIND_FETCHER_CHAIN,
        env,
      });
      return jsonResponse(response, 200);
    }

    // Service info on root.
    if (path === "" || path === "/") {
      return jsonResponse(SERVICE_INFO, 200);
    }

    return jsonResponse({ error: "not_found", path: url.pathname }, 404);
  },
};

// =============================================================================
// Param parsing
// =============================================================================

interface ParsedDays {
  days: number;
  error: string | null;
}

function parseDaysParam(raw: string | null): ParsedDays {
  if (raw === null || raw === "") {
    return { days: COOPS_DAYS_DEFAULT, error: null };
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    return {
      days: 0,
      error: `days must be an integer; got ${JSON.stringify(raw)}`,
    };
  }
  if (n < COOPS_DAYS_MIN || n > COOPS_DAYS_MAX) {
    return {
      days: 0,
      error: `days must be between ${COOPS_DAYS_MIN} and ${COOPS_DAYS_MAX}; got ${n}`,
    };
  }
  return { days: n, error: null };
}

interface ForecastWindParseSuccess {
  lat: number;
  lon: number;
  requestedTime: string;
  units: "kt" | "mph";
  lookbackHours: number | null;
  error: null;
}

interface ForecastWindParseFailure {
  error: { code: string; message: string };
  // Filler fields required by union-narrowing; never read on failure path.
  lat: 0;
  lon: 0;
  requestedTime: "";
  units: "kt";
  lookbackHours: null;
}

type ForecastWindParseResult = ForecastWindParseSuccess | ForecastWindParseFailure;

function parseForecastWindParams(
  params: URLSearchParams
): ForecastWindParseResult {
  const fail = (code: string, message: string): ForecastWindParseFailure => ({
    error: { code, message },
    lat: 0,
    lon: 0,
    requestedTime: "",
    units: "kt",
    lookbackHours: null,
  });

  const latRaw = params.get("lat");
  const lonRaw = params.get("lon");
  const timeRaw = params.get("time");
  const unitsRaw = params.get("units");
  const lookbackRaw = params.get("lookback");

  if (!latRaw) return fail("missing_lat", "lat parameter is required");
  if (!lonRaw) return fail("missing_lon", "lon parameter is required");
  if (!timeRaw) return fail("missing_time", "time parameter is required");

  const lat = Number(latRaw);
  if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
    return fail("invalid_lat", `lat must be a finite number between -90 and 90; got ${JSON.stringify(latRaw)}`);
  }
  const lon = Number(lonRaw);
  if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
    return fail("invalid_lon", `lon must be a finite number between -180 and 180; got ${JSON.stringify(lonRaw)}`);
  }

  const requestedMs = Date.parse(timeRaw);
  if (Number.isNaN(requestedMs)) {
    return fail("invalid_time", `time must be a valid ISO 8601 datetime; got ${JSON.stringify(timeRaw)}`);
  }
  // RULE 2 spec says `time` must be in the future. Allow a small clock-skew
  // grace period (5 minutes) for callers whose clocks are near-equal-to-now.
  const now = Date.now();
  if (requestedMs < now - 5 * 60 * 1000) {
    return fail("invalid_time", `time must be in the future; got ${timeRaw}`);
  }
  const requestedTime = new Date(requestedMs).toISOString();

  let units: "kt" | "mph" = "kt";
  if (unitsRaw !== null) {
    if (unitsRaw !== "kt" && unitsRaw !== "mph") {
      return fail("invalid_units", `units must be 'kt' or 'mph'; got ${JSON.stringify(unitsRaw)}`);
    }
    units = unitsRaw;
  }

  let lookbackHours: number | null = null;
  if (lookbackRaw !== null && lookbackRaw !== "") {
    const n = Number(lookbackRaw);
    if (!Number.isInteger(n) || n < FORECAST_LOOKBACK_MIN || n > FORECAST_LOOKBACK_MAX) {
      return fail("invalid_lookback", `lookback must be an integer between ${FORECAST_LOOKBACK_MIN} and ${FORECAST_LOOKBACK_MAX}; got ${JSON.stringify(lookbackRaw)}`);
    }
    lookbackHours = n;
  }

  return {
    lat,
    lon,
    requestedTime,
    units,
    lookbackHours,
    error: null,
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "cache-control": "no-store",
    },
  });
}
