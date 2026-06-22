import { App, TFile } from "obsidian";

export const INDEX_PATH = "sync-conflicts.md";
export const CALLOUT_MARKER = "> [!sync-conflict]";

export class ConflictTracker {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	/**
	 * Reads the index file "sync-conflicts.md" and returns a Set of file paths listed in it.
	 */
	async getTrackedPaths(): Promise<Set<string>> {
		const exists = await this.app.vault.adapter.exists(INDEX_PATH);
		if (!exists) return new Set();

		try {
			const content = await this.app.vault.adapter.read(INDEX_PATH);
			const paths = new Set<string>();
			// Match Obsidian wiki links: [[path/to/file.md]]
			const regex = /- \[\[([^\]]+)\]\]/g;
			let match;
			while ((match = regex.exec(content)) !== null) {
				if (match[1] !== undefined) {
					paths.add(match[1].trim());
				}
			}
			return paths;
		} catch {
			return new Set();
		}
	}

	/**
	 * Write the list of conflicted file paths back to "sync-conflicts.md".
	 */
	async writeIndex(paths: Set<string>): Promise<void> {
		if (paths.size === 0) {
			const content = `# Sync Conflicts\n\nAll conflicts resolved!\n`;
			await this.app.vault.adapter.write(INDEX_PATH, content);
			return;
		}

		let content = `# Sync Conflicts\n\n`;
		content += `The following files have active conflicts. Once you resolve a conflict by removing the \`> [!sync-conflict]\` callout block(s) from the file, the file will be removed from this list on the next sync or file save.\n\n`;
		for (const path of Array.from(paths).sort()) {
			content += `- [[${path}]]\n`;
		}

		await this.app.vault.adapter.write(INDEX_PATH, content);
	}

	/**
	 * Add new conflicted paths, scan all tracked paths, and rewrite the index file.
	 */
	async updateIndex(newConflictedPaths: string[] = []): Promise<void> {
		const tracked = await this.getTrackedPaths();
		for (const path of newConflictedPaths) {
			tracked.add(path);
		}

		const active = new Set<string>();
		for (const path of tracked) {
			if (path === INDEX_PATH) continue;

			const exists = await this.app.vault.adapter.exists(path);
			if (!exists) {
				continue; // File deleted, count as resolved
			}

			try {
				const content = await this.app.vault.adapter.read(path);
				if (content.includes(CALLOUT_MARKER)) {
					active.add(path);
				}
			} catch {
				// If we can't read it, keep it in the list to be safe
				active.add(path);
			}
		}

		await this.writeIndex(active);
	}

	/**
	 * Reacts to a local file modification event. If the file is tracked in the index,
	 * scans it to see if it still has conflicts. If resolved, updates the index file.
	 */
	async handleFileModification(file: TFile): Promise<void> {
		if (file.path === INDEX_PATH) return;

		const tracked = await this.getTrackedPaths();
		if (!tracked.has(file.path)) return;

		try {
			const content = await this.app.vault.read(file);
			if (!content.includes(CALLOUT_MARKER)) {
				tracked.delete(file.path);
				await this.writeIndex(tracked);
			}
		} catch {
			// Ignore read failures on edit
		}
	}
}
