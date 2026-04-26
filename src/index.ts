// src/index.ts
//
// Entry point. Routes /v1/station/<namespace>/<id> to the orchestrator.
// Other paths return a small service-info JSON.

import { getStationResponse, NDBC_FETCHER_CHAIN } from "./orchestrator";
import { SCHEMA_VERSION } from "./schema";

const SERVICE_INFO = {
  service: "surf-report-worker",
  version: "0.0.3",
  schema_version: SCHEMA_VERSION,
  endpoints: ["/v1/station/<namespace>/<id>"],
  supported_namespaces: ["ndbc"],
  notes: "Phase 1 — buoy support only. Tide and METAR support pending.",
};

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, ""); // strip trailing slash

    // /v1/station/<namespace>/<id>
    const stationMatch = path.match(
      /^\/v1\/station\/([a-z]+)\/([A-Za-z0-9_-]+)$/
    );
    if (stationMatch) {
      const [, namespace, stationId] = stationMatch;

      // Phase 1: only ndbc namespace is supported.
      if (namespace !== "ndbc") {
        return jsonResponse(
          {
            error: "unsupported_namespace",
            namespace,
            supported: ["ndbc"],
            note: "Phase 1 supports NDBC buoys only.",
          },
          400
        );
      }

      const response = await getStationResponse({
        namespace,
        stationId,
        chain: NDBC_FETCHER_CHAIN,
      });
      return jsonResponse(response, 200);
    }

    // Service info on root.
    if (path === "" || path === "/") {
      return jsonResponse(SERVICE_INFO, 200);
    }

    return jsonResponse(
      { error: "not_found", path: url.pathname },
      404
    );
  },
};

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
