// MCP connection manager (spec: native MCP phase 1, Task 4). Sits between the
// registry (Task 2, WHICH servers exist) and the single-server client (Task 3,
// HOW to talk to one) — its whole job is POOLING: one live connection per
// server, shared and refcounted across every session that wants it. Two chat
// sessions both using the Gmail server must share one subprocess, not spawn
// two. Task 5 turns the tools acquire() hands back into app tools; Task 6
// attaches them to a session.
import type { ResolvedMcpServer } from './types';
import type { McpToolDef } from './mcp-client';

// Structural subsets of McpRegistry/createConnection's real shapes — same
// seam convention as NativeHomeLike/SecretsLike/ClientFactory elsewhere in
// this folder. Tests inject fakes; the real registry/mcp-client module both
// satisfy these without this file importing their concrete classes.
export interface McpRegistryLike {
  resolveAllEnabled(): Promise<ResolvedMcpServer[]>;
}

// The exact McpConnection surface this file pools: state/lastError for
// status(), connect()/close() for lifecycle, listTools()/callTool() for the
// ReadyServer this file hands back. connect() is documented (mcp-client.ts)
// to NEVER throw — every failure lands in state/lastError instead — which is
// what lets one broken server be recorded without ever rejecting acquire().
export interface McpConnectionLike {
  readonly state: 'idle' | 'ready' | 'error' | 'needs-setup';
  readonly lastError: string | null;
  connect(): Promise<void>;
  listTools(): McpToolDef[];
  callTool(name: string, args: unknown, signal: AbortSignal): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

export type McpConnectionFactory = (server: ResolvedMcpServer) => McpConnectionLike;

export type ReadyServer = {
  id: string;
  label: string;
  tools: McpToolDef[];
  call(tool: string, args: unknown, signal: AbortSignal): Promise<{ text: string; isError: boolean }>;
};

// One pooled server: its connection (may still be idle/connecting/errored)
// plus WHO currently holds it. holders empties → close(); holders refills
// (a later acquire) → the entry is already gone from the map, so a fresh
// connect() happens, same as first touch. This mirrors the refcounting the
// brief specifies rather than a simple boolean, so two overlapping sessions
// never race each other into a double-connect (see connecting below) or a
// premature close.
interface PooledEntry {
  server: ResolvedMcpServer;
  conn: McpConnectionLike;
  holders: Set<string>;
  // In-flight connect() promise, set the FIRST time any session touches this
  // server and cleared once it settles. A second concurrent acquire() for
  // the same not-yet-connected server awaits THIS instead of calling
  // connect() again — the seam that makes "one broken/slow server, two
  // simultaneous acquire()s" connect once, not twice. See McpManager.acquire.
  connecting?: Promise<void>;
  // sessionId -> the McpManager-wide touch sequence number as of the most
  // recent ensureConnected() call for that session (first-ever hold OR a
  // renewal of one already held). release() snapshots this per session
  // before it does anything and compares again once it's safe to act — a
  // changed number means some acquire() renewed this exact hold WHILE
  // release() was running, which release() must not then undo. See
  // release()'s fix comment for why a plain Set can't tell this apart on
  // its own (adding an already-present sessionId is a same-membership no-op).
  holderTouch: Map<string, number>;
}

export class McpManager {
  private readonly registry: McpRegistryLike;
  private readonly connectionFactory: McpConnectionFactory;
  // serverId -> pooled entry. Absence means "never touched yet" — NOT the
  // same as a connected-but-errored server, which stays present (see acquire).
  private pool = new Map<string, PooledEntry>();
  // sessionId -> "registration complete" promises for every acquire() call
  // currently in flight for that session. A promise is added SYNCHRONOUSLY
  // at the top of acquire(), before its first await, and removed once that
  // acquire() has registered every holder it is ever going to register (see
  // acquire()'s pass 1 below). release() awaits these before touching
  // holders — see release() for why. Usually a session has at most one
  // in-flight acquire(), but the list shape (not a single slot) is
  // deliberate: two OVERLAPPING acquire() calls for the SAME sessionId (a
  // caller firing acquire() twice before the first returns) each get their
  // own promise here, and release() must wait for BOTH, not just whichever
  // started last — the last-started one settling first would let release()
  // proceed while the other is still mid-registration, reopening the exact
  // leak this map exists to close. None of these promises ever reject (see
  // acquire()'s finally), so awaiting them can never propagate a failed
  // acquire()'s rejection into release(), and can never hang on one either.
  private inflightAcquires = new Map<string, Array<Promise<void>>>();
  // Monotonic counter stamped into PooledEntry.holderTouch on every
  // ensureConnected() call, across every entry and session — its only job is
  // giving release() a way to detect "did a hold get renewed while I was
  // running," not to order anything globally. See PooledEntry.holderTouch
  // and release()'s fix comment.
  private touchSeq = 0;

