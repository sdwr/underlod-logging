/**
 * UNDERLOD telemetry worker.
 *
 *   POST /ingest      open. accepts NDJSON, one event per line. writes to R2.
 *   GET  /events      Bearer-token-protected. lists/reads NDJSON files.
 *   GET  /events?day=YYYY-MM-DD&limit=N
 *   GET  /days        auth. list of receipt days that have event files.
 *   GET  /summary     auth. merged per-day rollups (summary/all.json) + days.
 *   POST /rollup?day=YYYY-MM-DD   auth. roll up (one batch of) a day's files
 *                                 into summary/<day>.json and summary/all.json.
 *
 * The ingest endpoint is open because that's what the game POSTs to from
 * thousands of installs — there's no way to keep that URL secret. The read
 * endpoints are gated by DASHBOARD_TOKEN (set via `wrangler secret put`).
 *
 * Storage layout (R2):
 *   events/<receipt-day>/<iso-time>-<uuid>.ndjson   raw uploads, immutable
 *   summary/<receipt-day>.json                      DaySummary (with cursor)
 *   summary/all.json                                AllSummary (counts only)
 *
 * Why rollups exist: a single invocation may only open ~50 subrequests on the
 * free plan, so the dashboard can never read more than ~45 raw files per call.
 * Rollups fold each day's files into a small JSON once, incrementally, so a
 * full history chart is one small read.
 */

export interface WorkerEnv {
	BUCKET: R2Bucket;
	DASHBOARD_TOKEN: string;
}

const CORS = {
	"Access-Control-Allow-Origin": "*",
	"Access-Control-Allow-Methods": "GET, POST, OPTIONS",
	"Access-Control-Allow-Headers": "Content-Type, Authorization",
	"Access-Control-Max-Age": "86400",
};

const MAX_BODY_BYTES = 200_000;     // per POST
const MAX_LIST_KEYS = 1000;          // per /events response
// Each file read is a subrequest. The Workers free plan caps subrequests at
// 50 per invocation (1000 on paid); stay under the free limit so a large
// bucket can't blow up the read with "Too many subrequests".
const MAX_READ_FILES = 45;           // per /events response
// Rollup budget: get day file + list + N reads + get all.json + 2 puts <= 45.
const ROLLUP_BATCH_FILES = 38;
// R2 .get() opens a stream; Workers caps concurrently open streams (~6).
const CONCURRENCY = 6;

const SUMMARY_VERSION = 1;
const ALL_KEY = "summary/all.json";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json", ...CORS },
	});
}

function text(body: string, status = 200, contentType = "text/plain"): Response {
	return new Response(body, {
		status,
		headers: { "Content-Type": contentType, ...CORS },
	});
}

function todayUTC(): string {
	return new Date().toISOString().slice(0, 10);
}

