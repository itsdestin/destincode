// handler-utils.ts
// Shared helpers for token-bound IPC handler modules (marketplace-api-handlers.ts
// and social-handlers.ts). Extracted so the two modules can't drift on the error
// contract the renderer relies on. The ApiResult type itself stays in
// marketplace-api-handlers.ts (its historical home — preload.ts imports it from
// there); this module holds only behavior.

import type { MarketplaceAuthStore } from "./marketplace-auth-store";
import { MarketplaceApiError } from "../renderer/state/marketplace-api-client";
import type { ApiResult } from "./marketplace-api-handlers";
import { log } from "./logger";

// WHY: Custom Error fields (MarketplaceApiError.status) are dropped by
// structuredClone across the contextBridge. Returning a plain object preserves
// the status code so the renderer can distinguish install-gate (403) / not-found
// (404) / caps (429) from generic errors.
export async function wrap<T>(run: () => Promise<T>): Promise<ApiResult<T>> {
  try {
    return { ok: true, value: await run() };
  } catch (e) {
    if (e instanceof MarketplaceApiError) return { ok: false, status: e.status, message: e.message };
    const message = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, message }; // status:0 = non-API error (network, parse, etc.)
  }
}

// Fix: a 401 from an auth'd endpoint means the server no longer recognizes this
// session (identity-migration row drop, 90-day idle expiry, revocation). Keeping
// the local token would strand the user "signed in" with every call failing
// (the exact bug: post-migration users saw the handle prompt, typed a handle,
// got "invalid token" and no way out). Clear the local session so the UI flips
// to signed-out and offers a fresh sign-in. This only REACTS to a 401 that
// already happened — it never proactively validates. Returned as a closure so
// each handler module binds it to its own auth store once at registration.
//
// IT MUST NOT BE SILENT. Until now it was: no toast, no renderer event beyond
// the sign-in state flipping, and no log line. The user is unhooked from their
// account with zero feedback, presence drops with it, friends see them offline
// forever, and they only find out by opening the friends panel — a symptom
// indistinguishable from the separate presence-latch wedge. With nothing
// written down, neither the user nor a later session could tell the two apart
// after the fact.
//
// `surface` is bound once per handler module (social / marketplace / arcade)
// rather than per call, because there are 3 registration sites and 19 call
// sites, and the subsystem plus the server's own message is enough to tell
// which one 401'd. The message is the SERVER'S, never a guess of ours
// (docs/error-message-standards.md).
//
// Only logged when a session actually existed: several calls can 401 in one
// burst, and signOut() is idempotent, so this would otherwise write one line
// per in-flight request for a single sign-out event.
//
// STILL MISSING, deliberately: the user-facing notice. Part 4 of
// docs/active/specs/2026-08-11-presence-self-healing-design.md asks for a log
// line AND a notice; the notice needs a surface and copy decision on an auth
// screen. This half makes the event diagnosable; it does not yet make it
// visible.
export function makeClearSessionOn401(store: MarketplaceAuthStore, surface: string) {
  return <T>(result: ApiResult<T>): ApiResult<T> => {
    if (!result.ok && result.status === 401) {
      const hadSession = store.getToken() !== null;
      store.signOut();
      if (hadSession) {
        log('WARN', 'Auth', 'account session cleared — a call came back 401', {
          surface,
          serverMessage: result.message,
        });
      }
    }
    return result;
  };
}
