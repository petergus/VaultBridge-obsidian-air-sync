import type { App, TAbstractFile } from "obsidian";
import { Modal, Notice, Setting, TFolder } from "obsidian";
import type { SyncOrchestrator } from "../sync/orchestrator";
import type { IFileSystem } from "../fs/interface";
import { withTrashModalSuppressed } from "../utils/trash-suppression";

export interface DirectDeleteOptions {
	remoteFs: IFileSystem;
	orchestrator?: SyncOrchestrator;
	displayName: string;
	onDeleted?: () => void;
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
				text: "All files and subfolders inside this folder will be permanently removed from cloud storage as well.",
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

		new Notice(`Deleting "${name}" from the vault and ${displayName}...`);

		try {
			// 1. Delete on remote cloud storage (Google Drive/OneDrive/Dropbox)
			// Deleting a folder also evicts its whole subtree from the remote cache and
			// marks every descendant touched, so the checkpoint below records them all.
			await remoteFs.delete(path);
			await remoteFs.checkpoint?.commitCheckpoint();

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
			await withTrashModalSuppressed(() =>
				// eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- intentional permanent delete
				this.app.vault.delete(this.file, true),
			);

			new Notice(`Deleted "${name}" from the vault and ${displayName}.`);
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
