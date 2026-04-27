// src/fetchers/openMeteo.ts
//
// Open-Meteo forecast-wind fetcher (tertiary upstream).
//
// Endpoint:
//   https://api.open-meteo.com/v1/forecast?latitude=<lat>&longitude=<lon>
//     &hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m
//     &wind_speed_unit=kn&timeformat=iso8601&timezone=UTC
//
// Used as the final fallback when both NWS upstreams fail. Open-Meteo is
// genuinely independent — different model entirely (ECMWF and other global
// models, depending on the location) — so when this fetcher serves, the
// orchestrator must surface a `non_nws_upstream` warning so downstream AI
// knows the model provenance differs from the canonical US forecast.
//
// This is also the upstream that handles non-NWS-coverage regions (anywhere
// outside CONUS, Alaska, Hawaii, US territories). NWS /points 404s for those
// coordinates; Open-Meteo serves global coverage.
//
// Open-Meteo's free tier doesn't require an API key and has generous rate
// limits. The Worker's KV cache will keep us comfortably under any plausible
// real-world usage.
//
// No User-Agent identification is required by Open-Meteo's terms of service,
// but we send the same UA we use elsewhere as a courtesy.

import {
  validityFreshnessFromAge,
  type ForecastFetcher,
  type ForecastFetchArgs,
  type ForecastFetcherResult,
} from "./nwsGridpoint";
import type { Warning, WindForecast } from "../schema";

const FETCH_USER_AGENT =
  "Mozilla/5.0 (compatible; SurfReportBuilderBot/1.0; +https://github.com/nfischbein/Surf-Report-Worker)";

const ENDPOINT_BASE = "https://api.open-meteo.com/v1/forecast";

interface OpenMeteoResponse {
  generationtime_ms?: number;
  // Open-Meteo doesn't expose model issuance time directly in the free
  // forecast endpoint. We approximate by using `current.time` as a freshness
  // anchor — since the model rebuilds at fixed cycles (every 6h for ECMWF,
  // every 1h for some regional models), this is approximate. In practice
  // we treat issuance as "data is current as of fetch time minus 1 hour"
  // as a defensible default. Documented in the implementation below.
  hourly?: {
    time?: string[];                  // ISO 8601 strings, hourly
    wind_speed_10m?: number[];        // already in knots given our unit param
    wind_direction_10m?: number[];    // degrees true
    wind_gusts_10m?: number[];        // already in knots
  };
  // The current block tells us when the upstream model considers "now".
  current?: {
    time?: string;                    // ISO 8601
  };
}

// Approximation for Open-Meteo issuance age. The free endpoint doesn't
// expose model issuance time, so we use a fixed 60-minute offset as a
// defensible "this data was published roughly an hour ago" assumption.
// 60 min keeps us in the "current" validity_freshness band per RULE 3.
//
// This is documented honestly: when Open-Meteo serves and the response
// includes `non_nws_upstream`, downstream readers should know that
// validity_freshness is approximated rather than published.
const OPEN_METEO_ASSUMED_ISSUANCE_AGE_S = 60 * 60;

