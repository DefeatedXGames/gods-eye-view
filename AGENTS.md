# Base44 Dev Environment — God's Eye View

## What this is
A Vite + Cesium 3D-globe intelligence console. Single-origin: the Vite dev
server serves the browser app **and** the `/api/*` provider proxies (server
middleware in `server/providers/local.js`). No separate backend process.

## Running it
```
docker compose -f docker-compose.base44.yml up -d
```
- Web entry point on host port **3000** (mapped from Vite's PORT=3000).
- `node:24` base image; source bind-mounted at `/app`; `npm ci` runs on start,
  then `npm run dev` (Vite live reload).
- `HOST=0.0.0.0` makes Vite's `allowedHosts` resolve to `true` (accepts the
  rotating sandbox host).
- `GEV_ALLOW_FRAMING=true` opts out of the `X-Frame-Options: DENY` /
  `frame-ancestors 'none'` headers so the app can render in the preview iframe.
  Default behavior (without the flag) still denies framing.
- `PUPPETEER_SKIP_DOWNLOAD=true` skips the Chromium download (puppeteer is a
  devDependency used only by QA scripts).

## Keys
**All provider API keys are optional.** The app boots keyless on Esri World
Imagery with keyless terrain; OSM is the fallback. Flights (anonymous OpenSky),
satellites, earthquakes, public cameras, radio, and launches work without keys.

Optional external credentials (none required at boot):
- `GOOGLE_MAPS_API_KEY` — photorealistic 3D tiles + place search (client-exposed)
- `CESIUM_ION_TOKEN` — Cesium ion-hosted Google 3D / terrain (client-exposed)
- `OPENAI_API_KEY` — realtime voice control
- `AISSTREAM_API_KEY` — live AIS vessels
- `FIRMS_MAP_KEY` — NASA active fires
- `TOMTON_API_KEY` / `GOOGLE_MAPS_SERVER_API_KEY` — see `.env.example`

To add real keys, set them via the Base44 secrets dashboard (delivered to
`/run/base44/app.env`); the in-app **POWER UP** panel can also write a repo
`.env` for you.

## Verifying it works
- `curl -sS -o /dev/null -w "%{http_code}" http://localhost:3000/` → `200`
- `docker compose -f docker-compose.base44.yml ps` → `healthy`
- The served page is live source (Vite dev server), not a prebuilt bundle.

## Notes
- Node engine requires `>=24.14.0 <25 || >=26 <27`; `node:24` satisfies it.
- `npm run doctor` reports Node/provider readiness (optional, not required).
- The `.env.base44-defaults` file holds non-secret defaults (listed first in
  `env_file` so real secrets override them).
