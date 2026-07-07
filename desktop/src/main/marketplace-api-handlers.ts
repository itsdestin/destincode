// marketplace-api-handlers.ts
// IPC handler registration for marketplace auth flow and write endpoints.
// All operations requiring the bearer token live here in the main process —
// tokens never cross the contextBridge into the renderer bundle.

import { ipcMain, shell } from "electron";
import type { MarketplaceAuthStore } from "./marketplace-auth-store";
import { createMarketplaceApiClient, MarketplaceApiError, MARKETPLACE_API_HOST } from "../renderer/state/marketplace-api-client";
import type { PostRatingInput, AuthStartResponse, AuthPollResponse } from "../renderer/state/marketplace-api-client";

// ── Discriminated union returned by all API-calling handlers ─────────────────
// WHY: Custom Error fields (MarketplaceApiError.status) are dropped by
// structuredClone across the contextBridge. Returning a plain object preserves
// the status code so the renderer can distinguish install-gate (403) from
// generic errors (Task 7+).
export type ApiResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

// Worker may return avatar_url: null (theoretical — GitHub always sets one);
// the store type uses a plain string, so normalize at this boundary.
// Accounts Phase 1: also carry display_name/handle so the stored profile reflects
// the account-native fields (both optional — pre-Phase-1 /auth/me omits them).
function toStoredUser(me: { id: string; login: string; avatar_url: string | null; display_name?: string; handle?: string | null }) {
  return { id: me.id, login: me.login, avatar_url: me.avatar_url ?? "", display_name: me.display_name, handle: me.handle ?? null };
}

async function wrap<T>(run: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    if (e instanceof MarketplaceApiError) return { ok: false, status: e.status, message: e.message };
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, message }; // status:0 = non-API error (network, parse, etc.)
  }
}

// ── Channel list for double-registration guard ────────────────────────────────
const CHANNELS = [
  "account:start",
  "account:poll",
  "account:signed-in",
  "account:user",
  "account:sign-out",
  "account:update-profile",
  "account:set-handle",
  "account:delete",
  "marketplace:install",
  "marketplace:rate",
  "marketplace:rate:delete",
  "marketplace:theme:like",
  "marketplace:report",
] as const;

export function registerMarketplaceApiHandlers(store: MarketplaceAuthStore): void {
  // WHY: ipcMain.handle throws on re-registration. Clear prior handlers so
  // hot-reload dev sessions (scripts/run-dev.sh) don't crash on reload.
  for (const ch of CHANNELS) ipcMain.removeHandler(ch);

  // Create one client instance shared across all handlers.
  // getToken() is called lazily per-request so sign-out takes effect immediately.
  const client = createMarketplaceApiClient({
    host: MARKETPLACE_API_HOST,
    getToken: () => store.getToken(),
  });

  // ── Auth: device-code flow ────────────────────────────────────────────────
  // Renderer calls authStart to receive a user_code + auth_url. Main process
  // opens the URL in the system browser (renderer cannot call shell.openExternal).
  // Renderer then polls authPoll until status === "complete".
  ipcMain.handle("account:start", (): Promise<ApiResult<AuthStartResponse>> =>
    wrap(async () => {
      const out = await client.authStart();
      // Fix: openExternal can fail on some Linux sandboxes (Flatpak, no URL handler).
      // Non-fatal — renderer shows the auth_url so the user can copy-paste it.
      await shell.openExternal(out.auth_url).catch(err =>
        console.warn("[marketplace] openExternal failed; user must open URL manually:", err)
      );
      return out;
    })
  );

  ipcMain.handle("account:poll", (_e, deviceCode: string): Promise<ApiResult<AuthPollResponse>> =>
    wrap(async () => {
      const res = await client.authPoll(deviceCode);
      if (res.status === "complete") {
        // The Worker now returns the user profile alongside the token — store
        // both together so `user()` works immediately after sign-in. WHY: the
        // games lobby needs user.login as the player tag; storing only the
        // token left the profile null forever (the stuck-"Connecting…" bug).
        if (res.user) {
          store.setSession(res.token, toStoredUser(res.user));
        } else {
          store.setToken(res.token); // older Worker without `user` in the payload
        }
      }
      return res;
    })
  );

  // Auth state queries — local reads, plus a one-time lazy heal for `user`.
  ipcMain.handle("account:signed-in", () => !!store.getToken());
  ipcMain.handle("account:user", async () => {
    const cached = store.getUser();
    if (cached) return cached;
    // Heal path: a token stored before profile storage existed (pre-2026-07
    // sign-ins) has no user. Fetch it once from /auth/me and persist. On any
    // failure (offline, revoked session) return null — same as signed-out for
    // profile consumers; the token itself stays untouched.
    const token = store.getToken();
    if (!token) return null;
    try {
      const stored = toStoredUser(await client.authMe());
      store.setSession(token, stored);
      return stored;
    } catch {
      return null;
    }
  });
  // Sign-out now revokes server-side too (spec §1) — best-effort: if the
  // Worker is unreachable, the local clear still wins (never trap the user
  // signed-in). The 90-day expiry + prune cron mop up the orphaned row.
  ipcMain.handle("account:sign-out", async () => {
    try { await client.logout(); } catch { /* offline sign-out is fine */ }
    store.signOut();
  });

  // Update the account display name, then mirror the new value into the stored
  // profile so `account:user` reflects it without a round-trip to /auth/me.
  ipcMain.handle("account:update-profile", (_e, displayName: string): Promise<ApiResult<{ display_name: string }>> =>
    wrap(async () => {
      const out = await client.updateProfile(displayName);
      const user = store.getUser();
      if (user) store.setSession(store.getToken()!, { ...user, display_name: out.display_name });
      return out;
    })
  );

  // Claim/change the unique @handle, then mirror it into the stored profile.
  ipcMain.handle("account:set-handle", (_e, handle: string): Promise<ApiResult<{ handle: string }>> =>
    wrap(async () => {
      const out = await client.setHandle(handle);
      const user = store.getUser();
      if (user) store.setSession(store.getToken()!, { ...user, handle: out.handle });
      return out;
    })
  );

  // Permanent hard-delete (Worker cascades all rows). Clear the local session
  // too — the token is dead server-side, so keeping it would only confuse the UI.
  ipcMain.handle("account:delete", (): Promise<ApiResult<void>> =>
    wrap(async () => {
      await client.deleteAccount();
      store.signOut();
    })
  );

  // ── Write endpoints ───────────────────────────────────────────────────────
  // Wrapped in ApiResult so the renderer preserves HTTP status across the
  // contextBridge (structuredClone drops custom Error fields).

  ipcMain.handle("marketplace:install", (_e, pluginId: string): Promise<ApiResult<void>> =>
    wrap(() => client.postInstall(pluginId))
  );

  ipcMain.handle("marketplace:rate", (_e, input: PostRatingInput): Promise<ApiResult<{ hidden: boolean }>> =>
    wrap(() => client.postRating(input))
  );

  ipcMain.handle("marketplace:rate:delete", (_e, pluginId: string): Promise<ApiResult<void>> =>
    wrap(() => client.deleteRating(pluginId))
  );

  ipcMain.handle("marketplace:theme:like", (_e, themeId: string): Promise<ApiResult<{ liked: boolean }>> =>
    wrap(() => client.toggleThemeLike(themeId))
  );

  ipcMain.handle("marketplace:report", (
    _e,
    input: { rating_user_id: string; rating_plugin_id: string; reason?: string },
  ): Promise<ApiResult<void>> =>
    wrap(() => client.postReport(input))
  );
}
