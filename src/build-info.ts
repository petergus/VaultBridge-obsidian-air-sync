declare const __VAULTBRIDGE_BUILD_TIME__: string | undefined;

/** Build timestamp injected by esbuild (`YYYY-MM-DD HH:MM`), or `"dev"` in unbundled test runs. */
export function getBuildTimestamp(): string {
	return typeof __VAULTBRIDGE_BUILD_TIME__ === "string" ? __VAULTBRIDGE_BUILD_TIME__ : "dev";
}

/** Human-readable plugin version and last-updated build string shown in settings. */
export function formatPluginBuildInfo(version: string, buildTime = getBuildTimestamp()): string {
	return `v${version} · Last updated ${buildTime}`;
}
