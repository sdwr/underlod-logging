import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

// Self-contained miniflare setup (not wrangler.jsonc) so tests never try to
// open remote sessions and always run against a throwaway local R2 bucket.
export default defineWorkersConfig({
	test: {
		poolOptions: {
			workers: {
				main: "./src/index.ts",
				miniflare: {
					compatibilityDate: "2026-06-05",
					compatibilityFlags: ["nodejs_compat"],
					r2Buckets: ["BUCKET"],
					bindings: { DASHBOARD_TOKEN: "test-token" },
				},
			},
		},
	},
});
