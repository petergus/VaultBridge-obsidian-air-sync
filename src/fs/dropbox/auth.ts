import { Notice, Platform, requestUrl } from "obsidian";
import type { IAuthProvider } from "../auth";
import type { ISecretStore } from "../secret-store";
import type { Logger } from "../../logging/logger";
import { AuthError } from "../errors";
import { setBackendSecret, hasBackendSecret } from "../token-store";
import type { DropboxTokenResponse } from "./types";

const AUTHORIZE_URL = "https://www.dropbox.com/oauth2/authorize";
const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const REVOKE_URL = "https://api.dropboxapi.com/2/auth/token/revoke";
/** Existing no-secret client-side relay (airsync.takezo.dev/callback → obsidian://). */
const REDIRECT_URI = "https://airsync.takezo.dev/callback";
const SCOPES = "files.metadata.read files.content.read files.content.write account_info.read";
const BACKEND_TYPE = "dropbox";
const AUTH_FAILED_COOLDOWN = 60_000;

/**
 * Public OAuth app key for the Air Sync Dropbox app (App folder permission).
 *
 * PKCE means there is NO client secret anywhere — the `code_verifier` is the
 * ephemeral proof. Register the app at https://www.dropbox.com/developers/apps,
 * add `https://airsync.takezo.dev/callback` as a redirect URI, and set this.
 */
const DROPBOX_CLIENT_ID = "REPLACE_WITH_DROPBOX_APP_KEY";

const RANDOM_CHARSET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Generate a cryptographically random string of the given length. */
function generateRandomString(length: number): string {
	const limit = 256 - (256 % RANDOM_CHARSET.length);
	const out: string[] = [];
	while (out.length < length) {
		const arr = new Uint8Array(length - out.length);
		crypto.getRandomValues(arr);
		for (const b of arr) {
			if (b < limit && out.length < length) out.push(RANDOM_CHARSET[b % RANDOM_CHARSET.length]!);
		}
	}
	return out.join("");
}

/** Compute the PKCE S256 challenge: base64url(SHA-256(verifier)). */
async function computeS256Challenge(verifier: string): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
	let base64 = "";
	for (const b of new Uint8Array(hash)) base64 += String.fromCharCode(b);
	return btoa(base64).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Build the CSRF `state` parameter. Its shape (`{app, nonce}`, base64) matches
 * what the existing `pages/callback` relay expects, so it bounces the callback
 * back to the Obsidian app — no Dropbox-specific worker route is needed.
 */
function generateState(): string {
	return btoa(JSON.stringify({ app: "obsidian-plugin", nonce: generateRandomString(32) }));
}

interface DropboxCallbackParams {
	code: string;
	state: string | undefined;
}

/** Parse the `obsidian://air-sync-auth?code=…&state=…` PKCE callback. */
function parseDropboxCallback(input: string): DropboxCallbackParams {
	const trimmed = input.trim();
	if (!trimmed) throw new Error("Auth callback is empty");
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new Error("Invalid auth callback URL");
	}
	const code = url.searchParams.get("code");
	if (!code) throw new Error("Missing code in auth callback");
	return { code, state: url.searchParams.get("state") ?? undefined };
}

/**
 * Dropbox token manager: holds the short-lived access token + long-lived refresh
 * token, refreshes on demand (PKCE refresh needs only `client_id` — no secret),
 * and dedupes concurrent refreshes. One instance per FS lifetime.
 */
export class DropboxAuth {
	private accessToken = "";
	private refreshToken = "";
	private accessTokenExpiry = 0;
	private refreshPromise: Promise<string> | null = null;
	private authFailedAt = 0;

	constructor(private clientId: string, private logger?: Logger) {}

	setTokens(refreshToken: string, accessToken: string, expiry: number): void {
		this.refreshToken = refreshToken;
		this.accessToken = accessToken;
		this.accessTokenExpiry = expiry;
		this.authFailedAt = 0;
	}

	getTokenState(): { refreshToken: string; accessToken: string; accessTokenExpiry: number } {
		return {
			refreshToken: this.refreshToken,
			accessToken: this.accessToken,
			accessTokenExpiry: this.accessTokenExpiry,
		};
	}

	async getAccessToken(forceRefresh = false): Promise<string> {
		if (!this.refreshToken && !this.accessToken) {
			throw new AuthError("Not authenticated. Please connect to Dropbox first.", 401);
		}
		if (this.authFailedAt > 0 && Date.now() - this.authFailedAt < AUTH_FAILED_COOLDOWN) {
			throw new AuthError("Authentication expired. Please reconnect in settings.", 401);
		}
		if (!forceRefresh && this.accessToken && Date.now() < this.accessTokenExpiry - 60_000) {
			return this.accessToken;
		}
		if (!this.refreshToken) {
			throw new AuthError("Dropbox session expired. Please reconnect in settings.", 401);
		}
		if (this.refreshPromise) return this.refreshPromise;
		this.refreshPromise = this.performRefresh();
		try {
			return await this.refreshPromise;
		} finally {
			this.refreshPromise = null;
		}
	}