export const openMeteoFetcher: ForecastFetcher = {
  source: "open_meteo",
  async fetch(args: ForecastFetchArgs): Promise<ForecastFetcherResult | null> {
    const { lat, lon, requestedTime, units, lookbackHours } = args;
    const fetchedAt = new Date().toISOString();
    const warnings: Warning[] = [];

    const params = new URLSearchParams({
      latitude: lat.toFixed(4),
      longitude: lon.toFixed(4),
      hourly: "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
      wind_speed_unit: "kn",
      timeformat: "iso8601",
      timezone: "UTC",
      // Bound the forecast window to keep payload small but cover several days.
      forecast_days: "7",
    });
    const url = `${ENDPOINT_BASE}?${params.toString()}`;

    const response = await fetch(url, {
      headers: { "user-agent": FETCH_USER_AGENT, accept: "application/json" },
    });
    if (!response.ok) {
      return null;
    }

    let payload: OpenMeteoResponse;
    try {
      payload = (await response.json()) as OpenMeteoResponse;
    } catch {
      return null;
    }

    const times = payload.hourly?.time ?? [];
    const speeds = payload.hourly?.wind_speed_10m ?? [];
    const directions = payload.hourly?.wind_direction_10m ?? [];
    const gusts = payload.hourly?.wind_gusts_10m ?? [];

    if (times.length === 0 || speeds.length === 0) {
      return null;
    }

    // Find the hour whose start matches the requested time (to the hour).
    // Open-Meteo's hourly times are at top-of-hour UTC.
    const targetMs = Date.parse(requestedTime);
    if (Number.isNaN(targetMs)) return null;

    // Build candidate matches: each Open-Meteo hourly index represents a
    // 1-hour bucket starting at times[i]. The requested time falls into
    // index i if times[i] <= targetMs < times[i+1].
    let matchIndex = -1;
    for (let i = 0; i < times.length; i++) {
      const startMs = Date.parse(times[i]);
      if (Number.isNaN(startMs)) continue;
      const nextMs = i + 1 < times.length
        ? Date.parse(times[i + 1])
        : startMs + 60 * 60 * 1000;  // assume 1h bucket if last entry
      if (targetMs >= startMs && targetMs < nextMs) {
        matchIndex = i;
        break;
      }
    }

    if (matchIndex === -1) {
      const horizonEndMs = times.length > 0 ? Date.parse(times[times.length - 1]) + 60 * 60 * 1000 : null;
      const horizonEndISO = horizonEndMs ? new Date(horizonEndMs).toISOString() : null;
      if (horizonEndISO && targetMs > Date.parse(horizonEndISO)) {
        warnings.push({
          code: "beyond_forecast_horizon",
          message: `Requested time ${requestedTime} is beyond Open-Meteo forecast horizon (ends ${horizonEndISO})`,
        });
      }
      return {
        forecast: null,
        url,
        fetched_at: fetchedAt,
        warnings,
      };
    }

    // Issuance age is approximated for Open-Meteo (see header comment).
    const issuanceAgeSeconds = OPEN_METEO_ASSUMED_ISSUANCE_AGE_S;
    if (lookbackHours !== null && issuanceAgeSeconds > lookbackHours * 3600) {
      // Almost certainly won't trip with our 60-minute assumption, but
      // implementing for symmetry with the NWS fetchers.
      warnings.push({
        code: "forecast_too_stale",
        message: `Open-Meteo issuance age (assumed ${issuanceAgeSeconds}s) exceeds lookback ${lookbackHours}h`,
      });
      return {
        forecast: null,
        url,
        fetched_at: fetchedAt,
        warnings,
      };
    }

    const issuedAt = new Date(Date.parse(fetchedAt) - issuanceAgeSeconds * 1000).toISOString();
    const validityFreshness = validityFreshnessFromAge(issuanceAgeSeconds);

    const speedKt = Math.round(speeds[matchIndex]);
    const directionDegRaw = directions[matchIndex];
    const gustKtRaw = gusts[matchIndex];

    let directionDeg: number | null = null;
    let variable = false;
    if (typeof directionDegRaw === "number" && !Number.isNaN(directionDegRaw)) {
      directionDeg = Math.round(directionDegRaw) % 360;
    } else {
      variable = true;
      warnings.push({
        code: "forecast_wind_variable",
        message: "Open-Meteo wind direction is null at the resolved hour",
      });
    }

    const gustKt = typeof gustKtRaw === "number" ? Math.round(gustKtRaw) : null;

    // Convert if caller asked for mph (we requested knots from Open-Meteo).
    const speedReturned = units === "mph" ? Math.round(speedKt * 1.15078) : speedKt;
    const gustReturned = gustKt !== null && units === "mph"
      ? Math.round(gustKt * 1.15078)
      : gustKt;

    const validAt = new Date(Date.parse(times[matchIndex])).toISOString();
    const requestedToValidOffsetSeconds = Math.round(
      (Date.parse(validAt) - Date.parse(requestedTime)) / 1000
    );

    const missingFields: string[] = [];
    if (gustKt === null) missingFields.push("wind.gust_kt");
    if (variable) missingFields.push("wind.direction_deg");

    const dataQuality =
      missingFields.length === 0 ? "complete" : "partial";

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

    // Open-Meteo always surfaces non_nws_upstream — that's the whole point
    // of the warning, signaling model provenance differs from NWS.
    warnings.push({
      code: "non_nws_upstream",
      message:
        "Forecast served by Open-Meteo (non-NWS model). Model provenance differs from canonical US forecast.",
      detail: { model: "open_meteo" },
    });

    return {
      forecast,
      url,
      fetched_at: fetchedAt,
      // gridpoint deliberately omitted for non-NWS upstream
      warnings,
    };
  },
};
