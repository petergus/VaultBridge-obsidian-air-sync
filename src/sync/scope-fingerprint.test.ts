import { describe, it, expect } from "vitest";
import { computeScopeFingerprint } from "./scope-fingerprint";
import { mockSettings } from "../__mocks__/sync-test-helpers";

describe("computeScopeFingerprint", () => {
	it("is deterministic for identical inputs", async () => {
		const settings = mockSettings({ syncDotPaths: [".templates"], ignorePatterns: ["*.tmp"] });
		const a = await computeScopeFingerprint(settings, ".cfg", "vaultbridge");
		const b = await computeScopeFingerprint(settings, ".cfg", "vaultbridge");
		expect(a).toBe(b);
	});

	it("is independent of syncDotPaths order (it's a set)", async () => {
		const a = await computeScopeFingerprint(
			mockSettings({ syncDotPaths: [".templates", ".foo"] }),
			".cfg",
			"vaultbridge",
		);
		const b = await computeScopeFingerprint(
			mockSettings({ syncDotPaths: [".foo", ".templates"] }),
			".cfg",
			"vaultbridge",
		);
		expect(a).toBe(b);
	});

	it("changes when ignorePatterns order changes (gitignore last-match-wins is order-sensitive)", async () => {
		const a = await computeScopeFingerprint(
			mockSettings({ ignorePatterns: ["*.tmp", "!keep.tmp"] }),
			".cfg",
			"vaultbridge",
		);
		const b = await computeScopeFingerprint(
			mockSettings({ ignorePatterns: ["!keep.tmp", "*.tmp"] }),
			".cfg",
			"vaultbridge",
		);
		expect(a).not.toBe(b);
	});

	it("changes when enableConfigSync toggles", async () => {
		const off = await computeScopeFingerprint(
			mockSettings({ enableConfigSync: false }),
			".cfg",
			"vaultbridge",
		);
		const on = await computeScopeFingerprint(
			mockSettings({ enableConfigSync: true }),
			".cfg",
			"vaultbridge",
		);
		expect(off).not.toBe(on);
	});

	it.each([
		"syncConfigJsonFiles",
		"syncConfigPlugins",
		"syncConfigSnippets",
		"syncConfigThemes",
		"syncConfigIcons",
	] as const)(
		"changes when %s toggles",
		async (setting) => {
			const off = await computeScopeFingerprint(
				mockSettings({ enableConfigSync: true, [setting]: false }),
				".cfg",
				"vaultbridge",
			);
			const on = await computeScopeFingerprint(
				mockSettings({ enableConfigSync: true, [setting]: true }),
				".cfg",
				"vaultbridge",
			);
			expect(off).not.toBe(on);
		},
	);

	it("changes when syncDotPaths content changes", async () => {
		const a = await computeScopeFingerprint(mockSettings({ syncDotPaths: [] }), ".cfg", "vaultbridge");
		const b = await computeScopeFingerprint(
			mockSettings({ syncDotPaths: [".templates"] }),
			".cfg",
			"vaultbridge",
		);
		expect(a).not.toBe(b);
	});

	it("changes when ignorePatterns content changes", async () => {
		const a = await computeScopeFingerprint(mockSettings({ ignorePatterns: [] }), ".cfg", "vaultbridge");
		const b = await computeScopeFingerprint(
			mockSettings({ ignorePatterns: ["*.tmp"] }),
			".cfg",
			"vaultbridge",
		);
		expect(a).not.toBe(b);
	});

	it("changes when configDir changes", async () => {
		const settings = mockSettings();
		const a = await computeScopeFingerprint(settings, ".cfg", "vaultbridge");
		const b = await computeScopeFingerprint(settings, ".cfg-custom", "vaultbridge");
		expect(a).not.toBe(b);
	});

	it("changes when pluginId changes", async () => {
		const settings = mockSettings();
		const a = await computeScopeFingerprint(settings, ".cfg", "vaultbridge");
		const b = await computeScopeFingerprint(settings, ".cfg", "vaultbridge-2");
		expect(a).not.toBe(b);
	});
});