  constructor(deps: { registry: McpRegistryLike; connectionFactory: McpConnectionFactory }) {
    this.registry = deps.registry;
    this.connectionFactory = deps.connectionFactory;
  }

  /**
   * Register `sessionId` as a holder of every enabled server, connecting any
   * server this is the FIRST holder for, and return only the ones that came
   * up `ready`. A server that fails to connect (or needs setup) is still
   * pooled — so status() can report its real error and a later acquire()
   * doesn't reconnect it every time — but it is EXCLUDED from the returned
   * list: one broken server must never deny a session its working ones.
   *
   * Fix (two leak windows, both closed by the same mechanism): the original
   * bug shape was "a release() arrives while acquire() is still in flight,
   * finds no holder yet to remove, no-ops — then acquire() registers the
   * holder anyway once it resumes, and nobody calls release() twice for one
   * session, so it leaks forever." A prior pass closed ONE window (holder
   * registration happening after `await entry.connecting` instead of
   * before), but two earlier suspension points had the identical shape:
   *   - Window A: the `await resolveAllEnabled()` below suspends before ANY
   *     server is known, so no holder exists for anything yet.
   *   - Window B: in a multi-server acquire, awaiting one server's
   *     `connecting` used to suspend BETWEEN servers, so a release() landing
   *     there would see holders for servers already reached but not the
   *     ones still to come.
   * Both are closed the same way: `inflightAcquires` (above) records that
   * this session has a registration in progress the instant this method is
   * entered, and release() (below) waits for it. Splitting this method into
   * two passes — pass 1 registers every holder synchronously (zero awaits),
   * pass 2 waits on each connect() — is what makes "registration complete"
   * a checkpoint reachable BEFORE any connect() settles, instead of only at
   * the very end of this method; without that split, release() would be
   * stuck behind a slow (or, in one existing test, never-resolving)
   * connect() it has no reason to wait for.
   */
  async acquire(sessionId: string): Promise<ReadyServer[]> {
    let settleRegistered!: () => void;
    const registered = new Promise<void>((resolve) => { settleRegistered = resolve; });
    const inflightForSession = this.inflightAcquires.get(sessionId);
    if (inflightForSession) inflightForSession.push(registered);
    else this.inflightAcquires.set(sessionId, [registered]);
    // Removes only THIS acquire()'s own promise from the tracking list.
    // Idempotent (safe to call twice — see the `finally` below) and safe
    // when another acquire() for the same session is still in flight (it
    // leaves that one's entry untouched).
    const clearSelf = () => {
      const list = this.inflightAcquires.get(sessionId);
      if (!list) return;
      const idx = list.indexOf(registered);
      if (idx !== -1) list.splice(idx, 1);
      if (list.length === 0) this.inflightAcquires.delete(sessionId);
    };
    try {
      const servers = await this.registry.resolveAllEnabled();
      // Pass 1 — registration, ZERO awaits between servers. ensureConnected()
      // itself is synchronous (see its own comment), so mapping over every
      // server here registers `sessionId` as a holder of ALL of them before
      // control can be yielded again. This is the checkpoint: once
      // `settleRegistered()` below runs, every holder this acquire() will
      // ever add has been added — a release() that was waiting on
      // `registered` can now safely conclude "nothing left to add" and
      // proceed with its own holder-clearing work.
      //
      // WHY every server's connect() fires in this one synchronous sweep
      // (not started one-at-a-time as each prior server's connect settled):
      // ensureConnected() calls connect() as a side effect of first touch,
      // and this loop touches every not-yet-pooled server before yielding —
      // so all of them spawn at once instead of queueing behind each other.
      // That's a deliberate behavior change, not an accident of the
      // registration-ordering fix above: a hung or slow-to-spawn server no
      // longer blocks every server after it from even starting to connect.
      const entries = servers.map((server) => this.ensureConnected(server, sessionId));
      settleRegistered();
      clearSelf();

      // Pass 2 — connect: registration is done and release() is unblocked,
      // so it's now safe to wait on each server's connect() at our leisure.
      const ready: ReadyServer[] = [];
      for (const entry of entries) {
        if (entry.connecting) await entry.connecting;
        if (entry.conn.state === 'ready') {
          ready.push({
            id: entry.server.id,
            label: entry.server.label,
            tools: entry.conn.listTools(),
            call: (tool, args, signal) => entry.conn.callTool(tool, args, signal),
          });
        }
      }
      return ready;
    } finally {
      // Safety net for the path where `resolveAllEnabled()` itself rejects
      // (or anything else throws before pass 1 runs): `settleRegistered()`
      // above never executed on that path, so without this, a release()
      // waiting on `registered` would hang forever behind holders that are
      // now never going to exist. Resolving an already-resolved promise (the
      // success path) is a no-op, so this costs nothing when nothing went
      // wrong. This is also why `registered` never REJECTS even if the
      // acquire() call itself does — release() only ever awaits a promise
      // that resolves, so a failing acquire() can never hang or fail a
      // release() call.
      settleRegistered();
      clearSelf();
    }
  }

