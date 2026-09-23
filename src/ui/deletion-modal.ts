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

type DeletionFilter = "all" | "server" | "local";

/**
 * Modal shown when SyncOrchestrator quarantines deletions because they exceed the safety limit.
 * Provides a rich interface to review, search, filter, copy, and approve held deletions.
 */
export class DeletionReviewModal extends Modal {
	private orchestrator: SyncOrchestrator;
	private onApproved?: () => void;
	private activeFilter: DeletionFilter = "all";
	private searchQuery = "";
	private dynamicContainer: HTMLElement | null = null;
	private pillElements: HTMLElement[] = [];

	constructor(app: App, orchestrator: SyncOrchestrator, onApproved?: () => void) {
		super(app);
		this.orchestrator = orchestrator;
		this.onApproved = onApproved;
	}

	onOpen(): void {
		this.modalEl?.addClass("vaultbridge-deletion-modal");
		this.renderModal();
	}

	private renderModal(): void {
		const { contentEl } = this;
		contentEl.empty();
		this.pillElements = [];

		const pending = this.orchestrator.getPendingDeletions();

		contentEl.createEl("h2", { text: "VaultBridge: Review Held Deletions" });

		if (pending.length === 0) {
			contentEl.createEl("p", {
				text: "No deletions are currently held for review. Everything is in sync.",
			});
			new Setting(contentEl).addButton((btn) => {
				btn.setButtonText("Close").onClick(() => this.close());
			});
			return;
		}

		const serverDeletions = pending.filter((a) => a.action === "delete_remote");
		const localDeletions = pending.filter((a) => a.action === "delete_local");

		contentEl.createEl("p", {
			text: `${pending.length} deletion(s) were quarantined by VaultBridge to protect against accidental data loss. Review the items below before approving.`,
		});

		// Stat cards
		const statCardsContainer = contentEl.createDiv("vaultbridge-deletion-stat-cards");

		const totalCard = statCardsContainer.createDiv("vaultbridge-deletion-stat-card");
		totalCard.createDiv({ text: String(pending.length), cls: "vaultbridge-stat-value" });
		totalCard.createDiv({ text: "Total held", cls: "vaultbridge-stat-label" });

		const serverCard = statCardsContainer.createDiv("vaultbridge-deletion-stat-card");
		serverCard.createDiv({ text: String(serverDeletions.length), cls: "vaultbridge-stat-value" });
		serverCard.createDiv({ text: "Server deletions (Cloud)", cls: "vaultbridge-stat-label" });

		const localCard = statCardsContainer.createDiv("vaultbridge-deletion-stat-card");
		localCard.createDiv({ text: String(localDeletions.length), cls: "vaultbridge-stat-value" });
		localCard.createDiv({ text: "Local deletions (Device)", cls: "vaultbridge-stat-label" });

		// Quarantined explanation
		const desc = serverDeletions.length > 0 && localDeletions.length === 0
			? "These files were deleted locally in your vault and are held before being removed from remote cloud storage."
			: localDeletions.length > 0 && serverDeletions.length === 0
			? "These files were deleted in cloud storage (or another device) and are held before being removed from this local vault."
			: "These deletions include both cloud removals (deleted locally) and local removals (deleted in cloud).";

		contentEl.createEl("p", {
			text: desc,
			cls: "mod-warning",
		});

		// Filter & Search Toolbar
		const toolbarEl = contentEl.createDiv("vaultbridge-deletion-toolbar");

		const filterPillsEl = toolbarEl.createDiv("vaultbridge-filter-pills");
		const filters: { id: DeletionFilter; label: string; count: number }[] = [
			{ id: "all", label: "All", count: pending.length },
			{ id: "server", label: "Server deletions", count: serverDeletions.length },
			{ id: "local", label: "Local deletions", count: localDeletions.length },
		];

		for (const f of filters) {
			const pill = filterPillsEl.createEl("button", {
				cls: `vaultbridge-filter-pill ${this.activeFilter === f.id ? "mod-active" : ""}`,
				text: `${f.label} (${f.count})`,
			});
			this.pillElements.push(pill);
			pill.addEventListener("click", () => {
				this.activeFilter = f.id;
				this.renderListSection(pending);
			});
		}

		// Search input
		const searchInput = toolbarEl.createEl("input", {
			cls: "vaultbridge-deletion-search-input",
			placeholder: "Filter by file or folder path...",
			type: "text",
			value: this.searchQuery,
		});
		searchInput.addEventListener("input", (e) => {
			this.searchQuery = (e.target as HTMLInputElement).value;
			this.renderListSection(pending);
		});

		// Copy paths button
		const copyBtn = toolbarEl.createEl("button", {
			cls: "vaultbridge-copy-btn",
			text: "Copy paths",
		});
		copyBtn.addEventListener("click", () => {
			const visible = this.getFilteredActions(pending);
			const pathList = visible.map((a) => `${a.action === "delete_remote" ? "[Server]" : "[Local]"} ${a.path}`).join("\n");
			void this.copyToClipboard(pathList, visible.length);
		});

		// Container for the dynamic list and footer
		this.dynamicContainer = contentEl.createDiv("vaultbridge-deletion-dynamic-container");
		this.renderListSection(pending);
	}

