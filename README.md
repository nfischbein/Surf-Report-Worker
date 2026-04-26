# Surf-Report-Worker

Backend service for the [AI Surf Report Builder](https://github.com/nfischbein/Surf-Report-Builder).

Fetches upstream marine data (NDBC buoys, NOAA tide stations, METAR wind reports) server-side and serves clean normalized JSON to AI daughter prompts. Server-side fetching avoids the JS-rendered-page and stale-cache failures that plague AI runtime fetchers.

**Status:** Phase 1 in progress. NDBC buoy support working — `/v1/station/ndbc/<id>` returns waves, period, direction, and water temperature parsed from BuoyPro. Tide and METAR support pending.

## Architecture

Reactive cache (cache infrastructure pending). Worker fetches upstream sources on demand, normalizes to a versioned JSON schema (`/v1/station/<namespace>/<id>`). No active-station list, no scheduled pre-fetching.

Each upstream source is implemented as a plug-in fetcher module that conforms to a single `UpstreamFetcher` interface. The orchestrator walks the fetcher chain in priority order and returns the first usable result, with provenance and warnings in the response.

## Schema

See `src/schema.ts` for the canonical TypeScript types. Current schema version: `1.0`.

## Deploy your own

(Deployment instructions will be filled in once Phase 1 ships.)

## License

MIT
