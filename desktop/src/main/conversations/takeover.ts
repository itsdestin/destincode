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
    // Outer backstop (belt-and-suspenders): every step below is ALSO individually
    // try/caught, but this guarantees the never-throw contract even if step 1's
    // sessionIdMap/getSession lookup itself throws — the handler is invoked
    // fire-and-forget (`void holderTakeover(...)`), so any escape would become an
    // unhandled rejection in Electron main.
    try {
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
      // 3. Interrupt EVERY live holder, not just the first. A create+resume pair can
      //    leave two desktop ids mapped to one claude id; the old pick-first behavior
      //    interrupted only one and left the OTHER running as a silent second writer
      //    on the same transcript (never interrupted, flushed, or told it moved). The
      //    single ESC byte is safe to write directly per PITFALLS "Keyboard Routing"
      //    (single-byte writes reach Ink as a fresh keystroke regardless of timing).
      for (const desktopId of liveDesktopIds) {
        try { deps.sessionManager.sendInput(desktopId, '\x1b'); } catch { /* best-effort */ }
      }

      // 4-5. Wait for CC to finish flushing the interrupted turn(s), mirror
      //      local->space, and AWAIT the personal-space push. Keyed on the claude id,
      //      so one flush covers every live holder. MIRROR-BEFORE-RELEASE is
      //      load-bearing: the requester pulls the moment it sees the release, so the
      //      final turn must already be in the space.
      try { await deps.flushSessionToSpace(claudeId); } catch { /* best-effort */ }

      // 6. Release the lease so the requester can acquire. Idempotent + best-effort.
      try { await deps.leaseClient.release(claudeId); } catch { /* best-effort */ }

      // 7-8. Tell the renderer + remote each moved session, then destroy it. pushMoved
      //    runs BEFORE destroy, while the session still exists so the "moved to
      //    <device>" banner can attach. Guarded: pushMoved fans out to
      //    remoteServer.broadcast -> ws.send in a loop, which can THROW synchronously
      //    if a remote socket is mid-teardown. Each id is independently try/caught so
      //    one bad push can't leave a sibling session alive (half-done handoff).
      for (const desktopId of liveDesktopIds) {
        try { deps.pushMoved(desktopId, from?.device); } catch { /* best-effort */ }
        try { deps.sessionManager.destroySession(desktopId); } catch { /* best-effort */ }
      }
    } catch { /* never surface out of a fire-and-forget hub-event handler */ }
  };
}

// Requester-side takeover flow (Plan 2b Task 9). When the user clicks "resume" on
// a conversation another device holds, THIS device asks the holder to hand off,
// waits for the lease to free, then pulls the peer's final turn and acquires the
// lease itself. Extracted as an injected-deps factory (same shape as the holder
// flow) so the poll loop is unit-testable with fake timers.
//
// spec §3 NEVER-BLOCK: this must NEVER throw. On any error the caller degrades to
// a warning dialog and proceeds with the resume anyway — a lease hiccup must not
// stop a user from opening their conversation.
export interface RequesterTakeoverDeps {
  leaseClient: {
    takeover(sessionId: string): Promise<unknown>;
    // `self` (deviceId-derived, from the lease client) is the correct "held by
    // US" signal — NOT `device`, which is the hostname label and collides when
    // two installs share a hostname (dev instance + built app is this plan's own
    // dogfood gate). Keying self-identity on the label would make one install
    // treat the OTHER's lease as its own and skip the real handoff.
    query(sessionId: string): Promise<{ held: boolean; device?: string; self?: boolean }>;
    acquire(sessionId: string): Promise<unknown>;
  };
  syncNow: () => Promise<unknown> | unknown;            // syncSpacesSyncNow('personal')
  materializeOne: (sessionId: string) => Promise<void>; // pull the peer's final turn into the local CC transcript
  forceAcquire: (sessionId: string) => Promise<unknown>;// hub op 'force-acquire' — overwrite a stale lease
  delay: (ms: number) => Promise<void>;                 // injectable so tests drive the poll with fake timers
}

export interface RequesterOutcome { outcome: 'acquired' | 'timeout' | 'error' }

// The requester object's type — referenced by ipc-handlers' leaseWiring param so
// main.ts can build the flow and pass it through without a circular import.
export type RequesterTakeoverType = ReturnType<typeof createRequesterTakeover>;

export function createRequesterTakeover(deps: RequesterTakeoverDeps) {
  const POLL_MS = 1_000;
  // Poll budget for a clean handoff. COUPLED to the holder's costs (see
  // HANDOFF_SYNC_TIMEOUT_MS in conversations/service.ts): a healthy handoff now
  // takes up to QUIESCE_MAX_MS (6s, waiting for the interrupted turn to flush)
  // + a genuinely-awaited git push (≤15s). 10s was sized for the fire-and-forget
  // sync that never actually waited — once the flush awaits its push, 10s trips
  // the force dialog on a HEALTHY holder. 25s = 6s quiesce + 15s push + slack, so
  // the force offer is reserved for a genuinely unresponsive holder.
  const MAX_MS = 25_000;
  return {
    async takeover(sessionId: string): Promise<RequesterOutcome> {
      try {
        // Broadcast the request; the holder answers by releasing its lease.
        await deps.leaseClient.takeover(sessionId);
        const started = Date.now();
        // Poll until the lease frees (held:false, or the holder is now us) or we
        // hit the 10s budget. Checking free BEFORE the first sleep means an
        // already-free lease returns fast without a wasted poll interval.
        while (Date.now() - started < MAX_MS) {
          const q = await deps.leaseClient.query(sessionId);
          // Free (nobody holds it) OR the holder is US (self, keyed on deviceId —
          // see RequesterTakeoverDeps.query for why not the label). Two installs
          // sharing a hostname now serialize correctly: each recognizes only its
          // OWN deviceId as self, so the requester waits for a genuine release.
          if (!q.held || q.self) {
            // Free: nudge a personal-space sync so the holder's final turn is in
            // the space, pull it into the local CC transcript, then claim the
            // lease. Each downstream step is best-effort — a miss self-heals via
            // the startup sweep / next renew; we still report 'acquired'.
            await Promise.resolve(deps.syncNow()).catch(() => {});
            try { await deps.materializeOne(sessionId); } catch { /* best-effort; startup sweep catches up */ }
            await deps.leaseClient.acquire(sessionId).catch(() => {});
            return { outcome: 'acquired' };
          }
          await deps.delay(POLL_MS);
        }
        // Holder never released within the budget — the caller offers a force.
        return { outcome: 'timeout' };
      } catch { return { outcome: 'error' }; }
    },
    async force(sessionId: string): Promise<{ ok: boolean }> {
      try {
        // Overwrite the stale lease outright (the holder is presumed unresponsive),
        // then pull the latest we have. force-acquire goes through the hub directly
        // (the reviewed lease-client has no force method — see main.ts wiring).
        await deps.forceAcquire(sessionId);
        await Promise.resolve(deps.syncNow()).catch(() => {});
        try { await deps.materializeOne(sessionId); } catch { /* best-effort */ }
        return { ok: true };
      } catch { return { ok: false }; }
    },
  };
}
