import type { App, TextComponent } from "obsidian";
import { Setting } from "obsidian";
import type { AirSyncSettings } from "../settings";
import type {
	BackendConnectionActions,
	IBackendSettingsRenderer,
} from "./backend-settings";
import { getBackendProvider } from "../fs/registry";

/**
 * Renders Dropbox-specific settings UI: connection status and the in-plugin
 * PKCE OAuth flow.
 *
 * Note: the Dropbox app uses App folder scope, so access is confined to
 * `/Apps/<App>/<vault>` — Air Sync cannot see the rest of the user's Dropbox.
 */
export class DropboxSettingsRenderer implements IBackendSettingsRenderer {
	readonly backendType = "dropbox";

	render(
		containerEl: HTMLElement,
		settings: AirSyncSettings,
		_onSave: (updates: Record<string, unknown>) => Promise<void>,
		actions: BackendConnectionActions,
		_app: App,
	): void {
		const provider = getBackendProvider("dropbox");
		const isConnected = provider?.isConnected(settings) ?? false;

		const statusDesc = isConnected ? "● Connected" : "● Not connected";
		const statusClass = isConnected ? "air-sync-status-connected" : "air-sync-status-disconnected";
		const statusSetting = new Setting(containerEl)
			.setName("Connection status")
			.setDesc(statusDesc);
		statusSetting.settingEl.addClass(statusClass);
		statusSetting.addButton((button) =>
			button
				.setButtonText(isConnected ? "Disconnect" : "Connect to Dropbox")
				.onClick(async () => {
					if (isConnected) {
						await actions.disconnect();
					} else {
						await actions.startAuth();
					}
					actions.refreshDisplay();
				}),
		);

		// Remote vault folder (read-only). The path is NOT stored — resolve it live
		// from the folder id so it reflects the folder's current location.
		if (isConnected) {
			let pathField: TextComponent | undefined;
			new Setting(containerEl)
				.setName("Remote vault folder")
				.setDesc(
					"The folder this vault syncs into, inside the app folder. Use the button to pick a different folder.",
				)
				.addText((text) => {
					pathField = text.setValue("Resolving…").setDisabled(true);
				})
				.addButton((button) =>
					button
						.setButtonText("Choose folder")
						.onClick(async () => {
							await actions.startFolderPick();
						}),
				);
			provider?.getRemoteVaultDisplayPath?.(settings)
				.then((path) => pathField?.setValue(path ?? "(folder unavailable)"))
				.catch(() => pathField?.setValue("(couldn't resolve path)"));
		}
	}
}
