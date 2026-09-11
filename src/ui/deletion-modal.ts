import type { App, TAbstractFile } from "obsidian";
import { Modal, Notice, Setting, TFolder } from "obsidian";
import type { SyncOrchestrator } from "../sync/orchestrator";
import type { IFileSystem } from "../fs/interface";
import type { SyncAction } from "../sync/types";

export interface DirectDeleteOptions {
	remoteFs: IFileSystem;
	orchestrator?: SyncOrchestrator;
	displayName: string;
	onDeleted?: () => void;
}

/**
 * Summarize a list of held SyncActions by grouping by top-level or second-level directory.
 */
export function groupPendingDeletions(actions: readonly SyncAction[]): Map<string, number> {
	const groups = new Map<string, number>();
	for (const a of actions) {
		const parts = a.path.split("/");
		let groupKey = parts[0] ?? a.path;
		if (parts.length > 2) {
			// E.g. "02-projects/Active-Projects"
			groupKey = `${parts[0]}/${parts[1]}`;
		}
		groups.set(groupKey, (groups.get(groupKey) ?? 0) + 1);
	}
	return groups;
}

/**
 * Modal shown when SyncOrchestrator quarantines deletions because they exceed the safety limit.
 */
export class DeletionReviewModal extends Modal {
	private orchestrator: SyncOrchestrator;
	private onApproved?: () => void;

	constructor(app: App, orchestrator: SyncOrchestrator, onApproved?: () => void) {
		super(app);
		this.orchestrator = orchestrator;
		this.onApproved = onApproved;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		const pending = this.orchestrator.getPendingDeletions();

		contentEl.createEl("h2", { text: "VaultBridge: Mass deletions held" });

		if (pending.length === 0) {
			contentEl.createEl("p", {
				text: "No deletions are currently held for review. Everything is in sync.",
			});
			new Setting(contentEl).addButton((btn) => {
				btn.setButtonText("Close").onClick(() => this.close());
			});
			return;
		}

		contentEl.createEl("p", {
			text: `${pending.length} deletion(s) were quarantined by VaultBridge to protect your cloud storage against accidental data loss.`,
		});

		contentEl.createEl("p", {
			text: "If you intentionally deleted these files in Obsidian or via git, click 'Delete from remote storage' to apply the deletions to the cloud. If this was unintended, dismiss this modal to keep them safe on the cloud.",
			cls: "mod-warning",
		});

		const grouped = groupPendingDeletions(pending);
		const summaryBox = contentEl.createEl("div", { cls: "vaultbridge-deletion-summary" });
		const list = summaryBox.createEl("ul");
		for (const [prefix, count] of grouped.entries()) {
			list.createEl("li", {
				text: `${prefix} (${count} file${count === 1 ? "" : "s"})`,
			});
		}

		new Setting(contentEl)
			.addButton((btn) => {
				btn
					.setButtonText("Delete from remote storage")
					.setWarning()
					.onClick(async () => {
						this.close();
						new Notice(`Applying ${pending.length} deletions to remote storage...`);
						try {
							await this.orchestrator.approvePendingDeletions();
							this.onApproved?.();
						} catch (err) {
							new Notice(
								`Failed to apply deletions: ${err instanceof Error ? err.message : String(err)}`,
							);
						}
					});
			})
			.addButton((btn) => {
				btn.setButtonText("Decide later").onClick(() => {
					this.close();
				});
			});
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Modal to confirm intentional deletion of a file or folder from both Obsidian and remote cloud storage.
 */
export class DirectDeleteConfirmModal extends Modal {
	private file: TAbstractFile;
	private options: DirectDeleteOptions;

	constructor(app: App, file: TAbstractFile, options: DirectDeleteOptions) {
		super(app);
		this.file = file;
		this.options = options;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();

		const isFolder = this.file instanceof TFolder;
		const itemType = isFolder ? "folder" : "file";
		const { displayName } = this.options;

		contentEl.createEl("h2", {
			text: `Delete from vault & ${displayName}`,
		});

		contentEl.createEl("p", {
			text: `Are you sure you want to permanently delete the ${itemType} "${this.file.path}" from both your local vault and ${displayName}?`,
		});

		if (isFolder) {
			contentEl.createEl("p", {
				text: "⚠️ All files and subfolders inside this directory will be permanently removed from cloud storage as well.",
				cls: "mod-warning",
			});
		}

		new Setting(contentEl)
			.addButton((btn) => {
				btn
					.setButtonText("Delete permanently")
					.setWarning()
					.onClick(async () => {
						this.close();
						await this.executeDirectDelete();
					});
			})
			.addButton((btn) => {
				btn.setButtonText("Cancel").onClick(() => {
					this.close();
				});
			});
	}

	private async executeDirectDelete(): Promise<void> {
		const { remoteFs, orchestrator, displayName, onDeleted } = this.options;
		const path = this.file.path;
		const name = this.file.name || this.file.path.split("/").pop() || "item";
		const isFolder = this.file instanceof TFolder;

		new Notice(`Deleting "${name}" from Vault and ${displayName}...`);

		try {
			// 1. Delete on remote cloud storage (Google Drive/OneDrive/Dropbox)
			await remoteFs.delete(path);

			// 2. Clean up sync baseline store if orchestrator is provided
			if (orchestrator?.state) {
				if (isFolder) {
					const allRecords = await orchestrator.state.getAll();
					for (const rec of allRecords) {
						if (rec.path === path || rec.path.startsWith(`${path}/`)) {
							await orchestrator.state.delete(rec.path);
						}
					}
				} else {
					await orchestrator.state.delete(path);
				}
			}

			// 3. Delete in Obsidian vault
			// eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- intentional permanent delete
			await this.app.vault.delete(this.file, true);

			new Notice(`Successfully deleted "${name}" from Vault and ${displayName}.`);
			onDeleted?.();

			// 4. Settle sync
			if (orchestrator) {
				void orchestrator.runSync();
			}
		} catch (err) {
			new Notice(
				`Error deleting "${name}": ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	onClose(): void {
		const { contentEl } = this;
		contentEl.empty();
	}
}