	/** Exchange an authorization code for tokens (PKCE — no client secret). */
	async exchangeCode(code: string, codeVerifier: string): Promise<void> {
		const res = await requestUrl({
			url: TOKEN_URL,
			method: "POST",
			throw: false,
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				code_verifier: codeVerifier,
				client_id: this.clientId,
				redirect_uri: REDIRECT_URI,
			}).toString(),
		});
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`Token exchange failed: ${res.status} ${tokenErrorDetail(res)}`);
		}
		this.storeTokenResponse(res.json as DropboxTokenResponse);
	}

	private async performRefresh(): Promise<string> {
		this.logger?.info("Refreshing Dropbox access token");
		let res;
		try {
			res = await requestUrl({
				url: TOKEN_URL,
				method: "POST",
				throw: false,
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "refresh_token",
					refresh_token: this.refreshToken,
					client_id: this.clientId,
				}).toString(),
			});
		} catch (err) {
			this.logger?.error("Token refresh failed", { error: err instanceof Error ? err.message : String(err) });
			throw err;
		}
		if (res.status === 400 || res.status === 401) {
			this.authFailedAt = Date.now();
			throw new AuthError(`Token refresh failed: ${res.status} ${tokenErrorDetail(res)}`, res.status);
		}
		if (res.status < 200 || res.status >= 300) {
			throw new Error(`Token refresh failed: ${res.status} ${tokenErrorDetail(res)}`);
		}
		this.storeTokenResponse(res.json as DropboxTokenResponse);
		return this.accessToken;
	}

	private storeTokenResponse(token: DropboxTokenResponse): void {
		this.accessToken = token.access_token;
		this.accessTokenExpiry = Date.now() + token.expires_in * 1000;
		if (token.refresh_token) this.refreshToken = token.refresh_token;
		this.authFailedAt = 0;
	}

	async revokeToken(): Promise<void> {
		if (!this.accessToken) return;
		try {
			await requestUrl({
				url: REVOKE_URL,
				method: "POST",
				throw: false,
				headers: { Authorization: `Bearer ${this.accessToken}` },
			});
		} catch {
			this.logger?.warn("Failed to revoke Dropbox token (non-fatal)");
		}
	}
}

/** Extract a readable error detail from a Dropbox token-endpoint error response. */
function tokenErrorDetail(res: { json?: unknown; text?: string }): string {
	try {
		const json = res.json as { error_description?: string; error?: string } | undefined;
		if (json?.error_description) return json.error_description;
		if (json?.error) return json.error;
	} catch {
		// fall through to text
	}
	return typeof res.text === "string" ? res.text : "";
}

/**
 * Dropbox authentication provider — in-plugin Authorization Code + PKCE, fully
 * worker-less. The authorization code returns via the existing no-secret
 * `pages/callback` relay; this plugin exchanges it for tokens directly with
 * Dropbox using the ephemeral `code_verifier`.
 */
export class DropboxAuthProvider implements IAuthProvider {
	private tokenAuth: DropboxAuth | null = null;

	constructor(
		private secretStore: ISecretStore,
		private clientId: string = DROPBOX_CLIENT_ID,
		private logger?: Logger,
	) {}

	/** Get or lazily create the shared token manager (so refreshed tokens are persistable). */
	getOrCreateAuth(logger?: Logger): DropboxAuth {
		if (!this.tokenAuth) this.tokenAuth = new DropboxAuth(this.clientId, logger ?? this.logger);
		return this.tokenAuth;
	}

	/**
	 * A throwaway token manager, independent of the shared (FS-bound) instance. Use
	 * for one-off read calls (e.g. resolving the folder path for the settings UI)
	 * so they don't clobber the live sync's in-memory tokens / failure cooldown.
	 */
	createDetachedAuth(logger?: Logger): DropboxAuth {
		return new DropboxAuth(this.clientId, logger ?? this.logger);
	}

	getTokenState(): { refreshToken: string; accessToken: string; accessTokenExpiry: number } | null {
		return this.tokenAuth?.getTokenState() ?? null;
	}

	async revokeAuth(): Promise<void> {
		if (this.tokenAuth) await this.tokenAuth.revokeToken();
		this.tokenAuth = null;
	}

	isAuthenticated(_backendData: Record<string, unknown>): boolean {
		return hasBackendSecret(this.secretStore, BACKEND_TYPE, "refresh");
	}

	async startAuth(_backendData: Record<string, unknown>): Promise<Record<string, unknown>> {
		const codeVerifier = generateRandomString(64);
		const codeChallenge = await computeS256Challenge(codeVerifier);
		const state = generateState();
		const params = new URLSearchParams({
			client_id: this.clientId,
			response_type: "code",
			token_access_type: "offline",
			code_challenge: codeChallenge,
			code_challenge_method: "S256",
			scope: SCOPES,
			redirect_uri: REDIRECT_URI,
			state,
		});
		const url = `${AUTHORIZE_URL}?${params.toString()}`;
		if (Platform.isMobile) {
			window.location.href = url;
		} else {
			window.open(url);
		}
		new Notice("Complete authorization in your browser");
		return { pendingAuthState: state, pendingCodeVerifier: codeVerifier };
	}

	async completeAuth(input: string, backendData: Record<string, unknown>): Promise<Record<string, unknown>> {
		const params = parseDropboxCallback(input);
		const expectedState = backendData.pendingAuthState;
		if (typeof expectedState !== "string" || !expectedState || params.state !== expectedState) {
			throw new Error("State mismatch - possible CSRF attack");
		}
		const codeVerifier = backendData.pendingCodeVerifier;
		if (typeof codeVerifier !== "string" || !codeVerifier) {
			throw new Error("PKCE code verifier is missing. Please restart the authorization flow.");
		}

		const auth = this.getOrCreateAuth();
		await auth.exchangeCode(params.code, codeVerifier);
		const tokens = auth.getTokenState();
		setBackendSecret(this.secretStore, BACKEND_TYPE, "refresh", tokens.refreshToken);
		setBackendSecret(this.secretStore, BACKEND_TYPE, "access", tokens.accessToken);

		return { accessTokenExpiry: tokens.accessTokenExpiry, pendingAuthState: "", pendingCodeVerifier: "" };
	}
}
