# OAuth Worker

The **server side** of Google authentication for Air Sync. Performs server-side
Google OAuth token exchange so the Client Secret stays off the client. For the
**plugin side** (`GoogleAuth` / `GoogleAuthDirect`, token storage, refresh), see
[google-drive-backend.md → Authentication](google-drive-backend.md#authentication).

The source lives in this repository:

| Path | What | Host |
|------|------|------|
| [`oauth-worker/`](../oauth-worker) | Cloudflare Worker — receives the https callback, exchanges the code for tokens, and relays the result to `obsidian://` | `auth-airsync.takezo.dev` (Cloudflare Workers) |
| [`pages/`](../pages) | Static site — landing page, privacy policy, terms of service, custom-OAuth callback | `airsync.takezo.dev` (GitHub Pages) |

## Overview

Google OAuth requires redirect URIs to use `https://` — custom schemes like
`obsidian://` are not allowed for Web application clients. The Worker receives the
OAuth callback, exchanges the authorization code for tokens using the server-held
Client Secret, and redirects to `obsidian://` with the tokens.

```
[Plugin] → [Google OAuth] → [Worker: /google/callback]
                                 ↓ code → token exchange
                            [obsidian://air-sync-auth?access_token=...&refresh_token=...]
```

## Endpoints (`oauth-worker/`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/google/callback` | Google OAuth redirect → token exchange → `obsidian://` redirect |
| POST | `/google/token/refresh` | Refresh token → new access token (JSON) |

## `pages/callback/`

Custom OAuth redirect page for users who bring their own Google OAuth credentials.
Hosted on GitHub Pages at `airsync.takezo.dev/callback/`.

When a custom OAuth user completes Google sign-in, Google redirects to this page with
`?code=...&state=...`. The page then redirects to `obsidian://air-sync-auth?code=...&state=...`
so the plugin can exchange the code for tokens directly (with PKCE), without going
through the auth server.

Unlike the built-in flow (`/google/callback` on the Worker), no server-side token
exchange happens — the authorization code is passed through as-is.

**Dropbox reuses this same page — no Worker route.** Dropbox auth is in-plugin
Authorization Code + PKCE, so its callback returns `?code=...&state=...` exactly
like custom Google OAuth. The plugin generates the relay-compatible
`{app:"obsidian-plugin", nonce}` state, Dropbox redirects here, and this page
bounces it to `obsidian://air-sync-auth`, where the plugin exchanges the code for
tokens directly with Dropbox (the `code_verifier` is the proof — no client secret,
no `/dropbox/callback` Worker route). In short: the Worker is the **confidential**
path (server-held secret, needed only by built-in Google); `pages/callback` is the
**no-secret** path, shared by custom Google (PKCE) and Dropbox (PKCE).

## `pages/dropbox-folder/`

Hosts the **Dropbox Chooser** so the user can pick which remote folder a vault
syncs into. The plugin can't load the remote `dropins.js` inside Obsidian (remote
code is disallowed, and the Chooser validates the page origin), so it opens this
page in the browser — the same indirection as auth. The page loads the Chooser,
the user picks a folder, and it bounces the result to
`obsidian://air-sync-folder?id=…&name=…&state=…` (a backend-agnostic scheme,
kept separate from `air-sync-auth`), which `BackendManager.completeBackendFolderPick`
routes to the active backend's `completeWebFolderPick` to bind.

Two App-Folder caveats the code handles, because the Chooser **always browses the
whole Dropbox and can't be limited to the app folder**:

- Air Sync uses App Folder scope, so its token can only address ids under
  `/Apps/Air Sync/`. `DropboxProvider.completeWebFolderPick` verifies the picked
  id with `get_metadata` and rejects anything outside the app folder with a clear
  message rather than silently failing to sync.
- The page must be added to the **Chooser domain allowlist** in the Dropbox App
  Console (and the Chooser/Drop-ins capability enabled), or the Chooser renders
  "App is misconfigured" (`No valid entry page detected`).

## Infrastructure

| Domain | Host | Purpose |
|--------|------|---------|
| `airsync.takezo.dev` | GitHub Pages | Landing page, privacy policy, terms of service, custom-OAuth callback |
| `auth-airsync.takezo.dev` | Cloudflare Workers | OAuth token exchange relay |

## Local development

The relay has its own toolchain (Wrangler) and is **not** covered by the plugin gate
(`npm run lint && npm run build && npm test`) — it is excluded from the root ESLint,
TypeScript, and Vitest configs. Work on it from within `oauth-worker/`:

```bash
cd oauth-worker
npm install
npm run dev      # wrangler dev
npx tsc -noEmit  # type-check
```
