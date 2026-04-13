// marketplace-api-handlers.ts
// IPC handler registration for marketplace auth flow and write endpoints.
// All operations requiring the bearer token live here in the main process —
// tokens never cross the contextBridge into the renderer bundle.

import { ipcMain, shell } from "electron";
import type { MarketplaceAuthStore } from "./marketplace-auth-store";
import { createMarketplaceApiClient, MARKETPLACE_API_HOST } from "../renderer/state/marketplace-api-client";
import type { PostRatingInput } from "../renderer/state/marketplace-api-client";

export function registerMarketplaceApiHandlers(store: MarketplaceAuthStore): void {
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
  ipcMain.handle("marketplace:auth:start", async () => {
    const out = await client.authStart();
    // Fix: open auth URL from main process — renderer sandbox cannot open external URLs
    await shell.openExternal(out.auth_url);
    return out;
  });

  ipcMain.handle("marketplace:auth:poll", async (_e, deviceCode: string) => {
    const res = await client.authPoll(deviceCode);
    if (res.status === "complete") {
      store.setToken(res.token);
      // TODO(Task 5): fetch /user from GitHub once that endpoint is available,
      // or decode user info from the JWT. For now only the token is stored;
      // user profile is populated lazily when the signed-in check fires.
    }
    return res;
  });

  // Auth state queries — renderer reads these to show signed-in/out state
  ipcMain.handle("marketplace:auth:signed-in", () => !!store.getToken());
  ipcMain.handle("marketplace:auth:user", () => store.getUser());
  ipcMain.handle("marketplace:auth:sign-out", () => store.signOut());

  // ── Write endpoints ───────────────────────────────────────────────────────
  // Thin pass-throughs to the Cloudflare Worker. Token is injected by the
  // client's getToken() callback above — renderer never sees the token value.

  ipcMain.handle("marketplace:install", (_e, pluginId: string) =>
    client.postInstall(pluginId),
  );

  ipcMain.handle("marketplace:rate", (_e, input: PostRatingInput) =>
    client.postRating(input),
  );

  ipcMain.handle("marketplace:rate:delete", (_e, pluginId: string) =>
    client.deleteRating(pluginId),
  );

  ipcMain.handle("marketplace:theme:like", (_e, themeId: string) =>
    client.toggleThemeLike(themeId),
  );

  ipcMain.handle("marketplace:report", (
    _e,
    input: { rating_user_id: string; rating_plugin_id: string; reason?: string },
  ) => client.postReport(input));
}
