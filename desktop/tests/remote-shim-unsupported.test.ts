// @vitest-environment jsdom
// The remote server answers unbridged channels with {ok:false, unsupported:true}
// instead of dropping them. The shim turns that into a plain-language
// announcement, because the call sites themselves mostly don't check the
// payload (ProjectView's .then() has no .catch(); account-context calls
// reloadFromStore() as `void`) and would otherwise render an empty panel.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  static CONNECTING = 0;
  readyState = FakeWebSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { FakeWebSocket.instances.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  receive(msg: any) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

describe('remote-shim unsupported-channel reporting', () => {
  let shim: typeof import('../src/renderer/remote-shim');
  let events: any[];
  let ws: FakeWebSocket;
  let listener: (e: any) => void;
  let unsupportedEvent: string;

  beforeEach(async () => {
    vi.resetModules();
    FakeWebSocket.instances = [];
    events = [];
    // jsdom supplies window, location, localStorage, CustomEvent and a real
    // event target; only the socket needs replacing.
    (globalThis as any).WebSocket = FakeWebSocket;
    // This jsdom setup exposes no Storage, so stub it the way the sibling
    // remote-shim test does.
    (globalThis as any).localStorage = {
      _s: {} as Record<string, string>,
      getItem(k: string) { return this._s[k] ?? null; },
      setItem(k: string, v: string) { this._s[k] = v; },
      removeItem(k: string) { delete this._s[k]; },
    };
    shim = await import('../src/renderer/remote-shim');
    const { REMOTE_UNSUPPORTED_EVENT } = await import('../src/renderer/remote-unsupported');
    // Keep a handle so afterEach can remove it. jsdom's window persists across
    // tests in a file, and the closure reads the shared `events` binding — a
    // leaked listener from an earlier test pushes into the CURRENT array and
    // inflates the count, which reads exactly like a broken dedupe.
    listener = (e: any) => events.push(e.detail);
    window.addEventListener(REMOTE_UNSUPPORTED_EVENT, listener);
    unsupportedEvent = REMOTE_UNSUPPORTED_EVENT;

    const connectPromise = shim.connect('pw', false);
    ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: 'auth:ok', token: 'tok', platform: 'browser' });
    await connectPromise;
    shim.installShim();
  });
  afterEach(() => {
    window.removeEventListener(unsupportedEvent, listener);
    delete (globalThis as any).WebSocket;
  });

  /** Issue a call and answer it with the server's unsupported response. */
  async function callUnsupported(fn: () => Promise<any>) {
    const p = fn();
    const msg = JSON.parse(ws.sent[ws.sent.length - 1]);
    ws.receive({
      type: `${msg.type}:response`,
      id: msg.id,
      payload: { ok: false, error: `nope (${msg.type})`, unsupported: true },
    });
    return { result: await p, channel: msg.type };
  }

  it('announces an unsupported channel in plain language', async () => {
    await callUnsupported(() => (window as any).claude.social.listFriends());
    expect(events).toHaveLength(1);
    expect(events[0].feature).toBe('Friends and challenges');
    expect(events[0].message).toBe("Friends and challenges isn't available via remote access yet.");
  });

  it('still resolves the call so the caller does not crash', async () => {
    const { result } = await callUnsupported(() => (window as any).claude.social.listFriends());
    expect(result.ok).toBe(false);
    expect(result.unsupported).toBe(true);
  });

  // The load-bearing one: useAttentionClassifier polls a channel every second.
  // Announcing per response would put a toast on screen permanently.
  it('announces a feature only once no matter how often it is called', async () => {
    for (let i = 0; i < 5; i++) {
      await callUnsupported(() => (window as any).claude.social.listFriends());
    }
    expect(events).toHaveLength(1);
  });

  it('still announces a DIFFERENT feature', async () => {
    await callUnsupported(() => (window as any).claude.social.listFriends());
    await callUnsupported(() => (window as any).claude.artifacts.get('p', 'a'));
    expect(events.map(e => e.feature)).toEqual(['Friends and challenges', 'Project files']);
  });

  it('says nothing for a normal successful response', async () => {
    const p = (window as any).claude.skills.list();
    const msg = JSON.parse(ws.sent[ws.sent.length - 1]);
    ws.receive({ type: `${msg.type}:response`, id: msg.id, payload: [] });
    await p;
    expect(events).toHaveLength(0);
  });
});
