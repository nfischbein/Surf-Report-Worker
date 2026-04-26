// src/orchestrator.ts
//
// Walks a chain of upstream fetchers in priority order, returning the first
// usable result wrapped in the StationResponse envelope.
//
// Phase 1 chain: [buoyProFetcher, ndbcWidgetFetcher]
// SurfTruths is intentionally not included; in practice its data is wave-only
// and partly redundant with the two above. Could be added later as a third-tier
// fallback if needed.

import type {
  StationResponse,
  StationMetadata,
  UpstreamFetcher,
  UpstreamSource,
  Warning,
} from "./schema";
import { SCHEMA_VERSION } from "./schema";
import { buoyProFetcher } from "./fetchers/buoypro";
import { ndbcWidgetFetcher } from "./fetchers/ndbcWidget";

export interface StationDirectoryEntry {
  metadata: StationMetadata;
}

/**
 * Default fetcher chain for NDBC stations.
 *
 * Order: BuoyPro first (most complete, JSON time-series with embedded timestamps),
 *        NDBC widget second (official, decomposed swell + wind-wave components).
 */
export const NDBC_FETCHER_CHAIN: UpstreamFetcher[] = [
  buoyProFetcher,
  ndbcWidgetFetcher,
];

/**
 * Phase 1 station directory.
 *
 * Hard-coded for now. Phase 2+ may move this to KV or D1, or autofill
 * from the upstream response. For Phase 1 testing we just need El Porto's
 * known buoys.
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
};

export async function getStationResponse(args: {
  namespace: string;
  stationId: string;
  chain: UpstreamFetcher[];
}): Promise<StationResponse> {
  const { namespace, stationId, chain } = args;

  const directoryKey = `${namespace}:${stationId}`;
  const directoryEntry = STATION_DIRECTORY[directoryKey];

  // Default metadata when the station isn't in our directory yet — better
  // than refusing the request, since the upstream may still have it.
  const metadata: StationMetadata = directoryEntry?.metadata ?? {
    id: stationId,
    id_namespace: namespace as StationMetadata["id_namespace"],
    name: `Station ${stationId}`,
    operator: "Unknown",
    location: {
      latitude: 0,
      longitude: 0,
      description: "Location not in directory",
    },
    type: "buoy",
  };

  const fallbackChainTried: UpstreamSource[] = [];
  const warnings: Warning[] = [];

  for (const fetcher of chain) {
    fallbackChainTried.push(fetcher.source);
    try {
      const result = await fetcher.fetch(stationId);
      if (result) {
        // Build warnings BEFORE constructing the response so the returned
        // object isn't relying on shared-reference mutation.
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

        const response: StationResponse = {
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

        return response;
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
      // No upstream actually served data. Use the first chain member as a
      // formal placeholder; consumers should rely on observation === null
      // and the fallback_chain_exhausted warning, not the upstream block,
      // when interpreting failure responses.
      source: chain[0]?.source ?? "buoypro",
      url: "",
      fetched_at: new Date().toISOString(),
      fallback_chain_used: fallbackChainTried.slice(),
    },
    observation: null,
    warnings,
  };
}
