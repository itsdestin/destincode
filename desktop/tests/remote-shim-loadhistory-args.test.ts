import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// Regression test for the loadHistory argument-order parity bug (PR #300 review):
// the shim declared (sessionId, count, all, projectSlug) while preload.ts and
// every renderer caller (App.tsx, ChatView.tsx, useIpc.ts) use
// (sessionId, projectSlug, count, all). On remote browsers and Android the
// project slug string landed in `count` and 10 landed in `all` (truthy), so
// session-browser's `if (all) return messages` shipped the ENTIRE transcript
// over the WebSocket on every initial history load. This test drives the shim
// with the canonical caller order and asserts each field lands in the right
// payload slot on the wire.

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
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error('WebSocket is not OPEN');
    }
    this.sent.push(data);
  }
  close() { this.readyState = 3; this.onclose?.({ code: 1000, reason: '' }); }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
  receive(msg: any) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

describe('remote-shim loadHistory argument order', () => {
  let shim: typeof import('../src/renderer/remote-shim');
  let ws: FakeWebSocket;

  beforeEach(async () => {
    const { vi } = await import('vitest');
    vi.resetModules();
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;
    (globalThis as any).window = globalThis;
    (globalThis as any).location = { protocol: 'ws:', host: 'localhost', search: '' };
    (globalThis as any).localStorage = {
      _s: {} as Record<string, string>,
      getItem(k: string) { return this._s[k] ?? null; },
      setItem(k: string, v: string) { this._s[k] = v; },
      removeItem(k: string) { delete this._s[k]; },
    };
    shim = await import('../src/renderer/remote-shim');
    const connectPromise = shim.connect('pw', false);
    ws = FakeWebSocket.instances[0];
    ws.open();
    ws.receive({ type: 'auth:ok', token: 'tok', platform: 'browser' });
    await connectPromise;
    shim.installShim();
  });

  afterEach(() => { delete (globalThis as any).WebSocket; });

  it('initial-load call (App.tsx order) places every field in its own payload slot', async () => {
    // Canonical caller order — identical to App.tsx's initial history load and
    // to preload.ts's signature: (sessionId, projectSlug, count, all).
    const p = (window as any).claude.session.loadHistory('abc-123', 'my-project', 10, false);
    const msg = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(msg.type).toBe('session:history');
    expect(msg.payload).toEqual({
      sessionId: 'abc-123',
      projectSlug: 'my-project',
      count: 10,
      all: false,
    });
    ws.receive({ type: 'session:history:response', id: msg.id, payload: [] });
    await expect(p).resolves.toEqual([]);
  });

  it('expand-all call (ChatView order) sends all:true and a numeric count', async () => {
    // ChatView's "See previous messages" passes (id, slug, 0, true). The shim
    // mirrors preload's `count || 10` / `all || false` defaults so the wire
    // always carries real number/boolean types (Android's optInt/optBoolean
    // and the server's slice(-count) both require them).
    const p = (window as any).claude.session.loadHistory('abc-123', 'my-project', 0, true);
    const msg = JSON.parse(ws.sent[ws.sent.length - 1]);
    expect(msg.type).toBe('session:history');
    expect(msg.payload).toEqual({
      sessionId: 'abc-123',
      projectSlug: 'my-project',
      count: 10, // 0 || 10 — parity with preload's default; ignored when all=true
      all: true,
    });
    ws.receive({ type: 'session:history:response', id: msg.id, payload: [] });
    await expect(p).resolves.toEqual([]);
  });
});