  // Looks up (or creates) the pooled entry for `server` and adds `sessionId`
  // to its holder set, all SYNCHRONOUSLY (no `await` anywhere in this
  // method) — connecting it if this is the first-ever touch. Staying
  // synchronous is what lets acquire()'s pass 1 register a holder on every
  // server in one uninterrupted sweep — no server's holder registration can
  // be split from another's by an intervening await, which is what closes
  // Window B (see acquire()'s fix comment). It also remains the
  // concurrency-safety seam for the double-connect race: two acquire() calls
  // racing on the same server both reach this method, both see the SAME
  // entry.connecting promise (the entry + its promise are installed
  // synchronously, before acquire() ever awaits), so only one connect() ever
  // runs no matter how many sessions ask at once.
  //
  // WHY no retry: if `entry` already exists — even in `error` or
  // `needs-setup` state — it is returned as-is; connect() is never retried
  // while the entry stays pooled (i.e. while any holder remains). This is
  // deliberate, not an oversight: retry/backoff was out of scope for this
  // manager. The user-visible effect is that fixing a broken server's config
  // has no effect until every current holder releases (or the app
  // restarts) — see status(), which surfaces the real lastError so this
  // isn't silent.
  private ensureConnected(server: ResolvedMcpServer, sessionId: string): PooledEntry {
    let entry = this.pool.get(server.id);
    if (!entry) {
      const conn = this.connectionFactory(server);
      entry = { server, conn, holders: new Set(), holderTouch: new Map() };
      this.pool.set(server.id, entry);
      entry.connecting = conn.connect().finally(() => {
        entry!.connecting = undefined;
      });
    }
    entry.holders.add(sessionId);
    // Stamp this touch regardless of whether sessionId was already a holder
    // — a renewal needs to be observable even though Set#add is a no-op on
    // an already-present member. See PooledEntry.holderTouch / release().
    entry.holderTouch.set(sessionId, ++this.touchSeq);
    return entry;
  }

