import { describe, expect, it } from "vitest";
import { formatPluginBuildInfo, getBuildTimestamp } from "./build-info";

describe("build-info", () => {
	it("falls back to dev build timestamp in unbundled test runs", () => {
		expect(getBuildTimestamp()).toBe("dev");
	});

	it("formats plugin version and last-updated timestamp cleanly", () => {
		expect(formatPluginBuildInfo("0.1.34", "2026-11-22 11:20")).toBe(
			"v0.1.34 · Last updated 2026-11-22 11:20",
		);
	});
});
