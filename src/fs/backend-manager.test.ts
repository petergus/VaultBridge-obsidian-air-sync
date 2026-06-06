import { describe, it, expect, vi, beforeEach } from "vitest";
import { BackendManager, BackendManagerDeps } from "./backend-manager";
import type { IBackendProvider } from "./backend";
import type { AirSyncSettings } from "../settings";
import type { IFileSystem } from "./interface";
import type { Logger } from "../logging/logger";
import { AuthError } from "./errors";
import { mockSettings } from "../__mocks__/sync-test-helpers";

// Mock the registry to return our fake provider
vi.mock("./registry", () => ({
	getBackendProvider: (type: string) => {
		if (type === "test") return fakeProvider;
		return undefined;
	},
}));

let fakeProvider: IBackendProvider;
let fakeFs: IFileSystem;

function createDeps(
	settings: AirSyncSettings,
	overrides: Partial<BackendManagerDeps> = {},
): BackendManagerDeps {
	const noopLogger = {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		flush: vi.fn(),
	} as unknown as Logger;

	return {
		getSettings: () => settings,
		saveSettings: vi.fn().mockResolvedValue(undefined),
		getApp: (() => ({})) as unknown as BackendManagerDeps["getApp"],
		getLogger: () => noopLogger,
		getVaultName: () => "Test Vault",
		onConnected: vi.fn(),
		onDisconnected: vi.fn(),
		onIdentityChanged: vi.fn().mockResolvedValue(undefined),
		notify: vi.fn(),
		refreshSettingsDisplay: vi.fn(),
		...overrides,
	};
}

beforeEach(() => {
	fakeFs = {
		name: "test-remote",
		list: vi.fn().mockResolvedValue([]),
		stat: vi.fn().mockResolvedValue(null),
		read: vi.fn(),
		write: vi.fn(),
		mkdir: vi.fn(),
		delete: vi.fn(),
		rename: vi.fn(),
	} as unknown as IFileSystem;

	fakeProvider = {
		type: "test",
		displayName: "Test",
		auth: {
			isAuthenticated: () => true,
			startAuth: vi.fn(),
			completeAuth: vi.fn(),
		},
		createFs: () => fakeFs,
		isConnected: () => true,
		getIdentity: () => "test:folder-A",
		resetTargetState: vi.fn(),
		disconnect: vi.fn().mockResolvedValue({}),
	};
});

describe("BackendManager — identity change triggers onIdentityChanged", () => {
	it("does not call onIdentityChanged on first initBackend call", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(deps.onIdentityChanged).not.toHaveBeenCalled();
		expect(deps.onConnected).toHaveBeenCalled();
	});

	it("calls onIdentityChanged when identity changes between initBackend calls", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend(); // identity = "test:folder-A"

		// Change identity
		fakeProvider.getIdentity = () => "test:folder-B";
		await mgr.initBackend();

		expect(deps.onIdentityChanged).toHaveBeenCalledTimes(1);
	});

	it("does not call onIdentityChanged when identity stays the same", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();
		await mgr.initBackend();

		expect(deps.onIdentityChanged).not.toHaveBeenCalled();
	});

	it("calls onIdentityChanged and resets identity on disconnect", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();
		await mgr.disconnectBackend();

		expect(deps.onIdentityChanged).toHaveBeenCalledTimes(1);

		// After disconnect, re-init should not trigger another callback
		// (lastBackendIdentity was reset to null)
		(deps.onIdentityChanged as ReturnType<typeof vi.fn>).mockClear();
		await mgr.initBackend();
		expect(deps.onIdentityChanged).not.toHaveBeenCalled();
	});

	it("calls provider.resetTargetState on identity change", async () => {
		const resetSpy = vi.fn();
		fakeProvider.resetTargetState = resetSpy;

		const settings = mockSettings({
			backendData: {
				test: { changesStartPageToken: "old-token", other: "keep" },
			},
		});
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend(); // identity = "test:folder-A"

		fakeProvider.getIdentity = () => "test:folder-B";
		await mgr.initBackend();

		expect(resetSpy).toHaveBeenCalledTimes(1);
		expect(resetSpy).toHaveBeenCalledWith(settings);
	});
});

describe("BackendManager — auth error notification on initBackend", () => {
	it("notifies user when initBackend fails with AuthError", async () => {
		fakeProvider.resolveRemoteVault = () => {
			throw new AuthError("Token refresh failed", 400);
		};

		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(deps.notify).toHaveBeenCalledWith(
			"Authentication expired. Please reconnect in settings.",
		);
	});

	it("does not notify for non-auth errors", async () => {
		fakeProvider.resolveRemoteVault = () => {
			const err = new Error("Network error");
			(err as Error & { status: number }).status = 503;
			throw err;
		};

		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(deps.notify).not.toHaveBeenCalled();
	});
});