  /**
   * Drop `sessionId`'s hold on every server it holds. A server whose holder
   * set empties as a result is closed and removed from the pool (a later
   * acquire() reconnects it fresh). Releasing a session that never acquired
   * anything — or a server it never held — is a no-op, never a throw: the
   * caller (session teardown) shouldn't have to first check whether MCP was
   * ever in play for that session.
   *
   * Fix: first waits for any acquire() currently registering holders for
   * `sessionId` (see `inflightAcquires` and acquire()'s fix comment) before
   * doing any of the above. Without this, a release() landing while an
   * acquire() for the same session is still in flight would see an
   * incomplete (or entirely absent) holder set, no-op, and let the resuming
   * acquire() register a holder that nothing will ever remove again. This
   * cannot deadlock: the promises awaited here settle when an acquire()'s
   * OWN registration pass finishes — never when some other release() call
   * finishes — so there is no cycle for two calls to wait on each other
   * through.
   *
   * This waits in a LOOP, not a single snapshot-and-await: a plain "read the
   * list once, await it, then clear holders" has a gap — an acquire() for
   * the SAME sessionId that starts after the snapshot but before the
   * holder-clearing loop below runs would register its holders (see
   * ensureConnected) after this call has already decided what to clear.
   * Re-reading `inflightAcquires` after every await catches any such
   * late-arriving acquire() before we touch a single holder. This
   * terminates: each acquire()'s registration pass is synchronous/await-free
   * (pass 1, above), so by the time an iteration's `Promise.all` resolves,
   * every acquire() that was in that snapshot has already removed itself
   * from the map (see acquire()'s `clearSelf`) — the only way the next
   * iteration finds more is a genuinely NEW acquire() call starting mid-wait,
   * which is bounded by how many callers actually call acquire(), not by
   * this loop. The awaited promises never reject (see `inflightAcquires`'s
   * comment — a failing acquire() still resolves `registered`), so a failed
   * acquire() can neither hang nor throw this loop.
   *
   * Fix (premature close): waiting for registration to finish is NOT enough
   * on its own. A resumed session reuses its old session id, so an
   * acquire(sessionId) tearing UP a fresh connection and a release(sessionId)
   * tearing DOWN the outgoing one can genuinely overlap (Task 6). If that
   * acquire's registration pass runs to completion (and, since the server
   * was already connected, its ready-check right along with it — that check
   * has no `await` of its own) while this call is suspended above, this
   * call would resume to find `holders` still showing just `{sessionId}` —
   * re-added by the racing acquire, indistinguishable in a `Set` from the
   * SAME stale membership this release() is supposed to be dropping — and
   * would close the very connection that acquire just handed back as
   * `ready`. `holderTouch` (see PooledEntry) is what makes the two
   * distinguishable: it snapshots, per entry, the touch number this
   * session's hold had at the moment this call started, and after waiting,
   * only removes/closes entries whose touch number is UNCHANGED. A changed
   * number means an acquire() renewed this exact hold sometime after this
   * call began — this release() backs off and leaves it in place; whichever
   * acquire renewed it owns the eventual release() for it. An entry this
   * session didn't hold at all when this call started (the ordinary
   * Window A/B shape, where the FIRST-ever hold is being established by the
   * very acquire() this call is waiting on) is never in the snapshot, so it
   * is unaffected by this check and is removed/closed as before.
   */
  async release(sessionId: string): Promise<void> {
    // Snapshot, per entry this session currently holds, the touch number as
    // of RIGHT NOW — before any waiting. See the fix comment above.
    const touchAtStart = new Map<string, number>();
    for (const [id, entry] of this.pool) {
      if (entry.holders.has(sessionId)) touchAtStart.set(id, entry.holderTouch.get(sessionId)!);
    }
    let inflight = this.inflightAcquires.get(sessionId);
    while (inflight && inflight.length) {
      await Promise.all([...inflight]);
      inflight = this.inflightAcquires.get(sessionId);
    }
    for (const [id, entry] of [...this.pool.entries()]) {
      if (!entry.holders.has(sessionId)) continue;
      // Renewed since this call started — leave it, see the fix comment.
      if (touchAtStart.has(id) && entry.holderTouch.get(sessionId) !== touchAtStart.get(id)) continue;
      entry.holders.delete(sessionId);
      if (entry.holders.size === 0) {
        this.pool.delete(id);
        await entry.conn.close();
      }
    }
  }

  /** App-quit teardown: close every pooled connection regardless of
   *  refcount. A leaked MCP subprocess would otherwise outlive the app. */
  async destroyAll(): Promise<void> {
    const entries = [...this.pool.values()];
    this.pool.clear();
    for (const entry of entries) {
      await entry.conn.close();
    }
  }

  /** Every server this manager has ever touched, including ones that failed
   *  to connect — their REAL error (McpConnection.lastError, never reworded)
   *  so a session picker can show why a server is unavailable. */
  status(): Array<{ id: string; state: string; error: string | null }> {
    return [...this.pool.values()].map((entry) => ({
      id: entry.server.id,
      state: entry.conn.state,
      error: entry.conn.lastError,
    }));
  }
}
