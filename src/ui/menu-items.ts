import type { App, EventRef, Menu, MenuItem, TAbstractFile } from "obsidian";
import { Notice } from "obsidian";
import type { BackendManager } from "../fs/backend-manager";
import type { SyncOrchestrator } from "../sync/orchestrator";

export interface ContextMenuDeps {
	app: App;
	backendManager: BackendManager;
	orchestrator?: SyncOrchestrator;
	registerEvent?: (ref: EventRef) => void;
	/** The only DOM listener the menu hooks need: a capturing window `contextmenu`. */
	registerDomEvent?: (
		el: Window,
		type: "contextmenu",
		callback: (evt: MouseEvent) => void,
		options?: boolean | AddEventListenerOptions,
	) => void;
	registerCleanup?: (cb: () => void) => void;
}

/**
 * Menus that already carry VaultBridge's "Open in <backend>" item. Several hooks can
 * see the same menu (core `file-menu`, Notebook Navigator, the `Menu.prototype`
 * fallback); this keeps the item from being added twice. A WeakSet, so a closed menu
 * is not kept alive.
 */
const menusWithOpenItem = new WeakSet<object>();

export function hasOpenItem(menu: object): boolean {
	return menusWithOpenItem.has(menu);
}

export function markOpenItemAdded(menu: object): void {
	menusWithOpenItem.add(menu);
}

/**
 * Mark the menu a `MenuItem` belongs to. Obsidian's `MenuItem` keeps a back-reference
 * to its menu that the public typings don't declare; items handed out by plugin APIs
 * (Notebook Navigator) only expose the item, so this is the way to reach the menu.
 */
export function markItemMenuAdded(item: MenuItem): void {
	const { menu } = item as unknown as { menu?: Menu };
	if (menu) markOpenItemAdded(menu);
}

export function getCleanDisplayName(rawName: string): string {
	const lower = rawName.toLowerCase();
	if (lower.includes("google drive")) return "Google Drive";
	if (lower.includes("onedrive")) return "OneDrive";
	if (lower.includes("dropbox")) return "Dropbox";
	return rawName;
}

/** True when the active backend can link to a file in its web UI. */
export function canOpenInRemote(deps: ContextMenuDeps): boolean {
	return !!deps.backendManager.getBackendProvider() && !!deps.backendManager.getRemoteFs()?.getWebUrl;
}

export function setupMenuItem(
	item: MenuItem,
	file: TAbstractFile,
	deps: ContextMenuDeps,
): void {
	const provider = deps.backendManager.getBackendProvider();
	if (!provider) return;

	const remoteFs = deps.backendManager.getRemoteFs();
	if (!remoteFs?.getWebUrl) return;

	const displayName = getCleanDisplayName(provider.displayName);
	const name = file.name || deps.app.vault.getName() || "Vault root";

	item
		.setTitle(`Open in ${displayName}`)
		.setIcon("external-link")
		.onClick(async () => {
			try {
				const currentFs = deps.backendManager.getRemoteFs();
				const url = await currentFs?.getWebUrl?.(file.path);
				if (url) {
					window.open(url);
				} else {
					new Notice(`"${name}" is not yet synced to ${displayName}`);
				}
			} catch {
				new Notice(`Failed to open "${name}" in ${displayName}`);
			}
		});
}

export function setupMultiMenuItem(
	item: MenuItem,
	files: readonly TAbstractFile[],
	deps: ContextMenuDeps,
): void {
	const provider = deps.backendManager.getBackendProvider();
	if (!provider) return;

	const remoteFs = deps.backendManager.getRemoteFs();
	if (!remoteFs?.getWebUrl) return;

	const displayName = getCleanDisplayName(provider.displayName);

	item
		.setTitle(`Open ${files.length} items in ${displayName}`)
		.setIcon("external-link")
		.onClick(async () => {
			let openedCount = 0;
			for (const file of files) {
				try {
					const currentFs = deps.backendManager.getRemoteFs();
					const url = await currentFs?.getWebUrl?.(file.path);
					if (url) {
						window.open(url);
						openedCount++;
					}
				} catch {
					// Ignore individual failure in multi-open
				}
			}
			if (openedCount === 0 && files.length > 0) {
				new Notice(`Selected items are not yet synced to ${displayName}`);
			}
		});
}