describe("BackendManager — isConnected false with prior connection", () => {
	it("notifies when isConnected is false but remoteVaultFolderId exists", async () => {
		fakeProvider.isConnected = () => false;

		const settings = mockSettings({
			backendData: { test: { remoteVaultFolderId: "folder-123" } },
		});
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(deps.notify).toHaveBeenCalledWith(
			"Authentication expired. Please reconnect in settings.",
		);
		expect(deps.onDisconnected).toHaveBeenCalled();
	});

	it("does not notify when isConnected is false and no prior connection", async () => {
		fakeProvider.isConnected = () => false;

		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(deps.notify).not.toHaveBeenCalled();
		expect(deps.onDisconnected).toHaveBeenCalled();
	});
});

describe("BackendManager — web folder pick", () => {
	it("startBackendFolderPick persists the provider's returned state", async () => {
		const settings = mockSettings();
		const startSpy = vi.fn().mockResolvedValue({ pendingFolderPickState: "S" });
		fakeProvider.startWebFolderPick = startSpy;
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);
		await mgr.initBackend();

		await mgr.startBackendFolderPick();

		expect(startSpy).toHaveBeenCalled();
		expect(settings.backendData.test).toMatchObject({ pendingFolderPickState: "S" });
	});

	it("notifies when the backend has no folder picker", async () => {
		const settings = mockSettings();
		delete fakeProvider.startWebFolderPick;
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);
		await mgr.initBackend();

		await mgr.startBackendFolderPick();

		expect(deps.notify).toHaveBeenCalledWith("This backend has no folder picker.");
	});

	it("completeBackendFolderPick binds the result, drops the checkpoint (→ cold sync), and re-inits", async () => {
		// Seed a committed delta checkpoint from the previous folder.
		const settings = mockSettings({ backendData: { test: { cursor: "OLD-CURSOR" } } });
		const completeSpy = vi.fn().mockResolvedValue({
			backendUpdates: { remoteVaultFolderId: "id:new", pendingFolderPickState: "" },
		});
		fakeProvider.completeWebFolderPick = completeSpy;
		// Real reset behaviour: clear the checkpoint so the next sync is a full cold reconcile.
		fakeProvider.resetTargetState = (s) => { delete (s.backendData.test as Record<string, unknown>).cursor; };
		const deps = createDeps(settings);
		const onConnected = deps.onConnected as ReturnType<typeof vi.fn>;
		const refreshSettingsDisplay = deps.refreshSettingsDisplay as ReturnType<typeof vi.fn>;
		const saveSettings = deps.saveSettings as ReturnType<typeof vi.fn>;
		const mgr = new BackendManager(deps);
		await mgr.initBackend();
		onConnected.mockClear();

		await mgr.completeBackendFolderPick({ id: "id:new", state: "S" });

		expect(completeSpy).toHaveBeenCalledWith(
			{ id: "id:new", state: "S" }, settings, "Test Vault", expect.anything(),
		);
		expect(settings.backendData.test).toMatchObject({ remoteVaultFolderId: "id:new" });
		// Changing folders drops the prior folder's delta cursor and persists it, so
		// hasCheckpoint() is false and the next sync runs cold (full reconcile).
		expect(settings.backendData.test?.cursor).toBeUndefined();
		expect(saveSettings).toHaveBeenCalled();
		expect(onConnected).toHaveBeenCalled(); // re-init created a fresh FS
		expect(refreshSettingsDisplay).toHaveBeenCalled();
	});

	it("completeBackendFolderPick holds the connecting flag across the bind", async () => {
		const settings = mockSettings();
		let connectingDuringBind = false;
		let release!: () => void;
		const blocker = new Promise<void>((r) => { release = r; });
		const mgr = new BackendManager(createDeps(settings));
		await mgr.initBackend();
		fakeProvider.completeWebFolderPick = vi.fn().mockImplementation(async () => {
			connectingDuringBind = mgr.isConnecting();
			await blocker;
			return { backendUpdates: { remoteVaultFolderId: "id:new", pendingFolderPickState: "" } };
		});

		const done = mgr.completeBackendFolderPick({ id: "id:new", state: "S" });
		await Promise.resolve();
		expect(connectingDuringBind).toBe(true); // sync is gated out during the bind
		release();
		await done;
		expect(mgr.isConnecting()).toBe(false);
	});

	it("completeBackendFolderPick notifies and does not re-init on a rejected selection", async () => {
		const settings = mockSettings();
		fakeProvider.completeWebFolderPick = vi.fn().mockRejectedValue(new Error("outside app folder"));
		const deps = createDeps(settings);
		const notify = deps.notify as ReturnType<typeof vi.fn>;
		const onConnected = deps.onConnected as ReturnType<typeof vi.fn>;
		const mgr = new BackendManager(deps);
		await mgr.initBackend();
		onConnected.mockClear();

		await mgr.completeBackendFolderPick({ id: "id:bad", state: "S" });

		expect(notify).toHaveBeenCalledWith("Folder selection failed: outside app folder");
		expect(onConnected).not.toHaveBeenCalled();
	});
});

