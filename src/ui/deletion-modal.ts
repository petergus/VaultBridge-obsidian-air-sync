import type { App } from "obsidian";
import { Modal, Notice, Setting } from "obsidian";
import type { SyncOrchestrator } from "../sync/orchestrator";
import type { SyncAction } from "../sync/types";

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
	private pills: { id: DeletionFilter; el: HTMLElement }[] = [];

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
		this.pills = [];

		const pending = this.orchestrator.getPendingDeletions();

		contentEl.createEl("h2", { text: "Review held deletions" });

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
			this.pills.push({ id: f.id, el: pill });
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
		for (const { id, el } of this.pills) {
			if (id === this.activeFilter) el.addClass("mod-active");
			else el.removeClass("mod-active");
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
