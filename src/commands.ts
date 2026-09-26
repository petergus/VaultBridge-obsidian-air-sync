import { Notice } from "obsidian";
import type VaultBridgePlugin from "./main";
import { getCleanDisplayName } from "./ui/menu-items";

/**
 * The plugin's command palette entries. Command IDs are a published API — users bind
 * hotkeys to them — so they are immutable once shipped (pinned by main-commands.test.ts).
 */
export function registerCommands(plugin: VaultBridgePlugin): void {
	plugin.addCommand({
		id: "sync-now",
		name: "Sync now",
		callback: () => {
			void plugin.runSync();
		},
	});
	plugin.addCommand({
		id: "rescan-vault",
		name: "Rescan vault (full reconcile)",
		callback: () => {
			void plugin.rescan();
		},
	});
	plugin.addCommand({
		id: "approve-held-deletions",
		name: "Approve held deletions",
		callback: () => {
			const count = plugin.orchestrator.getPendingDeletions().length;
			if (count === 0) {
				new Notice("No deletions are waiting for approval");
				return;
			}
			new Notice(`Applying ${count} held deletions`);
			void plugin.orchestrator.approvePendingDeletions();
		},
	});
	plugin.addCommand({
		id: "review-held-deletions",
		name: "Review held deletions",
		callback: () => {
			plugin.openDeletionReviewModal();
		},
	});
	plugin.addCommand({
		id: "open-active-file-in-remote",
		name: "Open active file in Google Drive",
		callback: () => openActiveFileInRemote(plugin),
	});
}

async function openActiveFileInRemote(plugin: VaultBridgePlugin): Promise<void> {
	const activeFile = plugin.app.workspace.getActiveFile();
	if (!activeFile) {
		new Notice("No active file to open");
		return;
	}
	const provider = plugin.backendManager.getBackendProvider();
	const remoteFs = plugin.backendManager.getRemoteFs();
	if (!provider || !remoteFs?.getWebUrl) {
		new Notice("Remote storage is not connected");
		return;
	}
	const displayName = getCleanDisplayName(provider.displayName);
	try {
		const url = await remoteFs.getWebUrl(activeFile.path);
		if (url) {
			window.open(url);
		} else {
			new Notice(`"${activeFile.name}" is not yet synced to ${displayName}`);
		}
	} catch {
		new Notice(`Failed to open "${activeFile.name}" in ${displayName}`);
	}
}
