import { describe, it, expect, beforeEach } from "vitest";
import { createMockFs, addFile, readText } from "./sync-test-helpers";

// IFileSystem-contract suite for the canonical in-memory test double
// (createMockFs). It must model the same semantics LocalFs / GoogleDriveFs do:
// path normalization, rename validation, copy-on-read, and type-collision errors.
describe("createMockFs", () => {
	let fs: ReturnType<typeof createMockFs>;

	beforeEach(() => {
		fs = createMockFs("test");
	});

	describe("rename", () => {
		it("renames a single file", async () => {
			addFile(fs, "a.txt", "hello");
			await fs.rename("a.txt", "b.txt");
			expect(fs.files.has("a.txt")).toBe(false);
			expect(readText(fs, "b.txt")).toBe("hello");
		});

		it("renames a directory and all its children", async () => {
			addFile(fs, "dir/a.txt", "aaa");
			addFile(fs, "dir/sub/b.txt", "bbb");
			await fs.rename("dir", "renamed");
			expect(fs.files.has("dir")).toBe(false);
			expect(fs.files.has("dir/a.txt")).toBe(false);
			expect(fs.files.has("dir/sub/b.txt")).toBe(false);
			expect(readText(fs, "renamed/a.txt")).toBe("aaa");
			expect(readText(fs, "renamed/sub/b.txt")).toBe("bbb");
			expect(fs.files.has("renamed")).toBe(true);
			expect(fs.files.has("renamed/sub")).toBe(true);
		});

		it("does not affect entries that share a prefix but are not children", async () => {
			addFile(fs, "dir-extra/c.txt", "ccc");
			addFile(fs, "dir/a.txt", "aaa");
			await fs.rename("dir", "renamed");
			expect(readText(fs, "dir-extra/c.txt")).toBe("ccc");
		});

		it("throws when source does not exist", async () => {
			await expect(fs.rename("missing", "dest")).rejects.toThrow(
				"File not found: missing",
			);
		});

		it("throws when destination already exists", async () => {
			addFile(fs, "a.txt", "aaa");
			addFile(fs, "b.txt", "bbb");
			await expect(fs.rename("a.txt", "b.txt")).rejects.toThrow(
				"Destination already exists: b.txt",
			);
		});

		it("throws when renaming to itself", async () => {
			addFile(fs, "a.txt", "hello");
			await expect(fs.rename("a.txt", "a.txt")).rejects.toThrow(
				'Cannot rename "a.txt" to itself',
			);
		});

		it("throws when moving into own subtree", async () => {
			addFile(fs, "dir/a.txt", "aaa");
			await expect(fs.rename("dir", "dir/sub")).rejects.toThrow(
				'Cannot move "dir" into its own subtree "dir/sub"',
			);
		});

		it("creates parent directories for new path", async () => {
			addFile(fs, "a.txt", "hello");
			await fs.rename("a.txt", "new-dir/sub/b.txt");
			expect(fs.files.has("new-dir")).toBe(true);
			expect(fs.files.has("new-dir/sub")).toBe(true);
			expect(readText(fs, "new-dir/sub/b.txt")).toBe("hello");
		});

		it("preserves file content and mtime through rename", async () => {
			addFile(fs, "old.txt", "content", 12345);
			await fs.rename("old.txt", "new.txt");
			const entity = await fs.stat("new.txt");
			expect(entity).not.toBeNull();
			expect(entity!.mtime).toBe(12345);
			expect(readText(fs, "new.txt")).toBe("content");
		});
	});

	describe("list", () => {
		it("returns all seeded files and directories", async () => {
			addFile(fs, "a.txt", "aaa");
			addFile(fs, "dir/b.txt", "bbb");
			const entities = await fs.list();
			const paths = entities.map((e) => e.path).sort();
			expect(paths).toContain("a.txt");
			expect(paths).toContain("dir");
			expect(paths).toContain("dir/b.txt");
		});

		it("returns empty array when no files exist", async () => {
			const entities = await fs.list();
			expect(entities).toEqual([]);
		});

		it("returns hash as empty string for performance", async () => {
			addFile(fs, "a.txt", "hello");
			const entities = await fs.list();
			const file = entities.find((e) => e.path === "a.txt");
			expect(file!.hash).toBe("");
		});

		it("returns correct size and mtime", async () => {
			addFile(fs, "a.txt", "hello", 99999);
			const entities = await fs.list();
			const file = entities.find((e) => e.path === "a.txt");
			expect(file!.mtime).toBe(99999);
			expect(file!.size).toBe(
				new TextEncoder().encode("hello").byteLength,
			);
		});
	});

	describe("stat", () => {
		it("returns FileEntity with hash for an existing file", async () => {
			addFile(fs, "a.txt", "hello");
			const entity = await fs.stat("a.txt");
			expect(entity).not.toBeNull();
			expect(entity!.isDirectory).toBe(false);
			expect(entity!.hash).not.toBe("");
		});

		it("returns FileEntity for a directory", async () => {
			await fs.mkdir("dir");
			const entity = await fs.stat("dir");
			expect(entity).not.toBeNull();
			expect(entity!.isDirectory).toBe(true);
			expect(entity!.hash).toBe("");
		});

		it("returns null for non-existent path", async () => {
			const entity = await fs.stat("missing");
			expect(entity).toBeNull();
		});
	});

	describe("read", () => {
		it("returns file content as ArrayBuffer", async () => {
			addFile(fs, "a.txt", "hello");
			const buf = await fs.read("a.txt");
			const text = new TextDecoder().decode(buf);
			expect(text).toBe("hello");
		});

		it("returns a copy (not the original buffer)", async () => {
			addFile(fs, "a.txt", "hello");
			const buf1 = await fs.read("a.txt");
			const buf2 = await fs.read("a.txt");
			expect(buf1).not.toBe(buf2);
		});

		it("throws for non-existent file", async () => {
			await expect(fs.read("missing")).rejects.toThrow(
				"File not found: missing",
			);
		});

		it("throws for a directory with distinct message", async () => {
			await fs.mkdir("dir");
			await expect(fs.read("dir")).rejects.toThrow(
				"Not a file (is a directory): dir",
			);
		});
	});

	describe("write", () => {
		it("creates a new file and returns FileEntity with hash", async () => {
			const content = new TextEncoder().encode("hello").buffer.slice(0);
			const entity = await fs.write("a.txt", content, 1000);
			expect(entity.isDirectory).toBe(false);
			expect(entity.hash).not.toBe("");
			expect(readText(fs, "a.txt")).toBe("hello");
		});

		it("overwrites existing file", async () => {
			addFile(fs, "a.txt", "old");
			const content = new TextEncoder().encode("new").buffer.slice(0);
			await fs.write("a.txt", content, 1000);
			expect(readText(fs, "a.txt")).toBe("new");
		});

		it("creates parent directories automatically", async () => {
			const content = new TextEncoder().encode("data").buffer.slice(0);
			await fs.write("a/b/c.txt", content, 1000);
			expect(fs.files.has("a")).toBe(true);
			expect(fs.files.has("a/b")).toBe(true);
			expect(readText(fs, "a/b/c.txt")).toBe("data");
		});

		it("throws when writing to an existing directory", async () => {
			await fs.mkdir("dir");
			const content = new TextEncoder().encode("data").buffer.slice(0);
			await expect(fs.write("dir", content, 1000)).rejects.toThrow(
				'Cannot write file: "dir" is an existing directory',
			);
		});

		it("uses provided mtime", async () => {
			const content = new TextEncoder().encode("data").buffer.slice(0);
			const entity = await fs.write("a.txt", content, 12345);
			expect(entity.mtime).toBe(12345);
		});
	});

	describe("delete", () => {
		it("deletes a file", async () => {
			addFile(fs, "a.txt", "hello");
			await fs.delete("a.txt");
			expect(fs.files.has("a.txt")).toBe(false);
		});

		it("deletes a directory and all children", async () => {
			addFile(fs, "dir/a.txt", "aaa");
			addFile(fs, "dir/sub/b.txt", "bbb");
			await fs.delete("dir");
			expect(fs.files.has("dir")).toBe(false);
			expect(fs.files.has("dir/a.txt")).toBe(false);
			expect(fs.files.has("dir/sub/b.txt")).toBe(false);
		});

		it("is idempotent for non-existent path", async () => {
			await expect(fs.delete("missing")).resolves.not.toThrow();
		});

		it("does not affect entries sharing a prefix", async () => {
			addFile(fs, "dir/a.txt", "aaa");
			addFile(fs, "dir-extra/b.txt", "bbb");
			await fs.delete("dir");
			expect(readText(fs, "dir-extra/b.txt")).toBe("bbb");
		});
	});

	describe("mkdir", () => {
		it("creates a directory", async () => {
			await fs.mkdir("a");
			expect(fs.files.has("a")).toBe(true);
			const entity = await fs.stat("a");
			expect(entity!.isDirectory).toBe(true);
		});

		it("creates intermediate directories", async () => {
			await fs.mkdir("a/b/c");
			expect(fs.files.has("a")).toBe(true);
			expect(fs.files.has("a/b")).toBe(true);
			expect(fs.files.has("a/b/c")).toBe(true);
		});

		it("is idempotent for existing directories", async () => {
			await fs.mkdir("a/b");
			await expect(fs.mkdir("a/b")).resolves.not.toThrow();
		});

		it("throws if an intermediate path is a file", async () => {
			addFile(fs, "a/b", "file-content");
			await expect(fs.mkdir("a/b/c")).rejects.toThrow(
				'Cannot create directory "a/b/c": "a/b" is a file',
			);
		});

		it("throws if the target path itself is a file", async () => {
			addFile(fs, "x", "file");
			await expect(fs.mkdir("x")).rejects.toThrow(
				'Cannot create directory "x": "x" is a file',
			);
		});
	});

	describe("path normalization", () => {
		it("stat with trailing slash", async () => {
			addFile(fs, "a.txt", "hello");
			const entity = await fs.stat("a.txt/");
			expect(entity).not.toBeNull();
			expect(entity!.path).toBe("a.txt");
		});

		it("stat with leading slash", async () => {
			addFile(fs, "a.txt", "hello");
			const entity = await fs.stat("/a.txt");
			expect(entity).not.toBeNull();
		});

		it("read with backslash path", async () => {
			addFile(fs, "dir/a.txt", "hello");
			const buf = await fs.read("dir\\a.txt");
			expect(new TextDecoder().decode(buf)).toBe("hello");
		});

		it("write with double slash", async () => {
			const content = new TextEncoder().encode("data").buffer.slice(0);
			await fs.write("dir//a.txt", content, 100);
			expect(readText(fs, "dir/a.txt")).toBe("data");
		});

		it("delete with leading slash", async () => {
			addFile(fs, "a.txt", "hello");
			await fs.delete("/a.txt");
			expect(fs.files.has("a.txt")).toBe(false);
		});
	});

	describe("listDir", () => {
		it("returns immediate children only", async () => {
			addFile(fs, "dir/a.txt", "aaa");
			addFile(fs, "dir/b.txt", "bbb");
			addFile(fs, "dir/sub/c.txt", "ccc");
			const children = await fs.listDir("dir");
			const paths = children.map((c) => c.path).sort();
			expect(paths).toEqual(["dir/a.txt", "dir/b.txt", "dir/sub"]);
		});

		it("returns empty array for empty directory", async () => {
			await fs.mkdir("empty");
			const children = await fs.listDir("empty");
			expect(children).toEqual([]);
		});

		it("returns empty array for non-existent directory", async () => {
			const children = await fs.listDir("nope");
			expect(children).toEqual([]);
		});
	});

	// Real backends own their stored bytes and build a fresh FileEntity per call,
	// so a caller can never reach back through a returned value and mutate storage.
	describe("snapshot isolation (backend fidelity)", () => {
		it("write() does not alias the caller's buffer", async () => {
			const buf = new TextEncoder().encode("original").buffer.slice(0);
			await fs.write("a.txt", buf, 1000);
			new Uint8Array(buf).fill(0); // mutate the caller's buffer after writing
			expect(readText(fs, "a.txt")).toBe("original");
		});

		it("read() returns a detached copy each call", async () => {
			addFile(fs, "a.txt", "data");
			const first = await fs.read("a.txt");
			new Uint8Array(first).fill(0);
			expect(new TextDecoder().decode(await fs.read("a.txt"))).toBe(
				"data",
			);
		});

		it("list()/stat() return snapshots that cannot mutate stored state", async () => {
			addFile(fs, "a.txt", "data", 1000);
			const listed = (await fs.list()).find((e) => e.path === "a.txt")!;
			listed.mtime = 99999;
			listed.hash = "tampered";
			const fresh = await fs.stat("a.txt");
			expect(fresh!.mtime).toBe(1000);
			expect(fresh!.hash).not.toBe("tampered");
		});
	});
});
