// Holder-side takeover sequence (Plan 2b Task 8). When another device asks to
// take over a conversation THIS device currently holds, the lease client's
// onTakeoverRequest fires this handler. It cleanly hands the session off:
//   1. reverse-map the claude id -> the LIVE desktop session(s) holding it
//   2. if none live: just release the lease and stop (nothing to hand off)
//   3. interrupt the in-flight turn (single ESC byte to the PTY)
//   4-5. wait for CC to flush the interrupted turn, then push local->space
//   6. release the lease so the requester can acquire
//   7. tell the renderer + remote the conversation moved (BEFORE destroy)
//   8. end the local session (fires session-exit -> Task 7 cleanup)
//
// Extracted into an injected-deps factory (not inlined in ipc-handlers) so it's
// unit-testable — the real handler needs sessionIdMap, which is local to
// registerIpcHandlers. NEVER throws: it's invoked fire-and-forget from a hub
// event, so every step is independently try/caught (a mid-step failure must not
// abort the rest of the handoff, and must never surface as an unhandled rejection
// in Electron main).

export interface HolderTakeoverDeps {
  sessionManager: {
    getSession(id: string): unknown | undefined;
    sendInput(id: string, text: string): boolean;
    destroySession(id: string): boolean;
  };
  sessionIdMap: Map<string, string>;                    // desktopId -> claudeId
  leaseClient: { release(sessionId: string): Promise<void> };
  flushSessionToSpace: (claudeSessionId: string) => Promise<void>;
  pushMoved: (desktopId: string, device?: string) => void;  // dual-path push (renderer + remote)
}

// Returns the async handler wired to the lease client's onTakeoverRequest.
export function createHolderTakeover(deps: HolderTakeoverDeps):
  (claudeId: string, from?: { deviceId: string; device: string }) => Promise<void> {
  return async (claudeId, from) => {
    // 1. Reverse-map the claude id to the LIVE desktop session(s) holding it. A
    //    stale map entry (missed exit) is filtered out by the getSession check.
    const liveDesktopIds = [...deps.sessionIdMap.entries()]
      .filter(([, cid]) => cid === claudeId)
      .map(([did]) => did)
      .filter((did) => deps.sessionManager.getSession(did) !== undefined);

    // 2. We don't actually hold it live — just release the lease (idempotent) and
    //    stop. Nothing to interrupt / flush / move.
    if (liveDesktopIds.length === 0) {
      try { await deps.leaseClient.release(claudeId); } catch { /* best-effort */ }
      return;
    }
    const desktopId = liveDesktopIds[0];

    // 3. Interrupt the in-flight turn. Single ESC byte — safe to write directly
    //    per PITFALLS "Keyboard Routing" (single-byte writes reach Ink as a fresh
    //    keystroke regardless of timing; no paste-classification applies).
    try { deps.sessionManager.sendInput(desktopId, '\x1b'); } catch { /* best-effort */ }

    // 4-5. Wait for CC to finish flushing the interrupted turn, mirror local->space,
    //      and nudge a personal-space sync. MIRROR-BEFORE-RELEASE is load-bearing:
    //      the requester pulls the moment it sees the release, so the final turn
    //      must already be in the space (flushSessionToSpace does both steps).
    try { await deps.flushSessionToSpace(claudeId); } catch { /* best-effort */ }

    // 6. Release the lease so the requester can acquire. Idempotent + best-effort.
    try { await deps.leaseClient.release(claudeId); } catch { /* best-effort */ }

    // 7. Tell the renderer + remote this conversation moved. BEFORE destroy, while
    //    the session still exists so the "moved to <device>" banner can attach.
    deps.pushMoved(desktopId, from?.device);

    // 8. End the holder's session — fires session-exit -> Task 7 cleanup +
    //    idempotent lease release.
    try { deps.sessionManager.destroySession(desktopId); } catch { /* best-effort */ }
  };
}
