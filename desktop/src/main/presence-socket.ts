// Platform-owned presence socket (spec §6): Electron main holds the account
// session token and the WebSocket; the renderer only ever sees relayed events.
// The reconnect/backoff/ping/supersede-guard mechanics live in the shared
// reconnecting-ws engine (mirrored with sync-hub-socket.ts); this module only
// supplies the presence-specific URL, message caching, and the renderer-reload
// re-hydration hook. No-token policy is 'wait' — the renderer (usePresence,
// Task 7) re-invokes presence-connect when sign-in completes.
import {
  createReconnectingWs,
  type ReconnectingWebSocketLike,
  type ReconnectingWebSocketCtor,
} from './reconnecting-ws';

const PRESENCE_URL = 'wss://wecoded-marketplace-api.destinj101.workers.dev/social/presence';

// Structural socket surface + injectable constructor. Kept as named exports so
// the state-machine test (tests/presence-socket.test.ts) can substitute a fake
// socket. Both alias the shared engine's types (identical shape).
export type PresenceWebSocketLike = ReconnectingWebSocketLike;
export type WebSocketCtor = ReconnectingWebSocketCtor;

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
  // Last full presence snapshot seen on the live socket. Kept so a RELOADED
  // renderer (dev HMR / Ctrl+R resets the reducer while main keeps the socket)
  // can be re-hydrated: setDesired(true) on an already-open socket replays
  // {type:'connected'} + this frame instead of returning silently — without it
  // the fresh renderer never leaves "Connecting…".
  let lastPresence: Record<string, unknown> | null = null;

  const engine = createReconnectingWs({
    Ctor: opts.WebSocketCtor,
    getUrl: () => PRESENCE_URL,
    getToken: opts.getToken,
    noToken: 'wait',
    closeReason: 'incognito or sign-out',
    onMessage: (data) => {
      try {
        const ev = JSON.parse(String(data));
        // Cache the latest full presence snapshot for renderer-reload replay
        // (see lastPresence above).
        if (ev && ev.type === 'presence') lastPresence = ev;
        opts.onEvent(ev);
      } catch { /* non-JSON frame: ignore */ }
    },
    onConnected: () => opts.onEvent({ type: 'connected' }),
    onDisconnected: (info) => {
      // reason:'local' marks an INTENTIONAL disconnect — Task 7 uses it to
      // suppress "reconnecting" UI. A dropped/failed socket forwards the ws
      // close code/reason instead.
      if (info.intentional) opts.onEvent({ type: 'disconnected', code: 1000, reason: 'local' });
      else opts.onEvent({ type: 'disconnected', code: info.code, reason: info.reason });
    },
    // The 'error' handler surfaces an error event; the engine then closes the
    // socket so its 'close' schedules the retry.
    onError: (err) => opts.onEvent({ type: 'error', message: err.message }),
    onReplay: () => {
      opts.onEvent({ type: 'connected' });
      if (lastPresence) opts.onEvent(lastPresence);
    },
    // The cached snapshot belongs to the socket that just went down — never
    // replay it stale onto the next connection.
    onTeardown: () => { lastPresence = null; },
  });

  return {
    setDesired(want) { engine.setDesired(want); },
    send(message) { engine.send(JSON.stringify(message)); },
    // True only when a socket exists AND finished its handshake — lets the
    // presence-send handler return an honest failure instead of silently
    // dropping a frame with a success receipt.
    isConnected() { return engine.isOpen(); },
    destroy() { engine.destroy(); },
  };
}
