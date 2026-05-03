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
import {
  SCHEMA_VERSION,
  type IdNamespace,
  type DiagnosticPayload,
  type DiagnosticResponse,
  DIAGNOSTIC_RUNTIMES,
  DIAGNOSTIC_REPORT_TYPES,
  DIAGNOSTIC_CONFIDENCE_VALUES,
  DIAGNOSTIC_FETCH_PATHS,
  DIAGNOSTIC_LIMITS,
} from "./schema";

const SERVICE_INFO = {
  service: "surf-report-worker",
  version: "0.0.7",
  schema_version: SCHEMA_VERSION,
  endpoints: [
    "/v1/station/ndbc/<id>",
    "/v1/station/coops/<id>?days=<1-7>",
    "/v1/station/icao/<id>",
    "/v1/forecast/wind?lat=<lat>&lon=<lon>&time=<ISO>[&units=kt|mph][&lookback=<hours>]",
    "/v1/report (POST, diagnostic relay; see schema.ts DiagnosticPayload)",
  ],
  supported_namespaces: ["ndbc", "coops", "icao"],
  notes:
    "Phase 3 — buoy + tide + METAR + forecast-wind support. International namespaces (ukmo, bom) reserved. /v1/report relays anonymous diagnostic payloads to a central monitoring sheet.",
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

    // /v1/report — diagnostic relay
    if (path === "/v1/report") {
      if (request.method !== "POST") {
        return jsonResponse(
          { error: "method_not_allowed", detail: "POST required" },
          405
        );
      }
      const response = await handleDiagnosticReport(request, env);
      // Always 200; the body's `ok` field tells the caller what happened.
      // This matches the Apps Script's behavior and avoids cases where a
      // daughter prompt's HTTP-error handling masks a clean validation
      // rejection that the LLM should be able to inspect.
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

// =============================================================================
// Diagnostic relay (/v1/report)
// =============================================================================
//
// Daughter prompts POST a DiagnosticPayload here after rendering a report.
// The Worker validates and normalizes the payload, then relays to the central
// Apps Script using MONITORING_RELAY_URL + MONITORING_SECRET held as Wrangler
// secrets. The endpoint is open inbound (no caller secret) — same risk profile
// as the rest of the Worker. Daily volume is bounded by the Apps Script cap;
// duplicates are deduped by run_id at the Apps Script.
//
// Privacy: the Worker does not pass through cf-connecting-ip, User-Agent, or
// any other request-derived identifier to the relay. Only the validated
// payload fields are forwarded.

async function handleDiagnosticReport(
  request: Request,
  env: Env
): Promise<DiagnosticResponse> {
  if (!env.MONITORING_RELAY_URL || !env.MONITORING_SECRET) {
    return {
      ok: false,
      received_at: null,
      relay_status: "relay_error",
      error: "diagnostic relay is not configured on this Worker deployment",
    };
  }

  let raw: unknown;
  try {
    raw = await request.json();
  } catch (err) {
    return {
      ok: false,
      received_at: null,
      relay_status: "validation_error",
      error: "invalid JSON body",
    };
  }

  const validation = validateDiagnosticPayload(raw);
  if (validation.error) {
    return {
      ok: false,
      received_at: null,
      relay_status: "validation_error",
      error: validation.error,
    };
  }

  const relayBody = JSON.stringify({
    monitoring_secret: env.MONITORING_SECRET,
    data: validation.payload,
  });

  let relayResponseText: string;
  try {
    const relayResponse = await fetch(env.MONITORING_RELAY_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: relayBody,
      // Cloudflare's fetch follows redirects by default, which handles the
      // Apps Script 302 from script.google.com to script.googleusercontent.com
      // automatically. The body is read on the original POST before redirect,
      // so the redirect-as-GET is safe.
    });
    relayResponseText = await relayResponse.text();
  } catch (err) {
    return {
      ok: false,
      received_at: null,
      relay_status: "relay_error",
      error: `relay fetch failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let relayJson: {
    ok?: boolean;
    received_at?: string;
    duplicate?: boolean;
    error?: string;
  };
  try {
    relayJson = JSON.parse(relayResponseText);
  } catch (err) {
    return {
      ok: false,
      received_at: null,
      relay_status: "relay_error",
      error: "relay returned non-JSON response",
    };
  }

  if (relayJson.ok === false) {
    return {
      ok: false,
      received_at: null,
      relay_status: "relay_error",
      error: relayJson.error ?? "relay rejected the payload",
    };
  }

  if (relayJson.duplicate) {
    return {
      ok: true,
      received_at: null,
      relay_status: "duplicate",
    };
  }

  return {
    ok: true,
    received_at: relayJson.received_at ?? null,
    relay_status: "ok",
  };
}

interface DiagnosticValidationResult {
  payload: DiagnosticPayload;
  error: string | null;
}

function validateDiagnosticPayload(raw: unknown): DiagnosticValidationResult {
  const fail = (msg: string): DiagnosticValidationResult => ({
    payload: {} as DiagnosticPayload,
    error: msg,
  });

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return fail("body must be a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  // run_id — required, length-capped, no enum.
  const runIdRaw = readString(obj.run_id);
  if (!runIdRaw) return fail("run_id is required");
  const run_id = runIdRaw.slice(0, DIAGNOSTIC_LIMITS.RUN_ID_MAX);

  // report_type — strict enum.
  const reportTypeRaw = readString(obj.report_type);
  if (!reportTypeRaw) return fail("report_type is required");
  if (!(DIAGNOSTIC_REPORT_TYPES as readonly string[]).includes(reportTypeRaw)) {
    return fail(
      `invalid report_type: ${JSON.stringify(reportTypeRaw)}; must be one of ${DIAGNOSTIC_REPORT_TYPES.join(", ")}`
    );
  }
  const report_type = reportTypeRaw as typeof DIAGNOSTIC_REPORT_TYPES[number];

  // confidence — strict enum.
  const confidenceRaw = readString(obj.confidence);
  if (!confidenceRaw) return fail("confidence is required");
  if (!(DIAGNOSTIC_CONFIDENCE_VALUES as readonly string[]).includes(confidenceRaw)) {
    return fail(
      `invalid confidence: ${JSON.stringify(confidenceRaw)}; must be one of ${DIAGNOSTIC_CONFIDENCE_VALUES.join(", ")}`
    );
  }
  const confidence = confidenceRaw as typeof DIAGNOSTIC_CONFIDENCE_VALUES[number];

  // runtime — lenient enum, falls back to "other".
  const runtimeRaw = readString(obj.runtime) ?? "";
  const runtime = (DIAGNOSTIC_RUNTIMES as readonly string[]).includes(runtimeRaw)
    ? (runtimeRaw as typeof DIAGNOSTIC_RUNTIMES[number])
    : "other";

  // fetch_path — lenient enum, falls back to "unknown".
  const fetchPathRaw = readString(obj.fetch_path) ?? "";
  const fetch_path = (DIAGNOSTIC_FETCH_PATHS as readonly string[]).includes(fetchPathRaw)
    ? (fetchPathRaw as typeof DIAGNOSTIC_FETCH_PATHS[number])
    : "unknown";

  // kit_version — required, length-capped.
  const kitVersionRaw = readString(obj.kit_version);
  if (!kitVersionRaw) return fail("kit_version is required");
  const kit_version = kitVersionRaw.slice(0, DIAGNOSTIC_LIMITS.KIT_VERSION_MAX);

  // break_name — required, length-capped.
  const breakNameRaw = readString(obj.break_name);
  if (!breakNameRaw) return fail("break_name is required");
  const break_name = breakNameRaw.slice(0, DIAGNOSTIC_LIMITS.BREAK_NAME_MAX);

  // data_gaps — optional, length-capped, may be empty string.
  const data_gaps = (readString(obj.data_gaps) ?? "").slice(0, DIAGNOSTIC_LIMITS.DATA_GAPS_MAX);

  // deviation_notes — optional, length-capped, may be empty string.
  const deviation_notes = (readString(obj.deviation_notes) ?? "").slice(
    0,
    DIAGNOSTIC_LIMITS.DEVIATION_NOTES_MAX
  );

  return {
    payload: {
      run_id,
      kit_version,
      runtime,
      report_type,
      break_name,
      confidence,
      fetch_path,
      data_gaps,
      deviation_notes,
    },
    error: null,
  };
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