function isDay(s: string | null): s is string {
	return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

// ============================================================
// Ingest
// ============================================================

async function ingest(req: Request, env: WorkerEnv): Promise<Response> {
	if (req.method !== "POST") return text("method not allowed", 405);

	const contentLength = Number(req.headers.get("content-length") || 0);
	if (contentLength > MAX_BODY_BYTES) return text("payload too large", 413);

	const body = await req.text();
	if (body.length === 0) return text("empty body", 400);
	if (body.length > MAX_BODY_BYTES) return text("payload too large", 413);

	const now = new Date();
	const day = now.toISOString().slice(0, 10);
	// Time-prefixed keys sort chronologically, which lets rollups resume from a
	// cursor (list startAfter) and pick up only files that arrived since —
	// including for the current day. Older files are bare UUIDs; those days are
	// immutable so cursor order doesn't matter for them.
	const stamp = now.toISOString().slice(11, 23).replace(/:/g, "-"); // HH-MM-SS.mmm
	const id = crypto.randomUUID();
	const key = `events/${day}/${stamp}-${id}.ndjson`;

	await env.BUCKET.put(key, body, {
		httpMetadata: { contentType: "application/x-ndjson" },
		customMetadata: {
			cf_ray: req.headers.get("cf-ray") || "",
			cf_country: req.cf?.country?.toString() || "",
		},
	});

	return text("ok");
}

// ============================================================
// Auth
// ============================================================

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
	// constant-time-ish compare
	const a = m[1];
	const b = env.DASHBOARD_TOKEN;
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

// ============================================================
// Raw reads
// ============================================================

// Read a set of keys in bounded batches, returning parsed events.
async function readEvents(env: WorkerEnv, keys: string[]): Promise<any[]> {
	const events: any[] = [];
	for (let i = 0; i < keys.length; i += CONCURRENCY) {
		const batch = keys.slice(i, i + CONCURRENCY);
		const bodies = await Promise.all(
			batch.map(async (k) => {
				try {
					const obj = await env.BUCKET.get(k);
					return obj ? await obj.text() : null;
				} catch {
					return null; // skip a single unreadable object
				}
			}),
		);
		for (const body of bodies) {
			if (!body) continue;
			for (const line of body.split("\n")) {
				if (!line.trim()) continue;
				try {
					events.push(JSON.parse(line));
				} catch {
					// drop malformed lines silently
				}
			}
		}
	}
	return events;
}

async function listEvents(req: Request, env: WorkerEnv): Promise<Response> {
	if (!authOk(req, env)) return unauthorized();

	const url = new URL(req.url);
	const day = url.searchParams.get("day"); // YYYY-MM-DD or omitted = recent
	const limit = Math.min(Number(url.searchParams.get("limit") || MAX_READ_FILES), MAX_READ_FILES);

	const prefix = day ? `events/${day}/` : "events/";

	const listing = await env.BUCKET.list({ prefix, limit: MAX_LIST_KEYS });
	// Keys are day-prefixed (and time-prefixed since the rollup change), so a
	// descending sort is newest-first.
	const keys = listing.objects.map((o) => o.key).sort().reverse().slice(0, limit);
	const events = await readEvents(env, keys);

	return json({
		days: day ? [day] : undefined,
		file_count: keys.length,
		event_count: events.length,
		truncated: listing.truncated,
		events,
	});
}

async function listDayPrefixes(env: WorkerEnv): Promise<string[]> {
	const listing = await env.BUCKET.list({ prefix: "events/", delimiter: "/", limit: 1000 });
	return (listing.delimitedPrefixes || [])
		.map((p) => p.replace(/^events\//, "").replace(/\/$/, ""))
		.filter(Boolean)
		.sort()
		.reverse();
}

async function listDays(req: Request, env: WorkerEnv): Promise<Response> {
	if (!authOk(req, env)) return unauthorized();
	return json({ days: await listDayPrefixes(env) });
}

// ============================================================
// Rollups
// ============================================================

type Counts = Record<string, number>;

// Per event-date (client `time`, clamped to the receipt day) metrics.
interface DateMetrics {
	events: number;
	runs: number;          // distinct run ids seen on this date (set size)
	installs: number;      // distinct installs seen on this date (set size)
	crashes: number;
	level_ends: number;
	wins: number;          // level_end outcome=win
	losses: number;        // level_end outcome=loss
	completes: number;     // level_end outcome=run_complete
	time_elapsed: number;  // sum over level_end
	level_starts: Counts;  // buy_screen_end by level — survival curve source
	deaths_by_level: Counts;
	wins_by_level: Counts;
	chars: Counts;         // character picks at buy_screen_end
	items: Counts;         // equipped items at buy_screen_end
	os: Counts;
	versions: Counts;
	crash_messages: Counts;
}

interface DaySummary {
	version: number;
	day: string;               // receipt day
	updated: string;
	cursor: string;            // last key folded in (list startAfter)
	files: number;
	complete: boolean;         // true once a *past* day has no more files
	dates: Record<string, DateMetrics>;
	// Identity sets, kept only in the day file so a resumed rollup can dedupe.
	sets: Record<string, { runs: string[]; installs: string[] }>;
}

interface AllSummary {
	version: number;
	updated: string;
	days: Record<string, { updated: string; files: number; complete: boolean; dates: Record<string, DateMetrics> }>;
}

function emptyMetrics(): DateMetrics {
	return {
		events: 0, runs: 0, installs: 0, crashes: 0, level_ends: 0,
		wins: 0, losses: 0, completes: 0, time_elapsed: 0,
		level_starts: {}, deaths_by_level: {}, wins_by_level: {},
		chars: {}, items: {}, os: {}, versions: {}, crash_messages: {},
	};
}

function bump(c: Counts, key: unknown, n = 1) {
	if (key == null || key === "") return;
	const k = String(key);
	c[k] = (c[k] || 0) + n;
}

// Which date bucket an event belongs to: its own `time` if sane, else the
// receipt day. Client clocks ahead of the server are clamped to receipt day.
function eventDate(e: any, receiptDay: string): string {
	const t = typeof e.time === "string" ? e.time.slice(0, 10) : "";
	if (!/^\d{4}-\d{2}-\d{2}$/.test(t)) return receiptDay;
	if (t > receiptDay) return receiptDay;
	return t;
}

function foldEvent(sum: DaySummary, e: any) {
	const date = eventDate(e, sum.day);
	const m = (sum.dates[date] ||= emptyMetrics());
	const sets = (sum.sets[date] ||= { runs: [], installs: [] });
	m.events++;
	if (e.run && !sets.runs.includes(e.run)) sets.runs.push(e.run);
	if (e.install && !sets.installs.includes(e.install)) sets.installs.push(e.install);
	bump(m.os, e.os);
	bump(m.versions, e.version);
	const d = e.data || {};
	if (e.type === "crash") {
		m.crashes++;
		const msg = String(d.message || "").split("\n")[0].slice(0, 120);
		bump(m.crash_messages, msg || "(no message)");
	} else if (e.type === "level_end") {
		m.level_ends++;
		const o = d.outcome;
		if (o === "loss") { m.losses++; bump(m.deaths_by_level, d.level); }
		else if (o === "win") { m.wins++; bump(m.wins_by_level, d.level); }
		else if (o === "run_complete") { m.completes++; bump(m.wins_by_level, d.level); }
		if (typeof d.time_elapsed === "number") m.time_elapsed += d.time_elapsed;
	} else if (e.type === "buy_screen_end") {
		bump(m.level_starts, d.level);
		for (const u of Array.isArray(d.units) ? d.units : []) {
			bump(m.chars, u?.character);
			for (const it of Array.isArray(u?.items) ? u.items : []) bump(m.items, it);
		}
	}
}

function finalizeSets(sum: DaySummary) {
	for (const [date, s] of Object.entries(sum.sets)) {
		const m = (sum.dates[date] ||= emptyMetrics());
		m.runs = s.runs.length;
		m.installs = s.installs.length;
	}
}

async function getJson<T>(env: WorkerEnv, key: string): Promise<T | null> {
	const obj = await env.BUCKET.get(key);
	if (!obj) return null;
	try { return (await obj.json()) as T; } catch { return null; }
}

// One batch of rollup work for `day`. Returns the updated day summary and
// whether more files remain.
async function rollupDay(env: WorkerEnv, day: string): Promise<{ summary: DaySummary; remaining: boolean; read: number }> {
	const dayKey = `summary/${day}.json`;
	let sum = await getJson<DaySummary>(env, dayKey);
	if (!sum || sum.version !== SUMMARY_VERSION) {
		sum = { version: SUMMARY_VERSION, day, updated: "", cursor: "", files: 0, complete: false, dates: {}, sets: {} };
	}

	const prefix = `events/${day}/`;
	const listing = await env.BUCKET.list({
		prefix,
		limit: ROLLUP_BATCH_FILES,
		startAfter: sum.cursor || undefined,
	});
	const keys = listing.objects.map((o) => o.key).sort();
	const events = await readEvents(env, keys);
	for (const e of events) foldEvent(sum, e);
	finalizeSets(sum);

	sum.files += keys.length;
	if (keys.length) sum.cursor = keys[keys.length - 1];
	const remaining = listing.truncated;
	// A past day never gains files, so "no more to list" means done for good.
	// Today is never complete: the next rollup resumes from the cursor.
	sum.complete = !remaining && day < todayUTC();
	sum.updated = new Date().toISOString();

	await env.BUCKET.put(dayKey, JSON.stringify(sum), {
		httpMetadata: { contentType: "application/json" },
	});

	// Merge into all.json (counts only; identity sets stay in the day file).
	const all = (await getJson<AllSummary>(env, ALL_KEY)) || { version: SUMMARY_VERSION, updated: "", days: {} };
	all.version = SUMMARY_VERSION;
	all.updated = sum.updated;
	all.days[day] = { updated: sum.updated, files: sum.files, complete: sum.complete, dates: sum.dates };
	await env.BUCKET.put(ALL_KEY, JSON.stringify(all), {
		httpMetadata: { contentType: "application/json" },
	});

	return { summary: sum, remaining, read: keys.length };
}

async function rollup(req: Request, env: WorkerEnv): Promise<Response> {
	if (!authOk(req, env)) return unauthorized();
	if (req.method !== "POST") return text("method not allowed", 405);
	const day = new URL(req.url).searchParams.get("day");
	if (!isDay(day)) return text("day=YYYY-MM-DD required", 400);
	if (day > todayUTC()) return text("day is in the future", 400);
	const { summary, remaining, read } = await rollupDay(env, day);
	return json({
		day,
		files_read: read,
		files_total: summary.files,
		complete: summary.complete,
		remaining,
		cursor: summary.cursor,
	});
}

async function summary(req: Request, env: WorkerEnv): Promise<Response> {
	if (!authOk(req, env)) return unauthorized();
	const [days, all] = await Promise.all([listDayPrefixes(env), getJson<AllSummary>(env, ALL_KEY)]);
	return json({
		today: todayUTC(),
		days,
		all: all || { version: SUMMARY_VERSION, updated: "", days: {} },
	});
}

// Hourly cron: fold today's new files, and finish yesterday if it isn't
// complete yet (one batch each — the dashboard backfills anything older).
async function scheduledRollup(env: WorkerEnv) {
	const today = todayUTC();
	const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
	const y = await getJson<DaySummary>(env, `summary/${yesterday}.json`);
	if (!y || !y.complete) await rollupDay(env, yesterday);
	await rollupDay(env, today);
}

// ============================================================
// Router
// ============================================================

export default {
	async fetch(req: Request, env: WorkerEnv): Promise<Response> {
		if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

		try {
			const url = new URL(req.url);

			if (url.pathname === "/ingest") return await ingest(req, env);
			if (url.pathname === "/events") return await listEvents(req, env);
			if (url.pathname === "/days") return await listDays(req, env);
			if (url.pathname === "/summary") return await summary(req, env);
			if (url.pathname === "/rollup") return await rollup(req, env);
			if (url.pathname === "/" || url.pathname === "/health") {
				return text("UNDERLOD telemetry worker. POST /ingest, GET /events (auth), GET /days (auth), GET /summary (auth), POST /rollup?day= (auth).");
			}

			return text("not found", 404);
		} catch (e: any) {
			// Always return CORS headers, even on failure — otherwise the browser
			// reports a generic CORS error and the real cause is invisible.
			return text("worker error: " + (e?.message || String(e)), 500);
		}
	},

	async scheduled(_controller: ScheduledController, env: WorkerEnv, ctx: ExecutionContext) {
		ctx.waitUntil(scheduledRollup(env));
	},
} satisfies ExportedHandler<WorkerEnv>;
