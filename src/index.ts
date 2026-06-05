/**
 * UNDERLOD telemetry worker.
 *
 *   POST /ingest      open. accepts NDJSON, one event per line. writes to Turso.
 *   GET  /events      Bearer-token-protected. returns rows.
 *   GET  /events?day=YYYY-MM-DD&type=crash&limit=N
 *   GET  /days        Bearer-token-protected. list of days with events.
 *
 * Storage is Turso (SQLite over HTTP). Free tier, no card required.
 *
 * The ingest endpoint is open because that's what the game POSTs to from
 * thousands of installs — the URL is shipped in the binary and can't be
 * kept secret. The read endpoints are gated by DASHBOARD_TOKEN.
 */

import { createClient, type Client } from "@libsql/client/web";

export interface WorkerEnv {
	DASHBOARD_TOKEN: string;
	TURSO_URL: string;
	TURSO_TOKEN: string;
}

const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
	"Access-Control-Max-Age": "86400",
};

const MAX_BODY_BYTES = 200_000;
const MAX_ROWS = 1000;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...CORS },
	});
}

function text(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": "text/plain", ...CORS },
	});
}

function todayUTC(): string {
	return new Date().toISOString().slice(0, 10);
}

function db(env: WorkerEnv): Client {
	return createClient({ url: env.TURSO_URL, authToken: env.TURSO_TOKEN });
}

// Insert one event. Pulls a few hot fields out into columns for fast
// filtering; keeps the whole event in `payload` so nothing is lost.
async function insertEvent(client: Client, line: string): Promise<void> {
	let ev: any;
	try {
		ev = JSON.parse(line);
	} catch {
		return; // drop malformed lines silently
	}
	if (!ev || typeof ev !== "object") return;

	const ts = String(ev.time ?? new Date().toISOString());
	const day = ts.slice(0, 10);
	const type = String(ev.type ?? "unknown");
	const install_id = ev.install ? String(ev.install) : null;
	const run_id = ev.run ? String(ev.run) : null;
	const os = ev.os ? String(ev.os) : null;
	const version = ev.version ? String(ev.version) : null;
	const level = ev.data && typeof ev.data.level === "number" ? ev.data.level : null;
	const outcome = ev.data && ev.data.outcome ? String(ev.data.outcome) : null;

	await client.execute({
		sql: `INSERT INTO events
				(ts, day, type, install_id, run_id, os, version, level, outcome, payload)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		args: [ts, day, type, install_id, run_id, os, version, level, outcome, line],
	});
}

async function ingest(req: Request, env: WorkerEnv): Promise<Response> {
	if (req.method !== "POST") return text("method not allowed", 405);

	const contentLength = Number(req.headers.get("content-length") || 0);
	if (contentLength > MAX_BODY_BYTES) return text("payload too large", 413);

	const body = await req.text();
	if (body.length === 0) return text("empty body", 400);
	if (body.length > MAX_BODY_BYTES) return text("payload too large", 413);

	const client = db(env);
	const lines = body.split("\n").filter((l) => l.trim());
	let inserted = 0;
	for (const line of lines) {
		try {
			await insertEvent(client, line);
			inserted++;
		} catch (e) {
			// don't fail the whole batch on one bad row
			console.error("insert failed", e);
		}
	}

	return text(`ok ${inserted}`);
}

function unauthorized(): Response {
	return new Response("unauthorized", {
		status: 401,
		headers: { ...CORS, "WWW-Authenticate": 'Bearer realm="underlod"' },
	});
}

function authOk(req: Request, env: WorkerEnv): boolean {
	if (!env.DASHBOARD_TOKEN) return false;
	const header = req.headers.get("authorization") || "";
	const m = header.match(/^Bearer\s+(.+)$/i);
	if (!m) return false;
	const a = m[1];
	const b = env.DASHBOARD_TOKEN;
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

async function listEvents(req: Request, env: WorkerEnv): Promise<Response> {
	if (!authOk(req, env)) return unauthorized();

	const url = new URL(req.url);
	const day = url.searchParams.get("day");
	const type = url.searchParams.get("type");
	const limit = Math.min(Number(url.searchParams.get("limit") || 500), MAX_ROWS);

	const wheres: string[] = [];
	const args: any[] = [];
	if (day) { wheres.push("day = ?"); args.push(day); }
	if (type) { wheres.push("type = ?"); args.push(type); }
	const whereSql = wheres.length ? "WHERE " + wheres.join(" AND ") : "";

	const client = db(env);
	const result = await client.execute({
		sql: `SELECT payload FROM events ${whereSql} ORDER BY id DESC LIMIT ?`,
		args: [...args, limit],
	});

	const events: any[] = [];
	for (const row of result.rows) {
		const raw = row.payload as string;
		try {
			events.push(JSON.parse(raw));
		} catch {
			// skip — shouldn't happen since we wrote valid JSON
		}
	}

	return json({
		filters: { day, type },
		event_count: events.length,
		events,
	});
}

async function listDays(req: Request, env: WorkerEnv): Promise<Response> {
	if (!authOk(req, env)) return unauthorized();

	const client = db(env);
	const result = await client.execute({
		sql: "SELECT day, COUNT(*) as n FROM events GROUP BY day ORDER BY day DESC LIMIT 365",
	});

	const days = result.rows.map((r) => ({ day: r.day as string, count: Number(r.n) }));
	return json({ days });
}

// One-time schema setup. Safe to call repeatedly. Exposed for the deploy
// helper script in README. Auth-protected.
async function init(req: Request, env: WorkerEnv): Promise<Response> {
	if (!authOk(req, env)) return unauthorized();
	const client = db(env);
	await client.execute(`
		CREATE TABLE IF NOT EXISTS events (
			id INTEGER PRIMARY KEY AUTOINCREMENT,
			ts TEXT NOT NULL,
			day TEXT NOT NULL,
			type TEXT,
			install_id TEXT,
			run_id TEXT,
			os TEXT,
			version TEXT,
			level INTEGER,
			outcome TEXT,
			payload TEXT NOT NULL
		)
	`);
	await client.execute("CREATE INDEX IF NOT EXISTS events_day_idx ON events(day)");
	await client.execute("CREATE INDEX IF NOT EXISTS events_type_idx ON events(type)");
	return text("schema ok");
}

export default {
	async fetch(req: Request, env: WorkerEnv): Promise<Response> {
		if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

		const url = new URL(req.url);

		if (url.pathname === "/ingest") return ingest(req, env);
		if (url.pathname === "/events") return listEvents(req, env);
		if (url.pathname === "/days") return listDays(req, env);
		if (url.pathname === "/init") return init(req, env);
		if (url.pathname === "/" || url.pathname === "/health") {
			return text("UNDERLOD telemetry worker. POST /ingest, GET /events|/days|/init (auth).");
		}

		return text("not found", 404);
	},
} satisfies ExportedHandler<WorkerEnv>;
