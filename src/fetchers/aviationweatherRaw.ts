// src/fetchers/aviationweatherRaw.ts
//
// Aviation Weather Center raw-text METAR fetcher (secondary upstream).
//
// Endpoint:
//   https://aviationweather.gov/api/data/metar?ids=<ICAO>&format=raw&taf=false&hours=2
//
// Returns plain text — one METAR per line, most-recent first. Parses the
// first line through the shared parser. Used when the JSON variant fails
// (e.g. format change on the server, JSON parse error). The two endpoints
// hit the same backing data, so this is a true format-fallback rather than
// a content-fallback — but if AvWX changes their JSON shape, the raw
// endpoint usually keeps working.
//
// observed_at comes from the parser (DDHHMMZ token in the METAR text)
// since the raw endpoint doesn't carry an envelope obsTime.

import type { UpstreamFetcher, MetarObservation } from "../schema";
import { parseMetar } from "../parsers/metar";
import {
  composeMetarObservation,
  freshnessFromAge,
} from "./aviationweatherJson";

const FETCH_USER_AGENT =
  "Mozilla/5.0 (compatible; SurfReportBuilderBot/1.0; +https://github.com/nfischbein/Surf-Report-Worker)";

const ENDPOINT_BASE = "https://aviationweather.gov/api/data/metar";

export const aviationWeatherRawFetcher: UpstreamFetcher<MetarObservation> = {
  source: "aviationweather_raw",
  async fetch(stationId: string) {
    const id = stationId.toUpperCase();
    const url = `${ENDPOINT_BASE}?ids=${encodeURIComponent(id)}&format=raw&taf=false&hours=2`;
    const fetchedAt = new Date().toISOString();

    const response = await fetch(url, {
      headers: {
        "user-agent": FETCH_USER_AGENT,
        accept: "text/plain",
      },
    });

    if (!response.ok) {
      return null;
    }

    const body = (await response.text()).trim();
    if (body.length === 0) {
      return null;
    }

    // First non-empty line is the most recent METAR.
    const firstLine = body.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    if (!firstLine) {
      return null;
    }

    let parsed;
    try {
      parsed = parseMetar(firstLine);
    } catch {
      return null;
    }

    const observedAt = parsed.observed_at;
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
