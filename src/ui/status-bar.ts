import { setTooltip } from "obsidian";
import type { SyncStatus } from "../sync/orchestrator";

const STATUS_TEXT: Record<SyncStatus, string> = {
	idle: "Synced",
	syncing: "Syncing...",
	error: "Sync error",
	partial_error: "Synced (with errors)",
	not_connected: "Not connected",
};

/**
 * Render the sync status item. Held deletions take precedence: they need the user's
 * decision, so the item turns into a clickable "review" prompt until they are resolved.
 */
export function renderStatusBar(el: HTMLElement, status: SyncStatus, heldDeletions: number): void {
	if (heldDeletions > 0) {
		el.setText(`⚠️ ${heldDeletions} held deletion${heldDeletions === 1 ? "" : "s"}`);
		el.addClass("mod-clickable");
		setTooltip(el, "Click to review held deletions", { placement: "top" });
		return;
	}
	el.removeClass("mod-clickable");
	setTooltip(el, "", { placement: "top" });
	el.setText(STATUS_TEXT[status]);
}
