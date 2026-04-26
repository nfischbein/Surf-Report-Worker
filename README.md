# Surf-Report-Worker

Backend service for the [AI Surf Report Builder](https://github.com/nfischbein/Surf-Report-Builder).

Fetches upstream marine data (NDBC buoys, NOAA tide stations, METAR wind reports) server-side and serves clean normalized JSON to AI daughter prompts. Server-side fetching avoids the JS-rendered-page and stale-cache failures that plague AI runtime fetchers.

**Status:** Phase 1 — buoy support in progress. Not yet ready for general use.

## Architecture

Reactive cache. Worker fetches upstream sources on demand, normalizes to a versioned JSON schema (`/v1/station/<id>`), caches with TTL. No active-station list, no scheduled pre-fetching.

## Deploy your own

(Deployment instructions will be filled in once Phase 1 ships.)

## License

MIT