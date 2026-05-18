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
    // The third arg is the model spec — info.model='qwen3:8b' produces a
    // {providerID:'ollama', modelID:'qwen3:8b'} object that OpenCode needs
    // to route the prompt to the right provider/model.
    // Fourth arg is the per-message system prompt (undefined when no prompt
    // was configured at session create — the local-effort-capability path
    // would prepend a thinking-trigger token here for binary-thinking models).
    expect(svc.sendMessage).toHaveBeenCalledWith('oc-NEW', 'hello', { providerID: 'ollama', modelID: 'qwen3:8b' }, undefined);
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
    // Both queued sends should have flushed. info.model is unset in this
    // test, so modelSpec is undefined; no system prompt was configured, so
    // the system arg is also undefined. vitest's toHaveBeenCalledWith is
    // strict about argument count.
    expect(svc.sendMessage).toHaveBeenCalledWith('oc-LATE', 'first', undefined, undefined);
    expect(svc.sendMessage).toHaveBeenCalledWith('oc-LATE', 'second', undefined, undefined);
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

  it('routes a gemma4 @on session via variant passthrough', async () => {
    // Updated 2026-05-11: Gemma 4 (and all thinking models) collapsed to
    // binary on/off variants. opencode.json registers a single @on variant
    // per model that maps to options.reasoningEffort: "medium" upstream
    // (Ollama coalesces all non-none effort tiers to think:true anyway).
    const info = sm.createSession({
      name: 'L', cwd: '', skipPermissions: false,
      provider: 'local', model: 'gemma4:e2b@on',
      systemPrompt: 'You are concise.',
    });
    await new Promise((r) => setImmediate(r));
    sm.sendInput(info.id, 'hi\r');
    expect(svc.sendMessage).toHaveBeenCalledWith(
      'oc-NEW',
      'hi',
      { providerID: 'ollama', modelID: 'gemma4:e2b@on' },
      // No thinking-token injection — system-prompt mechanism retired
      'You are concise.',
    );
  });

  it('routes a gemma4 with no suffix (Off) unchanged', async () => {
    const info = sm.createSession({
      name: 'L', cwd: '', skipPermissions: false,
      provider: 'local', model: 'gemma4:e2b',
      systemPrompt: 'You are concise.',
    });
    await new Promise((r) => setImmediate(r));
    sm.sendInput(info.id, 'hi\r');
    expect(svc.sendMessage).toHaveBeenCalledWith(
      'oc-NEW',
      'hi',
      { providerID: 'ollama', modelID: 'gemma4:e2b' },
      'You are concise.',
    );
  });

  it('routes a qwen3:8b@on session via variant passthrough', async () => {
    // qwen3 family uses 'variant' mechanism — the @on suffix is a real
    // opencode.json entry. Full suffixed id passes through unchanged.
    const info = sm.createSession({
      name: 'L', cwd: '', skipPermissions: false,
      provider: 'local', model: 'qwen3:8b@on',
      systemPrompt: 'You are concise.',
    });
    await new Promise((r) => setImmediate(r));
    sm.sendInput(info.id, 'hi\r');
    expect(svc.sendMessage).toHaveBeenCalledWith(
      'oc-NEW',
      'hi',
      { providerID: 'ollama', modelID: 'qwen3:8b@on' },
      'You are concise.',
    );
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
