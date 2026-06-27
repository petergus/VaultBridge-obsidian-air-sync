import { describe, it, expect } from "vitest";
import { liftActiveBackendData, normalizeConflictStrategy, normalizeDeletionLimit, addMissingDefaultIgnorePatterns } from "./settings-normalize";
import { DEFAULT_IGNORE_PATTERNS } from "./settings";
import type { VaultBridgeSettings } from "./settings";
import { mockSettings } from "./__mocks__/sync-test-helpers";

const KNOWN = ["googledrive", "googledrive-custom"];

describe("normalizeConflictStrategy", () => {
	it("leaves a valid strategy untouched", () => {
		for (const strategy of ["auto_merge", "duplicate"] as const) {
			const settings = mockSettings({ conflictStrategy: strategy });
			expect(normalizeConflictStrategy(settings)).toBe(false);
			expect(settings.conflictStrategy).toBe(strategy);
		}
	});

	it("maps the retired 'ask' to 'duplicate' (what it actually did)", () => {
		const settings = mockSettings({ conflictStrategy: "ask" as never });
		expect(normalizeConflictStrategy(settings)).toBe(true);
		expect(settings.conflictStrategy).toBe("duplicate");
	});

	it("coerces any other unknown value to the default 'auto_merge'", () => {
		const settings = mockSettings({ conflictStrategy: "nonsense" as never });
		expect(normalizeConflictStrategy(settings)).toBe(true);
		expect(settings.conflictStrategy).toBe("auto_merge");
	});
});

describe("liftActiveBackendData", () => {
	it("lifts the active backend's entry and drops the others", () => {
		const settings = mockSettings({
			backendType: "googledrive",
			backendData: {
				googledrive: { remoteVaultFolderId: "A" },
				"googledrive-custom": { customClientId: "x" },
			},
		});

		const changed = liftActiveBackendData(settings, KNOWN);

		expect(changed).toBe(true);
		expect(settings.backendData).toEqual({ remoteVaultFolderId: "A" });
	});

	it("resets to {} when the active type is absent from the old map", () => {
		const settings = mockSettings({
			backendType: "googledrive",
			backendData: { "googledrive-custom": { customClientId: "x" } },
		});

		const changed = liftActiveBackendData(settings, KNOWN);

		expect(changed).toBe(true);
		expect(settings.backendData).toEqual({});
	});

	it("leaves an already-flat bag untouched", () => {
		const settings = mockSettings({
			backendType: "googledrive",
			backendData: { remoteVaultFolderId: "A", accessTokenExpiry: 123 },
		});

		const changed = liftActiveBackendData(settings, KNOWN);

		expect(changed).toBe(false);
		expect(settings.backendData).toEqual({ remoteVaultFolderId: "A", accessTokenExpiry: 123 });
	});

	it("treats an empty bag as already-normalized", () => {
		const settings = mockSettings({ backendType: "googledrive", backendData: {} });
		expect(liftActiveBackendData(settings, KNOWN)).toBe(false);
		expect(settings.backendData).toEqual({});
	});
});

describe("normalizeDeletionLimit", () => {
	it("migrates 0 (old disabled sentinel) to 20", () => {
		const settings = mockSettings({ maxDeletionsPerSync: 0 });
		expect(normalizeDeletionLimit(settings)).toBe(true);
		expect(settings.maxDeletionsPerSync).toBe(20);
	});

	it("leaves a positive value unchanged", () => {
		const settings = mockSettings({ maxDeletionsPerSync: 50 });
		expect(normalizeDeletionLimit(settings)).toBe(false);
		expect(settings.maxDeletionsPerSync).toBe(50);
	});

	it("leaves the default (20) unchanged", () => {
		const settings = mockSettings({ maxDeletionsPerSync: 20 });
		expect(normalizeDeletionLimit(settings)).toBe(false);
	});
});

describe("addMissingDefaultIgnorePatterns", () => {
	it("adds all default patterns to a vault with no ignore patterns", () => {
		const settings = mockSettings({ ignorePatterns: [] });
		expect(addMissingDefaultIgnorePatterns(settings)).toBe(true);
		for (const p of DEFAULT_IGNORE_PATTERNS) {
			expect(settings.ignorePatterns).toContain(p);
		}
	});

	it("is idempotent — does not add duplicates when patterns already present", () => {
		const settings = mockSettings({ ignorePatterns: [...DEFAULT_IGNORE_PATTERNS] });
		const before = settings.ignorePatterns.length;
		expect(addMissingDefaultIgnorePatterns(settings)).toBe(false);
		expect(settings.ignorePatterns).toHaveLength(before);
	});

	it("does not add a pattern the user has explicitly negated (!pattern)", () => {
		const negated = `!${DEFAULT_IGNORE_PATTERNS[0]}`;
		const settings = mockSettings({ ignorePatterns: [negated] });
		addMissingDefaultIgnorePatterns(settings);
		expect(settings.ignorePatterns).not.toContain(DEFAULT_IGNORE_PATTERNS[0]);
		expect(settings.ignorePatterns).toContain(negated);
	});

	it("adds only the missing patterns when some are already present", () => {
		const settings: VaultBridgeSettings = mockSettings({
			ignorePatterns: [DEFAULT_IGNORE_PATTERNS[0]],
		});
		expect(addMissingDefaultIgnorePatterns(settings)).toBe(true);
		for (const p of DEFAULT_IGNORE_PATTERNS) {
			expect(settings.ignorePatterns).toContain(p);
		}
		expect(settings.ignorePatterns.filter((p) => p === DEFAULT_IGNORE_PATTERNS[0])).toHaveLength(1);
	});
});
