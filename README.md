# underlod-logging

Telemetry backend and dashboard for [UNDERLOD](https://github.com/sdwr/underlod-items).

- **Worker** (`src/`): Cloudflare Worker that accepts NDJSON crash + gameplay events from the game and writes them to Turso (SQLite over HTTP). Read API gated by a Bearer token.
- **Dashboard** (`dashboard/`): static HTML/JS deployed to GitHub Pages. Prompts for the worker URL + token on load, fetches events, renders simple charts.

Storage is **Turso** instead of Cloudflare R2 because Turso's free tier requires no payment method on file. Free quota (9 GB storage, 1B row reads, 25M row writes per month) is well over what an indie game needs.

## Security model

| What | Where | Public? |
|---|---|---|
| Worker source | this repo | yes |
| Worker URL | shipped in the game binary | effectively yes |
| `POST /ingest` | open to the world | yes — that's how the game writes |
| `GET /events`, `/days`, `/init` | requires `Authorization: Bearer <DASHBOARD_TOKEN>` | no |
| `DASHBOARD_TOKEN` | Cloudflare Worker secret + your dashboard localStorage | no |
| `TURSO_URL`, `TURSO_TOKEN` | Cloudflare Worker secrets | no |
| Turso database | only reachable through the worker | no |
| Dashboard HTML/JS | GitHub Pages | yes (no secrets in it) |

The token never lives in the repo or in the deployed Pages site — you paste it into the dashboard once per device and it's kept in `localStorage`.

## Setup

### 1. Create the Turso database

Sign up at https://turso.tech (no card needed). Then:

```bash
# install the CLI (https://docs.turso.tech/cli/installation)
turso auth login
turso db create underlod
turso db show underlod --url        # save this — it's TURSO_URL
turso db tokens create underlod     # save this — it's TURSO_TOKEN
```

### 2. Set worker secrets

```bash
cd code/underlod-logging
npm install

npx wrangler secret put TURSO_URL
# paste the libsql://... URL from step 1
npx wrangler secret put TURSO_TOKEN
# paste the token from step 1
npx wrangler secret put DASHBOARD_TOKEN
# pick any long random string (e.g. `openssl rand -base64 32`).
# save it — you'll paste it into the dashboard once per browser.
```

If `DASHBOARD_TOKEN` was already set from the earlier R2 attempt, it carries over — only `TURSO_URL` and `TURSO_TOKEN` need adding.

### 3. Deploy the worker

```bash
npx wrangler deploy
```

Wrangler prints a URL like `https://underlod-logging.<your-subdomain>.workers.dev`.

### 4. Initialize the schema

One-time, via the worker's `/init` endpoint:

```bash
curl -X GET "https://underlod-logging.<your-subdomain>.workers.dev/init" \
     -H "Authorization: Bearer $DASHBOARD_TOKEN"
# should respond: "schema ok"
```

This creates the `events` table and indexes. Safe to re-run.

### 5. Point the game at it

In the UNDERLOD repo, edit `underlod/crash_log.lua`:

```lua
CrashLog.URL = "https://underlod-logging.<your-subdomain>.workers.dev/ingest"
```

Also ship `lua-https` with the LÖVE build — without it the HTTPS POST silently fails. Grab the prebuilt binaries from https://github.com/love2d/lua-https/releases and drop `https.dll` next to `love.exe`.

### 6. Enable GitHub Pages

1. **Settings → Pages → Build and deployment → Source: GitHub Actions**.
2. The first push to `main` (or manual run of the *Deploy dashboard* workflow) publishes `dashboard/` to `https://sdwr.github.io/underlod-logging/`.

### 7. Open the dashboard

Visit `https://sdwr.github.io/underlod-logging/`. Paste in:
- the worker URL (same one you put in `crash_log.lua`, without `/ingest`)
- the `DASHBOARD_TOKEN`

Click refresh. Both are kept in this browser's localStorage until you click "forget".

## Endpoints

```
POST /ingest                                    body: NDJSON, one event per line. open.
GET  /events                                    latest 500 events. auth.
GET  /events?day=YYYY-MM-DD&type=crash&limit=N  filtered. auth.
GET  /days                                      list of days with event counts. auth.
GET  /init                                      one-time schema setup. auth.
GET  /health                                    status string. open.
```

Limits: 200 KB per POST, 1000 rows per `/events` response.

## Schema

```sql
CREATE TABLE events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,        -- ISO timestamp from the event
  day         TEXT NOT NULL,        -- YYYY-MM-DD, indexed
  type        TEXT,                 -- crash | buy_screen_end | level_end
  install_id  TEXT,                 -- anonymous per-install uuid
  run_id      TEXT,                 -- anonymous per-run uuid
  os          TEXT,
  version     TEXT,
  level       INTEGER,              -- pulled from data.level if present
  outcome     TEXT,                 -- pulled from data.outcome if present
  payload     TEXT NOT NULL         -- full original NDJSON line
);
```

Hot fields are denormalized into columns for fast filtering; `payload` keeps the entire original event so nothing is lost.

## Event schema

Every event the game sends is one JSON object on one line:

```json
{
  "type": "crash" | "buy_screen_end" | "level_end",
  "game": "UNDERLOD",
  "version": "0.1.0",
  "install": "<uuid>",
  "run": "<uuid>",
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

For the dashboard, open `dashboard/index.html` directly or serve it:

```bash
cd dashboard && python -m http.server 8000
```

Point the dashboard at `http://localhost:8787` and use the same `DASHBOARD_TOKEN`.

## Reading from Turso directly (escape hatch)

```bash
turso db shell underlod
# > SELECT type, COUNT(*) FROM events GROUP BY type;
# > SELECT * FROM events WHERE type='crash' ORDER BY id DESC LIMIT 10;
```
