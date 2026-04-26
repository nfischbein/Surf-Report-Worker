// src/orchestrator.ts
//
// Walks a chain of upstream fetchers in priority order, returning the first
// usable result wrapped in the StationResponse envelope.
//
// Phase 1 only has the BuoyPro fetcher in the chain. NDBC widget and SurfTruths
// will be added in subsequent commits.

import type {
  StationResponse,
  StationMetadata,
  UpstreamFetcher,
  Warning,
} from "./schema";
import { SCHEMA_VERSION } from "./schema";

export interface StationDirectoryEntry {
  metadata: StationMetadata;
}

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

  const fallbackChainTried: string[] = [];
  const warnings: Warning[] = [];

  for (const fetcher of chain) {
    fallbackChainTried.push(fetcher.source);
    try {
      const result = await fetcher.fetch(stationId);
      if (result) {
        const response: StationResponse = {
          schema_version: SCHEMA_VERSION,
          station: metadata,
          fetched_at: new Date().toISOString(),
          upstream: {
            source: fetcher.source,
            url: result.url,
            fetched_at: result.fetched_at,
            fallback_chain_used: fallbackChainTried as Warning["code"][] as never,
            // (the cast above is a workaround for the chain field type;
            //  see note in README. We'll tighten this later.)
          },
          observation: result.observation,
          warnings,
        };

        // Add warnings based on what we got.
        if (fallbackChainTried.length > 1) {
          warnings.push({
            code: "fallback_used",
            message: `Primary upstream(s) failed; served from ${fetcher.source}`,
            detail: { tried: fallbackChainTried },
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
    detail: { tried: fallbackChainTried },
  });

  return {
    schema_version: SCHEMA_VERSION,
    station: metadata,
    fetched_at: new Date().toISOString(),
    upstream: {
      source: "buoypro",
      url: "",
      fetched_at: new Date().toISOString(),
      fallback_chain_used: [],
    },
    observation: null,
    warnings,
  };
}