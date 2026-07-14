// SyncHub client (spec §6, Plan 1b). Mirrors presence-socket.ts: a node `ws`
// client held by the Electron MAIN process with capped-backoff reconnect, so a
// Worker deploy or network blip never silently ends cross-device signalling for
// the rest of the app session.
//
// Differences from presence-socket.ts (all deliberate):
//   (1) Owned by the sync-spaces SERVICE, not renderer-driven — sync must work
//       with zero windows open, so there is no renderer to re-invoke us.
//   (2) No-token is retried on a timer (presence waits for the renderer to
//       reconnect after sign-in; we have no renderer to wait for, so we poll at
//       the max backoff and connect the moment a token appears — no restart).
//   (3) hello.replay entries are flattened into ordinary signal events — the
//       engine's single-flight syncSpace makes duplicate signals free, so the
//       consumer never has to distinguish replay from live.
import WebSocket from 'ws';

const SYNC_HUB_URL = 'wss://wecoded-marketplace-api.destinj101.workers.dev/sync/hub';
const PING_INTERVAL_MS = 30_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000]; // capped exponential

// Injectable constructor so the state-machine test (tests/sync-hub-socket.test.ts)
// can substitute a fake socket without touching the network. Production always
// uses the real 'ws' default. Structurally typed to the surface we consume
// (on/send/close/readyState) rather than the full ws class.
export interface SyncHubWebSocketLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}
export type WebSocketCtor = new (
  url: string,
  opts: { headers: Record<string, string> },
) => SyncHubWebSocketLike;

// Who currently holds a session lease (returned on lease-result, and carried in
// takeover-request events as `from`). expiresAt is an epoch-ms deadline.
export interface LeaseHolder { deviceId: string; device: string; expiresAt: number }

// The reply to a request() call — mapped from a server `lease-result` frame.
// `holder` is the current lease owner (or null when the op cleared/failed).
export interface LeaseResult { ok: boolean; op: string; sessionId: string; holder: LeaseHolder | null }

// The single event shape the consumer (Task 5 service wiring) sees. Replay and
// live signals collapse to the same 'signal' event — device/at are dropped
// because the engine only needs "some space changed, go sync it". `lease-event`
// carries UNSOLICITED server pushes (another device released/took a lease, or is
// asking us to hand one over) — these are not tied to a request() reqId.
export type SyncHubEvent =
  | { type: 'connected' }
  | { type: 'disconnected' }
  | { type: 'signal'; kind: string; spaceKey: string }
  | { type: 'lease-event'; kind: 'released' | 'taken' | 'takeover-request'; sessionId: string; device?: string; from?: { deviceId: string; device: string } };

export interface SyncHubSocketOpts {
  getToken: () => string | null;
  deviceName: string;
  onEvent: (e: SyncHubEvent) => void;
  WebSocketCtor?: WebSocketCtor; // injectable for tests
}

export interface SyncHubSocket {
  setDesired(want: boolean): void;
  sendSignal(kind: string, spaceKey: string): boolean;
  // Request/response lease op (acquire/release/takeover). Resolves the matching
  // server `lease-result` by reqId; resolves null on timeout, when not connected,
  // or when the socket goes down mid-flight — NEVER blocks the caller.
  request(op: string, sessionId: string, deviceId: string): Promise<LeaseResult | null>;
  isConnected(): boolean;
  destroy(): void;
}

