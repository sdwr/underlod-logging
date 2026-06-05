/**
 * UNDERLOD telemetry worker.
 *
 *   POST /ingest      open. accepts NDJSON, one event per line. writes to R2.
 *   GET  /events      Bearer-token-protected. lists/reads NDJSON files.
 *   GET  /events?day=YYYY-MM-DD&limit=N
 *
 * The ingest endpoint is open because that's what the game POSTs to from
 * thousands of installs — there's no way to keep that URL secret. The read
 * endpoint is gated by DASHBOARD_TOKEN (set via `wrangler secret put`).
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
const MAX_READ_FILES = 200;          // per /events response

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

async function ingest(req: Request, env: WorkerEnv): Promise<Response> {
	if (req.method !== "POST") return text("method not allowed", 405);

	const contentLength = Number(req.headers.get("content-length") || 0);
	if (contentLength > MAX_BODY_BYTES) return text("payload too large", 413);

	const body = await req.text();
	if (body.length === 0) return text("empty body", 400);
	if (body.length > MAX_BODY_BYTES) return text("payload too large", 413);

	const day = todayUTC();
	const id = crypto.randomUUID();
	const key = `events/${day}/${id}.ndjson`;

	await env.BUCKET.put(key, body, {
		httpMetadata: { contentType: "application/x-ndjson" },
		customMetadata: {
			cf_ray: req.headers.get("cf-ray") || "",
			cf_country: req.cf?.country?.toString() || "",
		},
	});

	return text("ok");
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
	// constant-time-ish compare
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
	const day = url.searchParams.get("day"); // YYYY-MM-DD or omitted = recent
	const limit = Math.min(Number(url.searchParams.get("limit") || MAX_READ_FILES), MAX_READ_FILES);

	const prefix = day ? `events/${day}/` : "events/";

	const listing = await env.BUCKET.list({ prefix, limit: MAX_LIST_KEYS });
	// newest first by key (UUIDs aren't sortable but the day prefix is — sort
	// keys descending so the most recent day appears first)
	const keys = listing.objects.map((o) => o.key).sort().reverse().slice(0, limit);

	// fetch in parallel, but keep memory bounded
	const events: any[] = [];
	const reads = await Promise.all(keys.map((k) => env.BUCKET.get(k)));
	for (const obj of reads) {
		if (!obj) continue;
		const body = await obj.text();
		for (const line of body.split("\n")) {
			if (!line.trim()) continue;
			try {
				events.push(JSON.parse(line));
			} catch {
				// drop malformed lines silently
			}
		}
	}

	return json({
		days: day ? [day] : undefined,
		file_count: keys.length,
		event_count: events.length,
		truncated: listing.truncated,
		events,
	});
}

async function listDays(req: Request, env: WorkerEnv): Promise<Response> {
	if (!authOk(req, env)) return unauthorized();

	const listing = await env.BUCKET.list({ prefix: "events/", delimiter: "/", limit: 1000 });
	const days = (listing.delimitedPrefixes || [])
		.map((p) => p.replace(/^events\//, "").replace(/\/$/, ""))
		.filter(Boolean)
		.sort()
		.reverse();
	return json({ days });
}

export default {
	async fetch(req: Request, env: WorkerEnv): Promise<Response> {
		if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

		const url = new URL(req.url);

		if (url.pathname === "/ingest") return ingest(req, env);
		if (url.pathname === "/events") return listEvents(req, env);
		if (url.pathname === "/days") return listDays(req, env);
		if (url.pathname === "/" || url.pathname === "/health") {
			return text("UNDERLOD telemetry worker. POST /ingest, GET /events (auth), GET /days (auth).");
		}

		return text("not found", 404);
	},
} satisfies ExportedHandler<WorkerEnv>;
