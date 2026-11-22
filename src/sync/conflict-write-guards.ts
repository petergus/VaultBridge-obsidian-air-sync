import type { IFileSystem } from "../fs/interface";
import { LocalChangedDuringSyncError } from "./transfer-guards";

export function buffersEqual(a: ArrayBuffer, b: ArrayBuffer): boolean {
	if (a.byteLength !== b.byteLength) return false;
	const va = new Uint8Array(a);
	const vb = new Uint8Array(b);
	for (let i = 0; i < va.length; i++) {
		if (va[i] !== vb[i]) return false;
	}
	return true;
}

/** Refuse to overwrite a file recreated while its remote contents were downloading. */
export async function writeMissingLocal(path: string, fs: IFileSystem, content: ArrayBuffer, mtime: number): Promise<void> {
	if (fs.createFileIfMissing) {
		if (!(await fs.createFileIfMissing(path, content, mtime))) throw new LocalChangedDuringSyncError(path);
	} else {
		if (await fs.stat(path)) throw new LocalChangedDuringSyncError(path);
		await fs.write(path, content, mtime);
	}
}

/** Only losslessly decodable text may go through Obsidian's atomic text write. */
export function decodeUtf8(bytes: ArrayBuffer): string | undefined {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		return undefined;
	}
}

export async function replaceLocalContent(
	path: string, fs: IFileSystem, expected: ArrayBuffer, content: ArrayBuffer, mtime: number,
): Promise<void> {
	if (fs.replaceTextIfUnchanged) {
		const before = decodeUtf8(expected);
		const after = decodeUtf8(content);
		if (before === undefined || after === undefined || !(await fs.replaceTextIfUnchanged(path, before, after, mtime))) {
			throw new LocalChangedDuringSyncError(path);
		}
	} else {
		if (!buffersEqual(await fs.read(path), expected)) throw new LocalChangedDuringSyncError(path);
		await fs.write(path, content, mtime);
	}
}
