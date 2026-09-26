import { Notice, Setting, TFile } from "obsidian";
import type VaultBridgePlugin from "../main";

/**
 * Alert panels drawn at the top of the settings tab for state that needs the user's
 * attention: unresolved merge conflicts, and deletions held for review.
 */

/** Files whose 3-way merge left conflict markers, each linking to the file. */
export function renderConflictsAlert(containerEl: HTMLElement, plugin: VaultBridgePlugin): void {
	const { app } = plugin;
	const conflictsContainer = containerEl.createDiv("sync-conflicts-settings-container");
	void plugin.conflictTracker.getTrackedPaths().then((paths) => {
		if (paths.size === 0) return;
		conflictsContainer.empty();

		const alertEl = conflictsContainer.createDiv("sync-conflicts-alert-box");

		new Setting(alertEl)
			.setName("Active sync conflicts")
			.setDesc("Open these files to resolve their conflicts (the remote version is inside a callout).")
			.setHeading();

		const listEl = alertEl.createEl("ul");
		for (const path of Array.from(paths).sort()) {
			const li = listEl.createEl("li");
			const link = li.createEl("a");
			link.setText(path);
			plugin.registerDomEvent(link, "click", (e) => {
				e.preventDefault();
				const file = app.vault.getAbstractFileByPath(path);
				if (file && file instanceof TFile) {
					void app.workspace.getLeaf().openFile(file);
					(app as unknown as { setting: { close: () => void } }).setting?.close();
				}
			});
		}
	});
}

/** Deletions quarantined by the mass-deletion guard, with review / approve actions. */
export function renderHeldDeletionsAlert(
	containerEl: HTMLElement,
	plugin: VaultBridgePlugin,
	onChanged: () => void,
): void {
	const pendingDeletions = plugin.orchestrator?.getPendingDeletions() ?? [];
	if (pendingDeletions.length === 0) return;

	const serverCount = pendingDeletions.filter((a) => a.action === "delete_remote").length;
	const localCount = pendingDeletions.filter((a) => a.action === "delete_local").length;
	const deletionsContainer = containerEl.createDiv("sync-deletions-settings-container");
	const alertEl = deletionsContainer.createDiv("sync-deletions-alert-box");

	const desc = serverCount > 0 && localCount > 0
		? `${pendingDeletions.length} deletions held for safety (${serverCount} server, ${localCount} local). Review before applying.`
		: serverCount > 0
		? `${serverCount} server deletion${serverCount === 1 ? "" : "s"} held for safety. Review before removing from cloud storage.`
		: `${localCount} local deletion${localCount === 1 ? "" : "s"} held for safety. Review before removing from this device.`;

	new Setting(alertEl)
		.setName("Held deletions awaiting review")
		.setDesc(desc)
		.setHeading()
		.addButton((btn) => {
			btn
				.setButtonText("Review deletions")
				.setCta()
				.onClick(() => {
					plugin.openDeletionReviewModal();
				});
		})
		.addButton((btn) => {
			btn
				.setButtonText("Approve all")
				.setWarning()
				.onClick(async () => {
					new Notice(`Applying ${pendingDeletions.length} held deletions...`);
					await plugin.orchestrator.approvePendingDeletions();
					onChanged();
				});
		});
}