	private getFilteredActions(pending: SyncAction[]): SyncAction[] {
		return pending.filter((a) => {
			if (this.activeFilter === "server" && a.action !== "delete_remote") return false;
			if (this.activeFilter === "local" && a.action !== "delete_local") return false;
			if (this.searchQuery.trim()) {
				const q = this.searchQuery.toLowerCase().trim();
				if (!a.path.toLowerCase().includes(q)) return false;
			}
			return true;
		});
	}

	private renderListSection(pending: SyncAction[]): void {
		if (!this.dynamicContainer) return;
		this.dynamicContainer.empty();

		// Update active pills
		for (const p of this.pillElements) {
			const text = (p as any).text ?? p.textContent ?? "";
			if (
				(this.activeFilter === "all" && text.startsWith("All")) ||
				(this.activeFilter === "server" && text.startsWith("Server")) ||
				(this.activeFilter === "local" && text.startsWith("Local"))
			) {
				p.addClass("mod-active");
			} else {
				p.removeClass("mod-active");
			}
		}

		const filtered = this.getFilteredActions(pending);

		// List container
		const listContainer = this.dynamicContainer.createDiv("vaultbridge-deletion-list");

		if (filtered.length === 0) {
			listContainer.createDiv({
				cls: "vaultbridge-empty-list",
				text: "No deletions match your search or filter.",
			});
		} else {
			for (const action of filtered) {
				const row = listContainer.createDiv("vaultbridge-deletion-row");
				row.setAttribute("title", action.path);

				const pathEl = row.createDiv("vaultbridge-deletion-path");
				const parts = action.path.split("/");
				const filename = parts.pop() ?? action.path;
				const folder = parts.join("/");

				if (folder) {
					pathEl.createSpan({ text: `${folder}/`, cls: "vaultbridge-deletion-folder" });
				}
				pathEl.createSpan({ text: filename, cls: "vaultbridge-deletion-filename" });

				const isServer = action.action === "delete_remote";
				row.createSpan({
					text: isServer ? "Server (Cloud)" : "Local (Device)",
					cls: `vaultbridge-badge ${isServer ? "vaultbridge-badge-remote" : "vaultbridge-badge-local"}`,
				});
			}
		}

		// Action buttons footer
		const footerSetting = new Setting(this.dynamicContainer);

		const isSubset = filtered.length !== pending.length;
		const approveText = isSubset
			? `Approve displayed deletions (${filtered.length})`
			: `Approve all deletions (${pending.length})`;

		if (filtered.length > 0) {
			footerSetting.addButton((btn) => {
				btn
					.setButtonText(approveText)
					.setWarning()
					.onClick(async () => {
						this.close();
						const actionsToApply = isSubset ? filtered : pending;
						new Notice(`Applying ${actionsToApply.length} deletion(s)...`);
						try {
							await this.orchestrator.approvePendingDeletions(actionsToApply);
							this.onApproved?.();
						} catch (err) {
							new Notice(
								`Failed to apply deletions: ${err instanceof Error ? err.message : String(err)}`,
							);
						}
					});
			});
		}

		if (isSubset) {
			footerSetting.addButton((btn) => {
				btn.setButtonText(`Approve all (${pending.length})`).onClick(async () => {
					this.close();
					new Notice(`Applying all ${pending.length} deletions...`);
					try {
						await this.orchestrator.approvePendingDeletions(pending);
						this.onApproved?.();
					} catch (err) {
						new Notice(
							`Failed to apply deletions: ${err instanceof Error ? err.message : String(err)}`,
						);
					}
				});
			});
		}

		footerSetting.addButton((btn) => {
			btn.setButtonText("Decide later").onClick(() => {
				this.close();
			});
		});
	}

	private async copyToClipboard(text: string, count: number): Promise<void> {
		try {
			if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(text);
				new Notice(`Copied ${count} file path${count === 1 ? "" : "s"} to clipboard.`);
				return;
			}
		} catch {
			// Fallback
		}
		new Notice(`Clipboard copy unavailable.`);
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
			if (isFolder) {
				await (remoteFs as any).cacheMutex?.run?.(() => {
					const cache = (remoteFs as any).cache;
					if (cache) {
						const prefix = `${path}/`;
						for (const [p] of cache.entries()) {
							if (p.startsWith(prefix)) {
								cache.removeEntry(p);
								(remoteFs as any).touchedPaths?.add(p);
							}
						}
					}
				});
			}
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
			(this.app as any).__vaultbridge_suppress_trash_modal = true;
			try {
				// eslint-disable-next-line obsidianmd/prefer-file-manager-trash-file -- intentional permanent delete
				await this.app.vault.delete(this.file, true);
			} finally {
				delete (this.app as any).__vaultbridge_suppress_trash_modal;
			}

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
