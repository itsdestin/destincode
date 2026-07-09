// social-handlers.ts
// IPC handler registration for the accounts Phase 2 social graph (friends,
// requests, blocks). Structurally a sibling of marketplace-api-handlers.ts:
// every call needs the bearer token, so all logic lives in the main process —
// the token never crosses the contextBridge into the renderer bundle.

import { ipcMain } from "electron";
import type { MarketplaceAuthStore } from "./marketplace-auth-store";
import { createMarketplaceApiClient, MARKETPLACE_API_HOST } from "../renderer/state/marketplace-api-client";
import type {
  ApiResult,
} from "./marketplace-api-handlers";
import type {
  SocialUserCard, FriendRow, RequestsPayload, BlockRow,
} from "../renderer/state/marketplace-api-client";
// wrap + the 401-clear closure are shared with marketplace-api-handlers.ts via
// handler-utils.ts so the renderer sees ONE consistent ApiResult error contract
// across account:* and social:* — .status must survive the contextBridge.
import { wrap, makeClearSessionOn401 } from "./handler-utils";

// ── Channel list for double-registration guard ───────────────────────────────
// Byte-identical to the strings in preload.ts (IPC.SOCIAL_*), remote-shim.ts,
// and SessionService.kt. Pinned by the social:* parity describe in
// tests/ipc-channels.test.ts — drift silently breaks one platform.
const CHANNELS = [
  "social:lookup-handle",
  "social:send-request",
  "social:list-requests",
  "social:accept-request",
  "social:decline-request",
  "social:cancel-request",
  "social:list-friends",
  "social:unfriend",
  "social:block",
  "social:unblock",
  "social:list-blocks",
] as const;

export function registerSocialHandlers(store: MarketplaceAuthStore): void {
  // WHY: ipcMain.handle throws on re-registration. Clear prior handlers so
  // hot-reload dev sessions (scripts/run-dev.sh) don't crash on reload.
  for (const ch of CHANNELS) ipcMain.removeHandler(ch);

  // One client instance shared across all handlers. getToken() is read lazily
  // per-request so sign-out takes effect immediately.
  const client = createMarketplaceApiClient({
    host: MARKETPLACE_API_HOST,
    getToken: () => store.getToken(),
  });

  // Shared 401-reaction (see handler-utils.ts for the full WHY): a dead session
  // server-side clears the local token so the UI flips to signed-out.
  const clearSessionOn401 = makeClearSessionOn401(store);

  // All handlers return ApiResult<T> so the renderer preserves HTTP status across
  // the contextBridge (structuredClone drops MarketplaceApiError.status). The
  // friends UI needs .status to distinguish 404 (unknown/blocked handle),
  // 429 (caps), and 400 (self-request). Args are POSITIONAL here to match
  // preload.ts (which passes them positionally); remote-shim.ts object-wraps them
  // for the Android SessionService, which reads them via optString.

  ipcMain.handle("social:lookup-handle", (_e, handle: string): Promise<ApiResult<SocialUserCard>> =>
    wrap(() => client.lookupHandle(handle)).then(clearSessionOn401)
  );

  ipcMain.handle("social:send-request", (_e, handle: string): Promise<ApiResult<{ status: "pending" | "friends" }>> =>
    wrap(() => client.sendRequest(handle)).then(clearSessionOn401)
  );

  ipcMain.handle("social:list-requests", (): Promise<ApiResult<RequestsPayload>> =>
    wrap(() => client.listRequests()).then(clearSessionOn401)
  );

  ipcMain.handle("social:accept-request", (_e, id: string): Promise<ApiResult<void>> =>
    wrap(() => client.acceptRequest(id)).then(clearSessionOn401)
  );

  ipcMain.handle("social:decline-request", (_e, id: string): Promise<ApiResult<void>> =>
    wrap(() => client.declineRequest(id)).then(clearSessionOn401)
  );

  ipcMain.handle("social:cancel-request", (_e, id: string): Promise<ApiResult<void>> =>
    wrap(() => client.cancelRequest(id)).then(clearSessionOn401)
  );

  ipcMain.handle("social:list-friends", (): Promise<ApiResult<FriendRow[]>> =>
    wrap(() => client.listFriends()).then(clearSessionOn401)
  );

  ipcMain.handle("social:unfriend", (_e, userId: string): Promise<ApiResult<void>> =>
    wrap(() => client.unfriend(userId)).then(clearSessionOn401)
  );

  ipcMain.handle("social:block", (_e, userId: string): Promise<ApiResult<void>> =>
    wrap(() => client.block(userId)).then(clearSessionOn401)
  );

  ipcMain.handle("social:unblock", (_e, userId: string): Promise<ApiResult<void>> =>
    wrap(() => client.unblock(userId)).then(clearSessionOn401)
  );

  ipcMain.handle("social:list-blocks", (): Promise<ApiResult<BlockRow[]>> =>
    wrap(() => client.listBlocks()).then(clearSessionOn401)
  );
}