describe("BackendManager — isConnecting flag", () => {
	it("returns false before initBackend is called", () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		expect(mgr.isConnecting()).toBe(false);
	});

	it("returns true while initBackend is in progress", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		let connectingDuringInit = false;
		let resolve!: () => void;
		const blocker = new Promise<void>((r) => {
			resolve = r;
		});

		fakeProvider.resolveRemoteVault = async () => {
			connectingDuringInit = mgr.isConnecting();
			await blocker;
			return { backendUpdates: {} };
		};

		const initPromise = mgr.initBackend();

		// Wait a tick for the async code to reach the blocker
		await Promise.resolve();

		expect(connectingDuringInit).toBe(true);
		resolve();
		await initPromise;
	});

	it("returns false after initBackend completes successfully", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(mgr.isConnecting()).toBe(false);
	});

	it("returns false after initBackend fails", async () => {
		fakeProvider.resolveRemoteVault = () => {
			throw new Error("network error");
		};

		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		expect(mgr.isConnecting()).toBe(false);
	});

	it("second concurrent call to initBackend is ignored (early return)", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		let resolve!: () => void;
		const blocker = new Promise<void>((r) => {
			resolve = r;
		});

		fakeProvider.resolveRemoteVault = async () => {
			await blocker;
			return { backendUpdates: {} };
		};

		const first = mgr.initBackend();
		const second = mgr.initBackend(); // should be ignored

		resolve();
		await Promise.all([first, second]);

		// onConnected should only be called once
		expect(deps.onConnected).toHaveBeenCalledTimes(1);
	});

	it("returns true while completeBackendConnect is in progress", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		// Ensure backendProvider is set
		await mgr.initBackend();

		let connectingDuringComplete = false;
		let resolve!: () => void;
		const blocker = new Promise<void>((r) => {
			resolve = r;
		});

		fakeProvider.auth.completeAuth = async () => {
			connectingDuringComplete = mgr.isConnecting();
			await blocker;
			return {};
		};

		const completePromise = mgr.completeBackendConnect("auth-code");

		await Promise.resolve();

		expect(connectingDuringComplete).toBe(true);
		resolve();
		await completePromise;
	});

	it("returns false after completeBackendConnect completes", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		fakeProvider.auth.completeAuth = () => Promise.resolve({});

		await mgr.completeBackendConnect("auth-code");

		expect(mgr.isConnecting()).toBe(false);
	});

	it("returns false after completeBackendConnect fails", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();

		fakeProvider.auth.completeAuth = () => {
			throw new Error("auth failed");
		};

		await mgr.completeBackendConnect("auth-code");

		expect(mgr.isConnecting()).toBe(false);
	});

	it("completeBackendConnect is ignored when initBackend is in progress", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		let resolve!: () => void;
		const blocker = new Promise<void>((r) => {
			resolve = r;
		});

		fakeProvider.resolveRemoteVault = async () => {
			await blocker;
			return { backendUpdates: {} };
		};

		const initPromise = mgr.initBackend();

		// completeBackendConnect should be ignored since connecting is true
		const completeSpy = vi.spyOn(fakeProvider.auth, "completeAuth");
		await mgr.completeBackendConnect("auth-code");

		expect(completeSpy).not.toHaveBeenCalled();

		resolve();
		await initPromise;
	});

	it("initBackend is ignored when completeBackendConnect is in progress", async () => {
		const settings = mockSettings();
		const deps = createDeps(settings);
		const mgr = new BackendManager(deps);

		await mgr.initBackend();
		(deps.onConnected as ReturnType<typeof vi.fn>).mockClear();

		let resolve!: () => void;
		const blocker = new Promise<void>((r) => {
			resolve = r;
		});

		fakeProvider.auth.completeAuth = async () => {
			await blocker;
			return {};
		};

		const completePromise = mgr.completeBackendConnect("auth-code");

		// initBackend should be ignored since connecting is true
		await mgr.initBackend();
		expect(deps.onConnected).not.toHaveBeenCalled();

		resolve();
		await completePromise;
	});
});
