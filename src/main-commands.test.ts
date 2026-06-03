import { describe, it, expect } from "vitest";
// `?raw` gives main.ts's source text without booting the Obsidian Plugin runtime.
import mainSource from "./main.ts?raw";

/**
 * Command-ID immutability (CLAUDE.md: "Command IDs are immutable once
 * published"). A published command ID is part of the plugin's public contract —
 * users bind hotkeys to it. Renaming or removing one silently breaks those
 * bindings.
 *
 * This snapshot pins the registered IDs. If it fails you are changing the public
 * command surface: only update the expectation for a genuinely new command, and
 * never rename an existing ID that has shipped.
 */
function registeredCommandIds(source: string): string[] {
	// Grab the `id:` of each addCommand({ ... }) registration. Accept single or
	// double quotes so a formatter pass can't silently change the extracted set.
	return [
		...source.matchAll(/addCommand\(\{[\s\S]*?id:\s*["']([^"']+)["']/g),
	].map((m) => m[1] as string);
}

describe("published command IDs are stable", () => {
	it("registers exactly the known command IDs", () => {
		const ids = registeredCommandIds(mainSource);
		// Guard against the regex silently matching nothing (e.g. commands moved
		// behind a helper wrapper) and the snapshot degrading to a vacuous pass.
		expect(ids.length).toBeGreaterThan(0);
		expect(ids).toEqual(["sync-now"]);
	});
});
