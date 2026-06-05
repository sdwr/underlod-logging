# underlod-logging

Telemetry backend and dashboard for [UNDERLOD](https://github.com/sdwr/underlod-items).

- **Worker** (`src/`): Cloudflare Worker that accepts NDJSON crash + gameplay events from the game and stores them in R2. Read API gated by a Bearer token.
- **Dashboard** (`dashboard/`): static HTML/JS deployed to GitHub Pages. Prompts for the worker URL + token on load, fetches events, renders simple charts.

## Security model

| What | Where | Public? |
|---|---|---|
| Worker source | this repo | yes |
| Worker URL | shipped in the game binary | effectively yes |
| `POST /ingest` | open to the world | yes — that's how the game writes |
| `GET /events`, `GET /days` | requires `Authorization: Bearer <DASHBOARD_TOKEN>` | no |
| `DASHBOARD_TOKEN` | Cloudflare Worker secret + your dashboard localStorage | no |
| R2 bucket contents | only readable through the worker | no |
| Dashboard HTML/JS | GitHub Pages | yes (no secrets in it) |

The token never lives in the repo or in the deployed Pages site — you paste it into the dashboard once per device and it's kept in `localStorage`. Anyone hitting the dashboard URL without it sees an empty page asking for credentials.

Data being collected is already sanitized client-side (no user paths, no PII), but you still keep it private because random anonymous gameplay data isn't useful to anyone but you.

## Setup

### 1. Create the R2 bucket

```bash
npx wrangler r2 bucket create underlod-logging
```

The binding is already configured in [wrangler.jsonc](wrangler.jsonc).

### 2. Set the dashboard token

Generate a long random string (e.g. `openssl rand -base64 32`) and store it as a worker secret:

```bash
npx wrangler secret put DASHBOARD_TOKEN
# paste the string when prompted
```

Save the token somewhere — you'll paste it into the dashboard once per browser.

### 3. Deploy the worker

```bash
npm install
npx wrangler deploy
```

Wrangler prints a URL like `https://underlod-logging.<your-subdomain>.workers.dev`. That's the ingest endpoint.

### 4. Point the game at it

In the UNDERLOD repo, edit [`crash_log.lua`](https://github.com/sdwr/underlod-items/blob/main/underlod/crash_log.lua):

```lua
CrashLog.URL = "https://underlod-logging.<your-subdomain>.workers.dev/ingest"
```

Also ship `lua-https` with the LÖVE build — without it the HTTPS POST silently fails. Grab the prebuilt binaries from [github.com/love2d/lua-https/releases](https://github.com/love2d/lua-https/releases).

### 5. Enable GitHub Pages

1. Push this repo to GitHub.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The first push to `main` (or manual run of the *Deploy dashboard* workflow) publishes `dashboard/` to `https://sdwr.github.io/underlod-logging/`.

### 6. Open the dashboard

Visit `https://sdwr.github.io/underlod-logging/`. Paste in:
- the worker URL (same one you put in `crash_log.lua`, without `/ingest`)
- the `DASHBOARD_TOKEN` from step 2

Click refresh. Token stays in this browser's localStorage until you click "forget".

## Endpoints

```
POST /ingest               body: NDJSON, one event per line. open.
GET  /events               returns latest 100 files of events. auth.
GET  /events?day=YYYY-MM-DD&limit=N    auth.
GET  /days                 returns list of days with events. auth.
GET  /health               status string. open.
```

Limits: 200 KB per POST, 200 files per `/events` read.

## Event schema

Every event is one JSON object on one line:

```json
{
  "type": "crash" | "buy_screen_end" | "level_end",
  "game": "UNDERLOD",
  "version": "0.1.0",
  "install": "<random uuid, persists per install>",
  "run": "<random uuid, persists per run>",
  "time": "2026-06-05T18:30:42Z",
  "os": "Windows" | "Linux" | "OS X",
  "love_version": "11.3.0",
  "data": { ... }
}
```

`data` varies by `type`:

- **crash**: `{ message, traceback }`
- **buy_screen_end**: `{ level, loop, ng_plus, difficulty, gold, times_rerolled, units: [{character, level, items: [6]}], passives, perks }`
- **level_end**: `{ outcome: "win"|"loss"|"run_complete", level, loop, ng_plus, difficulty, time_elapsed, gold, units, damage_dealt, damage_taken, boss? }`

## Local development

```bash
npx wrangler dev
# worker on http://localhost:8787
```

For the dashboard, just open `dashboard/index.html` in a browser, or serve it:

```bash
cd dashboard && python -m http.server 8000
# http://localhost:8000
```

When testing locally, point the dashboard at `http://localhost:8787` and put the token in.

## Reading from R2 directly (escape hatch)

If the worker breaks, you can always grab files straight from R2:

```bash
npx wrangler r2 object list underlod-logging --prefix events/2026-06-05/
npx wrangler r2 object get underlod-logging/events/2026-06-05/<uuid>.ndjson
```
