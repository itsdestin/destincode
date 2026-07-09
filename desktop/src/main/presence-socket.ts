// Platform-owned presence socket (spec §6): Electron main holds the account
// session token and the WebSocket; the renderer only ever sees relayed events.
import WebSocket from 'ws';

const PRESENCE_URL = 'wss://wecoded-marketplace-api.destinj101.workers.dev/social/presence';
const PING_INTERVAL_MS = 30_000;
const BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000]; // capped exponential

// Injectable constructor so the state-machine test (tests/presence-socket.test.ts)
// can substitute a fake socket without touching the network. Production always
// uses the real 'ws' default. Structurally typed to the surface we consume
// (on/send/close/readyState) rather than the full ws class.
export interface PresenceWebSocketLike {
  on(event: string, listener: (...args: any[]) => void): unknown;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  readyState: number;
}
export type WebSocketCtor = new (
  url: string,
  opts: { headers: Record<string, string> },
) => PresenceWebSocketLike;

export interface PresenceSocket {
  setDesired(want: boolean): void;
  send(message: Record<string, unknown>): void;
  isConnected(): boolean;
  destroy(): void;
}

export function createPresenceSocket(opts: {
  getToken: () => string | null;
  onEvent: (ev: Record<string, unknown>) => void; // relayed as social:presence-event
  WebSocketCtor?: WebSocketCtor;
}): PresenceSocket {
  const Ctor: WebSocketCtor = opts.WebSocketCtor ?? (WebSocket as unknown as WebSocketCtor);
  let desired = false;
  let ws: PresenceWebSocketLike | null = null;
  let attempts = 0;
  let pingTimer: NodeJS.Timeout | null = null;
  let retryTimer: NodeJS.Timeout | null = null;
  // Last full presence snapshot seen on the live socket. Kept so a RELOADED
  // renderer (dev HMR / Ctrl+R resets the reducer while main keeps the socket)
  // can be re-hydrated: setDesired(true) on an already-open socket replays
  // {type:'connected'} + this frame instead of returning silently — without it
  // the fresh renderer never leaves "Connecting…".
  let lastPresence: Record<string, unknown> | null = null;

  function clearTimers() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  }

  function connect() {
    const token = opts.getToken();
    // No token: stay quiet. The renderer (usePresence, Task 7) re-invokes
    // presence-connect when sign-in completes; do NOT turn this bail into an
    // error — no-token is the normal pre-sign-in state.
    if (!desired || ws || !token) return;
    const sock = new Ctor(PRESENCE_URL, { headers: { Authorization: `Bearer ${token}` } });
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
        const ev = JSON.parse(String(data));
        // Cache the latest full presence snapshot for renderer-reload replay
        // (see lastPresence above).
        if (ev && ev.type === 'presence') lastPresence = ev;
        opts.onEvent(ev);
      } catch { /* non-JSON frame: ignore */ }
    });
    sock.on('close', (code, reason) => {
      if (ws !== sock) return; // superseded socket — its lifecycle no longer drives state
      handleDown({ type: 'disconnected', code, reason: String(reason) });
    });
    sock.on('error', (err: Error) => {
      opts.onEvent({ type: 'error', message: err.message });
      try { sock.close(); } catch { /* already closing */ } // 'close' fires next and schedules the retry
    });
  }

  function handleDown(ev: Record<string, unknown>) {
    clearTimers();
    ws = null;
    lastPresence = null; // snapshot belongs to the dead socket — never replay it stale
    opts.onEvent(ev);
    if (desired) {
      // Reconnect with capped backoff — a Worker deploy or network blip must
      // not silently end presence for the rest of the app session.
      // A dead-token loop (persistent handshake reject) is bounded by Task 2's
      // focus/15-min revalidation: dead token → 401 on any account call →
      // signOut → notifySignedOut drops `desired`. Revisit a close-code-based
      // stop here once the worker's close-code contract is pinned.
      const delay = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
      attempts += 1;
      retryTimer = setTimeout(connect, delay);
    }
  }

  return {
    setDesired(want) {
      // Idempotent by intent. Return early only when the request matches the
      // current state AND there's nothing to do: either we already want-off, or
      // we want-on WITH a live socket. The one case we must NOT short-circuit is
      // want===true while desired-but-disconnected (e.g. the token finally
      // appeared after sign-in) — that has to fall through and trigger connect().
      if (want === desired && (!want || ws !== null)) {
        // Renderer-reload replay: dev HMR / Ctrl+R resets the renderer's reducer
        // while main keeps the socket open, so the fresh renderer's connect
        // request lands here with nothing to do — and without a replay it never
        // sees 'connected' and sticks on "Connecting…" forever. Re-emit the
        // synthetic connected + the cached presence snapshot so the reducer
        // re-hydrates. Skip while still CONNECTING — the real open event fires.
        if (want && ws && ws.readyState === WebSocket.OPEN) {
          opts.onEvent({ type: 'connected' });
          if (lastPresence) opts.onEvent(lastPresence);
        }
        return;
      }
      desired = want;
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
      if (want) { connect(); return; }
      const s = ws;
      ws = null;
      lastPresence = null; // intentional teardown — drop the snapshot with the socket
      clearTimers();
      if (s) {
        try { s.close(1000, 'incognito or sign-out'); } catch { /* already closed */ }
        // reason:'local' marks an INTENTIONAL disconnect — Task 7 uses it to
        // suppress "reconnecting" UI. Emitted synchronously; the socket's own
        // async close event is ignored via the supersede guard (ws was nulled
        // above, so `ws !== sock` in the close handler).
        opts.onEvent({ type: 'disconnected', code: 1000, reason: 'local' });
      }
    },
    send(message) { try { ws?.send(JSON.stringify(message)); } catch { /* mid-close */ } },
    // True only when a socket exists AND finished its handshake — lets the
    // presence-send handler return an honest failure instead of silently
    // dropping a frame with a success receipt.
    isConnected() { return ws !== null && ws.readyState === WebSocket.OPEN; },
    destroy() { desired = false; clearTimers(); try { ws?.close(); } catch { /* noop */ } ws = null; },
  };
}
