// Vite/vitest `?raw` imports resolve to the imported file's source as a string.
// Used by tests that assert on source text without executing the module.
declare module "*?raw" {
	const content: string;
	export default content;
}
