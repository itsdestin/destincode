import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { SessionManager } from '../src/main/session-manager';

function makeMockService(opts: { createImmediately?: boolean } = {}) {
  const ee = new EventEmitter() as any;
  ee.baseUrl = () => 'http://127.0.0.1:53217';
  // Allow tests to control whether createSession resolves before sendInput
  // arrives (race window) or after.
  let resolveCreate: (v: { id: string }) => void = () => {};
  const createPromise = new Promise<{ id: string }>((res) => { resolveCreate = res; });
  ee.createSession = vi.fn((_opts: any) => {
    if (opts.createImmediately !== false) resolveCreate({ id: 'oc-NEW' });
    return createPromise;
  });
  ee.resolveCreate = (id: string) => resolveCreate({ id });
  ee.sendMessage = vi.fn(async () => {});
  ee.cancelSession = vi.fn(async () => {});
  ee.destroySession = vi.fn(async () => {});
  ee.sdk = () => ({
    event: { subscribe: () => () => {} },
    session: { messages: async () => [] },
  });
  return ee;
}

describe('SessionManager local branch', () => {
  let sm: SessionManager;
  let svc: ReturnType<typeof makeMockService>;

  beforeEach(() => {
    sm = new SessionManager();
    svc = makeMockService();
    sm.setOpenCodeService(svc as any);
  });

  it('createSession({ provider: "local" }) creates an OpenCode session and registers desktopId↔ocId map', async () => {
    const info = sm.createSession({
      name: 'L', cwd: '', skipPermissions: false,
      provider: 'local', model: 'qwen3:8b',
    });
    expect(info.provider).toBe('local');
    expect(info.id).toBeTruthy();
    expect(svc.createSession).toHaveBeenCalled();
    // Drain microtasks so the .then() that maps desktop→oc fires
    await new Promise((r) => setImmediate(r));
    // Send AFTER mapping is established → routes via the OC id, not the desktop id
    sm.sendInput(info.id, 'hello\r');
    expect(svc.sendMessage).toHaveBeenCalledWith('oc-NEW', 'hello');
  });

  it('createSession with resumeSessionId uses the OC id as desktopId AND skips fresh OC creation', () => {
    const info = sm.createSession({
      name: 'L', cwd: '', skipPermissions: false,
      provider: 'local', resumeSessionId: 'oc-resume-7',
    });
    expect(info.id).toBe('oc-resume-7');
    expect(sm.getSession('oc-resume-7')).toBeDefined();
    expect(svc.createSession).not.toHaveBeenCalled();
  });

  it('sendInput before OC session resolves QUEUES the text; drains after creation', async () => {
    svc = makeMockService({ createImmediately: false });
    sm.setOpenCodeService(svc as any);
    const info = sm.createSession({
      name: 'L', cwd: '', skipPermissions: false, provider: 'local',
    });
    // Send while OC session create is still pending
    sm.sendInput(info.id, 'first\r');
    sm.sendInput(info.id, 'second\r');
    expect(svc.sendMessage).not.toHaveBeenCalled();
    // Now resolve the create
    svc.resolveCreate('oc-LATE');
    await new Promise((r) => setImmediate(r));
    // Both queued sends should have flushed
    expect(svc.sendMessage).toHaveBeenCalledWith('oc-LATE', 'first');
    expect(svc.sendMessage).toHaveBeenCalledWith('oc-LATE', 'second');
  });

  it('sendInput emits a synthetic user-message transcript-event before sendMessage (for dedup)', async () => {
    const events: any[] = [];
    sm.on('transcript-event', (e) => events.push(e));
    const info = sm.createSession({ name: 'L', cwd: '', skipPermissions: false, provider: 'local' });
    await new Promise((r) => setImmediate(r));
    sm.sendInput(info.id, 'hi there\r');
    const userMsg = events.find((e) => e.type === 'user-message');
    expect(userMsg).toBeDefined();
    expect(userMsg.sessionId).toBe(info.id);   // tagged with desktopId
    expect(userMsg.data.text).toBe('hi there'); // exact text we sent (no whitespace normalization risk)
  });

  it('sendInput on a local session routes single ESC byte to cancelSession with OC id', async () => {
    const info = sm.createSession({ name: 'L', cwd: '', skipPermissions: false, provider: 'local' });
    await new Promise((r) => setImmediate(r));
    sm.sendInput(info.id, '\x1b');
    expect(svc.cancelSession).toHaveBeenCalledWith('oc-NEW');
    expect(svc.sendMessage).not.toHaveBeenCalled();
  });

  it('destroySession on a local session calls OpenCodeService.destroySession with OC id and emits exit', async () => {
    const exitSpy = vi.fn();
    sm.on('session-exit', exitSpy);
    const info = sm.createSession({ name: 'L', cwd: '', skipPermissions: false, provider: 'local' });
    await new Promise((r) => setImmediate(r));
    expect(sm.destroySession(info.id)).toBe(true);
    expect(svc.destroySession).toHaveBeenCalledWith('oc-NEW');
    expect(exitSpy).toHaveBeenCalledWith(info.id, 0);
  });

  it('OpenCode crash destroys all local adapters and emits non-zero session-exit per session (drives session-died banner)', async () => {
    const exitSpy = vi.fn();
    sm.on('session-exit', exitSpy);
    const a = sm.createSession({ name: 'A', cwd: '', skipPermissions: false, provider: 'local' });
    const b = sm.createSession({ name: 'B', cwd: '', skipPermissions: false, provider: 'local' });
    await new Promise((r) => setImmediate(r));
    // Simulate OpenCode daemon crash
    svc.emit('crashed', { exitCode: 137 });
    expect(exitSpy).toHaveBeenCalledWith(a.id, 137);
    expect(exitSpy).toHaveBeenCalledWith(b.id, 137);
    expect(sm.getSession(a.id)).toBeUndefined();
    expect(sm.getSession(b.id)).toBeUndefined();
  });
});
