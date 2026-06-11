import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Standalone vitest config for the opt-in real-cloud e2e (ADR 0003). It is NEVER
 * picked up by `npm test` (the default config includes only the src test glob)
 * and is invoked solely by `npm run test:e2e`.
 *
 * The crucial difference from the default config: `obsidian` is aliased to the
 * e2e shim (real `requestUrl`), not the reject-everything mock, so the contract
 * runs against the live APIs.
 */
export default defineConfig({
	test: {
		include: ["e2e/**/*.e2e.ts"],
		// Generous: a single Dropbox 429 backoff is capped at 64s
		// (MAX_RATE_LIMIT_DELAY_MS), and a test may do several writes — so a 60s
		// per-test timeout can trip on rate-limit backoff alone under sequential load.
		testTimeout: 180_000,
		hookTimeout: 180_000,
		// Avoid hammering both backends' rate limits in parallel.
		fileParallelism: false,
	},
	resolve: {
		alias: {
			obsidian: resolve(__dirname, "obsidian.shim.ts"),
		},
	},
});
