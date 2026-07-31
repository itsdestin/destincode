// MCP connection manager (spec: native MCP phase 1, Task 4). Sits between the
// registry (Task 2, WHICH servers exist) and the single-server client (Task 3,
// HOW to talk to one) — its whole job is POOLING: one live connection per
// server, shared and refcounted across every session that wants it. Two chat
// sessions both using the Gmail server must share one subprocess, not spawn
// two. Task 5 turns the tools acquire() hands back into app tools; Task 6
// attaches them to a session.
import type { ResolvedMcpServer } from './types';
import type { McpToolDef } from './mcp-client';
import { log } from '../../logger';

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
  // sessionId -> {seq, owner} as of the most recent ensureConnected() call
  // for that session (first-ever hold OR a renewal of one already held).
  // `seq` is the McpManager-wide touch sequence number; `owner` is the
  // SPECIFIC acquire() call's token (see McpManager.activeAcquireTokens)
  // that produced this stamp. release() snapshots this per session before it
  // does anything and compares again once it's safe to act — a changed `seq`
  // means some OTHER acquire() renewed this exact hold WHILE release() was
  // running, which release() must not then undo (see release()'s fix
  // comment for why a plain Set can't tell this apart on its own — adding an
  // already-present sessionId is a same-membership no-op). `owner` covers a
  // narrower, later window `seq` alone cannot (Minor 7, fix pass 2026-07-31):
  // see release()'s "pass 2" fix comment.
  holderTouch: Map<string, { seq: number; owner: symbol }>;
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
  // sessionId -> tokens of every acquire() call for that session that is
  // STILL RUNNING — added at the very top of acquire() (same moment as
  // `inflightAcquires`) but, unlike `inflightAcquires` (cleared right after
  // pass 1's registration), only removed in the OUTER `finally`, i.e. after
  // pass 2 (the connect() waits) has also finished. Fix (Minor 7, 2026-07-31):
  // `inflightAcquires` alone only protects release() from a registration
  // that hasn't happened YET — it says nothing about an acquire() that
  // finished registering (and so is invisible to `inflightAcquires`) but is
  // still awaiting `entry.connecting` in pass 2. Without this, a release()
  // landing in exactly that window sees no in-flight registration to wait
  // for, snapshots a touch that already reflects this acquire()'s OWN stamp
  // (so the plain seq-comparison below sees no "change" either), and closes
  // the connection that acquire is about to hand back — the real close()
  // resets state, so that acquire's pass-2 ready-check then fails and the
  // server is silently dropped. See release()'s fix comment for the other
  // half of this fix.
  //
  // Value is the token's own "fully settled" promise (resolved in acquire()'s
  // outer `finally`, right where the token is removed) rather than a bare
  // Set — release() needs BOTH "is this token still active" (membership) AND
  // a promise to attach to so a release() that defers can re-run itself once
  // the owning acquire() finishes, instead of leaving the hold stranded
  // forever with nothing left to ever call release() on it again. See
  // release()'s fix comment.
  private activeAcquireTokens = new Map<string, Map<symbol, Promise<void>>>();

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
    // Fix (Minor 7) — this token identifies THIS acquire() call, from now
    // until the outer `finally` below, spanning BOTH passes (unlike
    // `registered`/`inflightAcquires`, which only cover pass 1). `settled`
    // resolves at that same finally, so a release() that defers to this
    // token can chain onto it to re-run itself once this call is done. See
    // activeAcquireTokens' own comment and release()'s fix comment.
    const token = Symbol('acquire');
    let settleToken!: () => void;
    const settled = new Promise<void>((resolve) => { settleToken = resolve; });
    const activeForSession = this.activeAcquireTokens.get(sessionId);
    if (activeForSession) activeForSession.set(token, settled);
    else this.activeAcquireTokens.set(sessionId, new Map([[token, settled]]));
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
      const entries = servers.map((server) => this.ensureConnected(server, sessionId, token));
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
        } else {
          // Fix (Finding 5): status()/lastError have always been correct —
          // nothing has ever LOGGED them. A developer with a typo'd command
          // got no tool, no error dialog, and (until now) no log line either:
          // the exact silent failure this whole design exists to prevent, and
          // the reason the dogfood checklist's "confirm the server drops and
          // is reported" step could never actually pass. One line per
          // excluded server, naming it and its real (never reworded) error.
          log('WARN', 'McpManager', 'MCP server excluded from this session — not ready', {
            sessionId, serverId: entry.server.id, state: entry.conn.state, error: entry.conn.lastError,
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
      // Fix (Minor 7): this acquire() call is now FULLY done (pass 1 AND
      // pass 2) — settle its token's promise (waking any release() that
      // deferred to it) and remove it, so a release() checking
      // activeAcquireTokens from here on treats any hold this call stamped
      // as safe to close.
      settleToken();
      const active = this.activeAcquireTokens.get(sessionId);
      if (active) {
        active.delete(token);
        if (active.size === 0) this.activeAcquireTokens.delete(sessionId);
      }
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
  private ensureConnected(server: ResolvedMcpServer, sessionId: string, token: symbol): PooledEntry {
    let entry = this.pool.get(server.id);
    if (!entry) {
      // Fix (Finding 6): a server synced from another device without its
      // secret ciphertext (`missingSecrets`, populated by
      // McpRegistry.resolveEntry) must NEVER reach connect() — doing so hands
      // a stdio server a spawned process missing a required env var (or an
      // http server a request missing a required header), and whatever
      // opaque auth error the server itself emits reaches the user instead of
      // a message naming the actual missing secret. mcp-reconciler.ts's
      // projectToClaudeJson already skips these for Claude Code's OWN
      // config (`missingSecrets.length > 0` → not projected); this pool must
      // hold the SAME line for native sessions. Build a synthetic
      // 'needs-setup' connection instead of ever touching connectionFactory —
      // McpConnection already HAS a 'needs-setup' state (used for the OAuth
      // case in mcp-client.ts); this reuses that same state value rather than
      // inventing a parallel one, so acquire()'s ready-check and status()
      // both treat it exactly like any other not-ready server.
      const conn: McpConnectionLike = server.missingSecrets.length > 0
        ? {
            state: 'needs-setup',
            lastError: `${server.label} needs setup — missing secret(s): ${server.missingSecrets.join(', ')}.`,
            // Never actually invoked (no retry while pooled — see this
            // method's own "WHY no retry" note above) but kept as a real
            // no-op so this object satisfies McpConnectionLike structurally.
            connect: async () => {},
            listTools: () => [],
            callTool: async () => ({
              text: `${server.label} needs setup — missing secret(s): ${server.missingSecrets.join(', ')}.`,
              isError: true,
            }),
            close: async () => {},
          }
        : this.connectionFactory(server);
      entry = { server, conn, holders: new Set(), holderTouch: new Map() };
      this.pool.set(server.id, entry);
      if (server.missingSecrets.length === 0) {
        entry.connecting = conn.connect().finally(() => {
          entry!.connecting = undefined;
        });
      }
    }
    entry.holders.add(sessionId);
    // Stamp this touch regardless of whether sessionId was already a holder
    // — a renewal needs to be observable even though Set#add is a no-op on
    // an already-present member. See PooledEntry.holderTouch / release().
    entry.holderTouch.set(sessionId, { seq: ++this.touchSeq, owner: token });
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
   *
   * Fix (Minor 7, pass 2): the `seq` comparison above only catches a renewal
   * that happens WHILE this call is waiting. It cannot catch one that already
   * happened BEFORE this call started snapshotting — which is exactly what
   * happens when an acquire()'s pass 1 (registration) has already run, but
   * its pass 2 (`await entry.connecting`) has NOT: `inflightAcquires` is
   * already empty (cleared right after pass 1, see acquire()'s `clearSelf`),
   * so this release() doesn't wait at all, and `touchAtStart` captures that
   * acquire's OWN fresh stamp as if it had always been there — no "change" is
   * ever observed. `activeAcquireTokens` (see its own comment) is what closes
   * this: it stays populated for the WHOLE acquire() call, through pass 2,
   * not just pass 1. If the touch currently on an entry was stamped by a
   * token still in that set, some acquire() call is still actively using
   * this entry (whether or not IT renewed anything during THIS release()'s
   * wait) — back off exactly as the seq-renewal case does.
   *
   * "Back off" here means defer, not abandon: this release() chains onto
   * that token's OWN settle promise and re-invokes itself once the owning
   * acquire() call is fully done (pass 1 AND pass 2). Unlike the plain
   * seq-renewal case — where some OTHER acquire() is holding this session's
   * spot and will eventually get its own release() call from whoever owns
   * THAT session — deferring to your OWN still-running acquire() has nobody
   * else who is ever going to call release() again for it. Re-invoking
   * guarantees this entry is still cleaned up (no permanent leak).
   *
   * BE PRECISE ABOUT WHAT THIS DOES NOT DO. It postpones the close; it does
   * not prevent it. The deferred re-release runs one microtask after the
   * owning acquire() returns, so in the motivating case — a RESUMED session
   * reusing its id, where destroy() releases the outgoing generation while
   * create()/resume() acquires for the incoming one — the incoming session is
   * handed a connection that is then closed underneath it, and its tool calls
   * return "<server> is not connected." for the rest of that session. That is
   * a different failure from the one this replaced (silently absent), not a
   * fixed one. It is still the right trade: the alternative, skipping the
   * close forever, leaks a spawned subprocess, which three regression tests
   * in mcp-manager.test.ts pin.
   *
   * The real fix is out of reach here: this manager keys holders by
   * sessionId, which cannot distinguish two generations of the same resumed
   * session. release() would have to take the handle acquire() returned.
   * Tracked as a ROADMAP follow-up.
   */
  async release(sessionId: string): Promise<void> {
    // Snapshot, per entry this session currently holds, the touch record as
    // of RIGHT NOW — before any waiting. See the fix comment above.
    const touchAtStart = new Map<string, { seq: number; owner: symbol }>();
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
      const current = entry.holderTouch.get(sessionId)!;
      // Renewed since this call started — leave it, see the fix comment.
      if (touchAtStart.has(id) && current.seq !== touchAtStart.get(id)!.seq) continue;
      // Fix (Minor 7, pass 2): the owning acquire() call is still running
      // (through pass 2) — defer to it rather than close now, see the fix
      // comment above. Fire-and-forget: this release() call must not itself
      // block on another acquire's connect() to finish. `owningSettled`
      // never rejects (acquire()'s settleToken() is the only thing that
      // ever resolves it, from a `finally` — see acquire()'s comment on
      // `registered` for why the same shape never rejects there either), so
      // this can never produce an unhandled rejection.
      const owningSettled = this.activeAcquireTokens.get(sessionId)?.get(current.owner);
      if (owningSettled) {
        void owningSettled.then(() => { void this.release(sessionId); });
        continue;
      }
      entry.holders.delete(sessionId);
      // Fix (Minor 8): drop this session's touch record along with its
      // holder entry. Without this, a pooled entry that outlives many
      // sessions (a long-lived server everyone shares) accumulates one
      // {seq, owner} pair per session that ever held it, forever — the
      // Set/Map equivalent of a listener that's never unsubscribed.
      entry.holderTouch.delete(sessionId);
      if (entry.holders.size === 0) {
        this.pool.delete(id);
        // Fix (Minor 9): unguarded — a close() that rejects (the real
        // McpConnection's never does, but the injected McpConnectionLike
        // type permits it) would otherwise throw out of this loop and strand
        // every remaining holder this call has not yet processed. This
        // connection is already being discarded either way, so a close()
        // failure here isn't actionable for the caller — log the real error
        // rather than swallow it silently (error-message-standards.md: never
        // guess a cause, but a caught teardown failure is legitimately
        // non-actionable, matching McpConnection.close()'s own best-effort
        // teardown policy).
        try {
          await entry.conn.close();
        } catch (err) {
          log('ERROR', 'McpManager', 'closing a released MCP connection failed', {
            serverId: id, error: String(err),
          });
        }
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
