import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["src/**/*.test.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text", "html"],
			// Production code only: exclude tests, test doubles, shared test
			// contracts, pure-type modules, and build/config files.
			include: ["src/**/*.ts"],
			exclude: [
				"src/**/*.test.ts",
				"src/__mocks__/**",
				"src/**/test-helpers.ts",
				"src/fs/remote-change-detection-contract.ts",
				"src/**/types.ts",
				"src/main.ts",
			],
		},
	},
	resolve: {
		alias: {
			obsidian: "./src/__mocks__/obsidian.ts",
		},
	},
});
