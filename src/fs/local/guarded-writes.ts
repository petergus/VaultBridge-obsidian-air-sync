import { TFile } from "obsidian";
import type { Vault } from "obsidian";
import { isDotPrefixed } from "../../utils/path";

export async function replaceTextIfUnchanged(vault: Vault, path: string, expected: string, content: string, mtime: number): Promise<boolean> {
	const file = vault.getAbstractFileByPath(path);
	if (!(file instanceof TFile) && (findCaseMismatchInVault(vault, path) || !isDotPrefixed(path))) return false;

	const changed = new Error("Local text changed before replacement");
	const replace = (current: string): string => {
		if (current !== expected || (file instanceof TFile && file.path !== path)) throw changed;
		return content;
	};
	try {
		if (file instanceof TFile) {
			await vault.process(file, replace, { mtime });
		} else {
			await vault.adapter.process(path, replace, { mtime });
		}
		return true;
	} catch (err) {
		if (err === changed) return false;
		throw err;
	}
}

/**
 * Check if `path` or any of its ancestor folders exists in Obsidian's index with
 * different casing. On case-insensitive filesystems (macOS APFS / Windows NTFS),
 * adapter.stat() and adapter.exists() match files regardless of casing. Returns
 * the conflicting vault path if found, or null otherwise.
 */
export function findCaseMismatchInVault(vault: Vault, path: string): string | null {
	const prefixesLower = new Map<string, string>();
	let cur = path;
	while (cur) {
		prefixesLower.set(cur.toLowerCase(), cur);
		const slash = cur.lastIndexOf("/");
		cur = slash > 0 ? cur.substring(0, slash) : "";
	}
	for (const f of vault.getAllLoadedFiles()) {
		const expected = prefixesLower.get(f.path.toLowerCase());
		if (expected !== undefined && f.path !== expected) {
			return f.path;
		}
	}
	return null;
}

export function caseMismatchError(message: string): Error {
	return Object.assign(new Error(message), { permanent: true, permanentCode: "local.case_mismatch" });
}
