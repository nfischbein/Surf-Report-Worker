// src/fetchers/nwsObservations.ts
//
// NWS api.weather.gov METAR fetcher (tertiary upstream).
//
// Endpoint:
//   https://api.weather.gov/stations/<ICAO>/observations/latest
//
// Used when both aviationweather.gov endpoints fail. NWS exposes a different
// copy of the same observation data (the data ultimately originates with the
// same source — NWS observation programs feed into aviationweather.gov), so
// this is an independent path rather than an independent source.
//
// Response is GeoJSON. The METAR text lives at properties.rawMessage when
// present. When NWS hasn't received the latest observation yet, rawMessage
// may be empty/missing — return null so we don't construct a partial response.
//
// NWS requires a User-Agent identifying the requester per their access policy.

import type { UpstreamFetcher, MetarObservation } from "../schema";
import { parseMetar } from "../parsers/metar";
import {
  composeMetarObservation,
  freshnessFromAge,
} from "./aviationweatherJson";

const FETCH_USER_AGENT =
  "(SurfReportBuilderBot/1.0, https://github.com/nfischbein/Surf-Report-Worker)";

const ENDPOINT_BASE = "https://api.weather.gov/stations";

interface NwsObservationResponse {
  properties?: {
    rawMessage?: string;
    timestamp?: string; // ISO 8601 UTC
  };
}

export const nwsObservationsFetcher: UpstreamFetcher<MetarObservation> = {
  source: "nws_observations",
  async fetch(stationId: string) {
    const id = stationId.toUpperCase();
    const url = `${ENDPOINT_BASE}/${encodeURIComponent(id)}/observations/latest`;
    const fetchedAt = new Date().toISOString();

    const response = await fetch(url, {
      headers: {
        // NWS access policy requests a User-Agent identifying the requester
        // and recommends the parenthesized form.
        "user-agent": FETCH_USER_AGENT,
        accept: "application/geo+json",
      },
    });

    if (!response.ok) {
      return null;
    }

    let payload: NwsObservationResponse;
    try {
      payload = (await response.json()) as NwsObservationResponse;
    } catch {
      return null;
    }

    const rawMessage = payload?.properties?.rawMessage;
    if (!rawMessage || typeof rawMessage !== "string" || rawMessage.length === 0) {
      return null;
    }

    let parsed;
    try {
      parsed = parseMetar(rawMessage);
    } catch {
      return null;
    }

    // Prefer NWS envelope timestamp when present — like aviationweather's
    // obsTime, it's authoritative on month boundaries.
    const observedAt =
      typeof payload?.properties?.timestamp === "string"
        ? new Date(payload.properties.timestamp).toISOString()
        : parsed.observed_at;

    const ageSeconds = Math.max(
      0,
      Math.round((Date.parse(fetchedAt) - Date.parse(observedAt)) / 1000)
    );
    const freshness = freshnessFromAge(ageSeconds);

    const observation = composeMetarObservation({
      observedAt,
      ageSeconds,
      freshness,
      parsed,
    });

    return {
      observation,
      url,
      fetched_at: fetchedAt,
    };
  },
};