export function createSyncHubSocket(opts: SyncHubSocketOpts): SyncHubSocket {
  const Ctor: WebSocketCtor = opts.WebSocketCtor ?? (WebSocket as unknown as WebSocketCtor);
  // device= identifies this client to the room so the server can fan a signal
  // out to the account's OTHER devices (never echo it back to the sender).
  const url = `${SYNC_HUB_URL}?device=${encodeURIComponent(opts.deviceName)}`;

  let desired = false;
  let ws: SyncHubWebSocketLike | null = null;
  let attempts = 0;
  let pingTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;

  // In-flight lease requests, keyed by the client-generated reqId. A matching
  // server `lease-result` (or the 5s timeout) removes the entry and resolves it.
  let reqCounter = 0;
  const pending = new Map<string, { resolve: (r: LeaseResult | null) => void; timer: NodeJS.Timeout }>();

  // Resolve EVERY in-flight request to null and clear the map. Called from all
  // teardown paths (handleDown / setDesired(false) / destroy) so a request that
  // was awaiting a reply when the socket died never hangs forever across a
  // reconnect — the never-block guarantee. The caller sees null (treat as "no
  // answer"), same as a timeout.
  function failAllPending() {
    for (const [, p] of pending) { clearTimeout(p.timer); p.resolve(null); }
    pending.clear();
  }

  function clearTimers() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }

  function connect() {
    if (!desired || ws) return;
    const token = opts.getToken();
    if (!token) {
      // No token yet (not signed in). Unlike presence — which relies on the
      // renderer to re-invoke on sign-in — the sync service has no renderer to
      // wait for, so poll at the max backoff so a mid-session sign-in connects
      // on the next tick without an app restart. Clear-then-reschedule (not a
      // `!retryTimer` guard): when THIS callback is itself the fired retry, the
      // timer variable still holds the elapsed id, so `!retryTimer` would be
      // false and the poll would stop dead after one attempt. clearTimeout on an
      // already-fired timer is a harmless no-op, and it guarantees exactly one
      // pending no-token retry.
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(connect, BACKOFF_MS[BACKOFF_MS.length - 1]);
      return;
    }
    const sock = new Ctor(url, { headers: { Authorization: `Bearer ${token}` } });
    ws = sock;
    sock.on('open', () => {
      if (ws !== sock) return; // superseded before handshake completed — don't start a ping timer on a dead socket
      attempts = 0;
      opts.onEvent({ type: 'connected' });
      // Liveness ping — the DO answers pong; also keeps intermediaries from idling us out.
      pingTimer = setInterval(() => { try { sock.send(JSON.stringify({ type: 'ping' })); } catch { /* mid-close */ } }, PING_INTERVAL_MS);
    });
    sock.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data));
        if (msg && msg.type === 'hello' && Array.isArray(msg.replay)) {
          // Flatten the replay ring into ordinary signal events — the consumer
          // treats replay and live signals identically (see header note 3).
          for (const entry of msg.replay) {
            // Per-entry guard: a null/malformed entry must not throw out of the
            // loop into the outer catch and silently strand the REST of the
            // replay batch (same per-emit isolation principle as the transcript
            // watcher's readNewLines), nor emit {kind: undefined} downstream.
            if (entry && entry.kind && entry.spaceKey) {
              opts.onEvent({ type: 'signal', kind: entry.kind, spaceKey: entry.spaceKey });
            }
          }
        } else if (msg && msg.type === 'signal' && msg.kind && msg.spaceKey) {
          // Same guard on live frames — never hand the consumer undefined fields.
          opts.onEvent({ type: 'signal', kind: msg.kind, spaceKey: msg.spaceKey });
        } else if (msg && msg.type === 'lease-result' && typeof msg.reqId === 'string' && pending.has(msg.reqId)) {
          // Correlate the reply to its request() promise by reqId. An unknown
          // reqId (stale/duplicate) matches nothing and is dropped harmlessly.
          const p = pending.get(msg.reqId)!; pending.delete(msg.reqId); clearTimeout(p.timer);
          p.resolve({ ok: !!msg.ok, op: msg.op, sessionId: msg.sessionId, holder: msg.holder ?? null });
        } else if (msg && msg.type === 'lease-event' && msg.kind && msg.sessionId) {
          // Unsolicited server push (not tied to a reqId) — forward to the
          // consumer. Per-field guard mirrors the signal branch: no kind/sessionId
          // means we never hand the consumer undefined fields.
          opts.onEvent({ type: 'lease-event', kind: msg.kind, sessionId: msg.sessionId, device: msg.device, from: msg.from });
        }
        // pong (or any other frame): ignore — pings are fire-and-forget liveness.
      } catch { /* non-JSON frame: ignore */ }
    });
    sock.on('close', () => {
      if (ws !== sock) return; // superseded socket — its lifecycle no longer drives state
      handleDown();
    });
    sock.on('error', () => {
      // Don't surface errors as events — the consumer only cares about
      // connected/disconnected/signal. Close to let 'close' schedule the retry.
      try { sock.close(); } catch { /* already closing */ }
    });
  }

  function handleDown() {
    clearTimers();
    failAllPending(); // socket died — a request awaiting a reply must resolve null, not hang across the reconnect
    ws = null;
    opts.onEvent({ type: 'disconnected' });
    if (desired) {
      // Reconnect with capped backoff. A dead-token loop (persistent handshake
      // reject) is bounded upstream by the service dropping `desired` on
      // sign-out; revisit a close-code-based stop once the worker's close-code
      // contract is pinned.
      const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
      attempts += 1;
      retryTimer = setTimeout(connect, delay);
    }
  }

  return {
    setDesired(want) {
      // Idempotent by intent. Short-circuit only when the request matches the
      // current state AND there's nothing to do: either we already want-off, or
      // we want-on WITH a live socket. The case we must NOT short-circuit is
      // want===true while desired-but-disconnected (e.g. the token finally
      // appeared after sign-in, or a retry is pending) — that has to fall
      // through and (re)trigger connect().
      if (want === desired && (!want || ws !== null)) return;
      desired = want;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (want) { connect(); return; }
      failAllPending(); // intentional teardown — resolve any in-flight request to null so the caller never blocks on a socket we're closing
      const s = ws;
      ws = null;
      clearTimers();
      if (s) {
        try { s.close(1000, 'sync disabled or sign-out'); } catch { /* already closed */ }
        // Emit the disconnect synchronously; the socket's own async close event
        // is ignored via the supersede guard (ws was nulled above, so
        // `ws !== sock` in the close handler) — that's what prevents a reconnect
        // after an INTENTIONAL teardown.
        opts.onEvent({ type: 'disconnected' });
      }
    },
    // Send a change signal to the room. Returns true only when actually written
    // on an OPEN socket; a closed/connecting socket is a silent no-op (the 120s
    // poll fallback covers the miss — no queueing, YAGNI).
    sendSignal(kind, spaceKey) {
      if (ws !== null && ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: 'signal', kind, spaceKey })); return true; }
        catch { return false; }
      }
      return false;
    },
    // Request/response lease op. Sends a {type:'lease', op, sessionId, deviceId,
    // reqId} frame and resolves the matching server `lease-result` by reqId.
    // NEVER blocks the caller: resolves null immediately when not connected, on a
    // 5s timeout, if the send throws, or if the socket goes down mid-flight
    // (failAllPending). The consumer treats null as "no answer / fall back".
    request(op, sessionId, deviceId) {
      if (ws === null || ws.readyState !== WebSocket.OPEN) return Promise.resolve(null); // never-block
      const reqId = `r${++reqCounter}`;
      return new Promise<LeaseResult | null>((resolve) => {
        const timer = setTimeout(() => { pending.delete(reqId); resolve(null); }, 5_000);
        timer.unref?.(); // don't keep the Electron main process alive just for a lease timeout
        pending.set(reqId, { resolve, timer });
        try { ws!.send(JSON.stringify({ type: 'lease', op, sessionId, deviceId, reqId })); }
        catch { pending.delete(reqId); clearTimeout(timer); resolve(null); }
      });
    },
    // True only when a socket exists AND finished its handshake.
    isConnected() { return ws !== null && ws.readyState === WebSocket.OPEN; },
    destroy() { desired = false; clearTimers(); failAllPending(); try { ws?.close(); } catch { /* noop */ } ws = null; },
  };
}
