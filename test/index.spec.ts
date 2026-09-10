import { env, SELF } from "cloudflare:test";
import { describe, it, expect, beforeAll } from "vitest";

// DASHBOARD_TOKEN is injected by vitest.config.mts (miniflare bindings).
const TOKEN = (env as any).DASHBOARD_TOKEN || "";
const auth = { Authorization: "Bearer " + TOKEN };

function ev(type: string, run: string, time: string, data: Record<string, unknown> = {}) {
	return JSON.stringify({ type, game: "UNDERLOD", version: "0.1.0", install: "i-" + run, run, time, os: "Windows", data });
}

describe("worker", () => {
	it("ingest writes a time-prefixed key under today's receipt day", async () => {
		const res = await SELF.fetch("https://x/ingest", { method: "POST", body: ev("crash", "r0", "2026-01-01T00:00:00Z", { message: "boom" }) });
		expect(res.status).toBe(200);
		const day = new Date().toISOString().slice(0, 10);
		const list = await env.BUCKET.list({ prefix: `events/${day}/` });
		expect(list.objects.length).toBeGreaterThan(0);
		expect(list.objects[0].key).toMatch(new RegExp(`^events/${day}/\\d{2}-\\d{2}-\\d{2}\\.\\d{3}-[0-9a-f-]{36}\\.ndjson$`));
	});

	it("rejects reads without a token", async () => {
		expect((await SELF.fetch("https://x/summary")).status).toBe(401);
		expect((await SELF.fetch("https://x/rollup?day=2026-01-01", { method: "POST" })).status).toBe(401);
	});

	describe("rollup", () => {
		const day = "2025-03-02"; // a past receipt day: becomes `complete`
		beforeAll(async () => {
			// two files; the second holds events whose client time is the previous day
			await env.BUCKET.put(`events/${day}/a.ndjson`, [
				ev("buy_screen_end", "r1", "2025-03-02T10:00:00Z", { level: 1, units: [{ character: "knight", items: ["sword", ""] }] }),
				ev("level_end", "r1", "2025-03-02T10:05:00Z", { outcome: "win", level: 1, time_elapsed: 60 }),
				ev("buy_screen_end", "r1", "2025-03-02T10:06:00Z", { level: 2, units: [{ character: "knight", items: ["sword"] }] }),
				ev("level_end", "r1", "2025-03-02T10:10:00Z", { outcome: "loss", level: 2, time_elapsed: 40 }),
			].join("\n"));
			await env.BUCKET.put(`events/${day}/b.ndjson`, [
				ev("crash", "r2", "2025-03-01T23:50:00Z", { message: "attempt to index nil\nmore" }),
				ev("buy_screen_end", "r2", "2025-03-01T23:51:00Z", { level: 1, units: [{ character: "mage", items: [] }] }),
			].join("\n"));
		});

		it("folds files into per-date metrics and marks a past day complete", async () => {
			const r = await SELF.fetch(`https://x/rollup?day=${day}`, { method: "POST", headers: auth });
			expect(r.status).toBe(200);
			const body: any = await r.json();
			expect(body).toMatchObject({ day, files_read: 2, files_total: 2, complete: true, remaining: false });

			const s: any = await (await SELF.fetch("https://x/summary", { headers: auth })).json();
			expect(s.days).toContain(day);
			const d = s.all.days[day];
			expect(d.complete).toBe(true);
			const m2 = d.dates["2025-03-02"];
			expect(m2).toMatchObject({ events: 4, runs: 1, installs: 1, wins: 1, losses: 1, level_ends: 2, time_elapsed: 100 });
			expect(m2.level_starts).toEqual({ "1": 1, "2": 1 });
			expect(m2.deaths_by_level).toEqual({ "2": 1 });
			expect(m2.chars).toEqual({ knight: 2 });
			expect(m2.items).toEqual({ sword: 2 }); // empty slots are ignored
			const m1 = d.dates["2025-03-01"];
			expect(m1).toMatchObject({ events: 2, runs: 1, crashes: 1 });
			expect(m1.crash_messages).toEqual({ "attempt to index nil": 1 });

			// Idempotent: a second call resumes from the cursor and reads nothing new.
			// (Same test, because the pool rolls storage back between tests.)
			const again: any = await (await SELF.fetch(`https://x/rollup?day=${day}`, { method: "POST", headers: auth })).json();
			expect(again.files_read).toBe(0);
			expect(again.files_total).toBe(2);
			const s2: any = await (await SELF.fetch("https://x/summary", { headers: auth })).json();
			expect(s2.all.days[day].dates["2025-03-02"].events).toBe(4);
		});

		it("clamps client dates in the future to the receipt day", async () => {
			const d2 = "2025-04-01";
			await env.BUCKET.put(`events/${d2}/a.ndjson`, ev("crash", "r9", "2099-01-01T00:00:00Z", { message: "x" }));
			await SELF.fetch(`https://x/rollup?day=${d2}`, { method: "POST", headers: auth });
			const s: any = await (await SELF.fetch("https://x/summary", { headers: auth })).json();
			expect(Object.keys(s.all.days[d2].dates)).toEqual([d2]);
		});
	});
});
