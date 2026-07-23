// Pins the native auto-title feeder (Task 7 — M2 item 5): CC sessions get a
// title from the Auto-Title hook -> ~/.claude/topics -> the inline
// topic-watcher; native sessions have no such feed, so this module generates
// one itself from the bound model. All four effects are injected (`generate`,
// `getBinding`, `hasTitle`, `onTitle`) so every collaborator can be made to
// reject — the #177 lesson (youcoded #177): a fake that can't fail certifies
// the bug it should catch.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createNativeTitleFeeder, type NativeTitleFeederDeps } from '../src/main/native-title-feeder';
import type { TranscriptEvent } from '../src/shared/types';
import type { ModelBinding } from '../src/shared/provider-types';

const BINDING: ModelBinding = { providerId: 'anthropic', modelId: 'claude-opus-4-7' };

function mkEvent(partial: Partial<TranscriptEvent> & { type: TranscriptEvent['type']; sessionId: string }): TranscriptEvent {
  return {
    uuid: `uuid-${Math.random()}`,
    timestamp: Date.now(),
    data: {},
    ...partial,
  } as TranscriptEvent;
}

function mkDeps(overrides: Partial<NativeTitleFeederDeps> = {}): NativeTitleFeederDeps {
  return {
    generate: vi.fn(async () => 'Fixing The Login Bug'),
    getBinding: vi.fn(() => BINDING),
    hasTitle: vi.fn(async () => false),
    onTitle: vi.fn(async () => {}),
    ...overrides,
  };
}

// Let any fire-and-forget promise chains inside noteEvent's `void attempt(...)`
// settle before assertions — noteEvent is intentionally synchronous-looking
// but its body awaits deps.
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

describe('createNativeTitleFeeder', () => {
  let deps: NativeTitleFeederDeps;

  beforeEach(() => {
    deps = mkDeps();
  });

  it('generates once at first turn-complete using the first user message', async () => {
    const feeder = createNativeTitleFeeder(deps);
    feeder.noteEvent(mkEvent({ type: 'user-message', sessionId: 's1', data: { text: 'help me fix the login bug' } }));
    feeder.noteEvent(mkEvent({ type: 'assistant-text', sessionId: 's1', data: { text: 'ok' } }));
    feeder.noteEvent(mkEvent({ type: 'turn-complete', sessionId: 's1' }));
    await flush();

    expect(deps.generate).toHaveBeenCalledTimes(1);
    const [binding, prompt] = (deps.generate as any).mock.calls[0];
    expect(binding).toEqual(BINDING);
    expect(prompt).toContain('help me fix the login bug');
    expect(prompt).toContain('Reply with only a short 3-6 word title');
    expect(deps.onTitle).toHaveBeenCalledWith('s1', 'Fixing The Login Bug');

    // A second turn-complete must NOT fire again — `done` sticks.
    feeder.noteEvent(mkEvent({ type: 'turn-complete', sessionId: 's1' }));
    await flush();
    expect(deps.generate).toHaveBeenCalledTimes(1);
  });

  it('never fires for a session that already has a title', async () => {
    deps = mkDeps({ hasTitle: vi.fn(async () => true) });
    const feeder = createNativeTitleFeeder(deps);
    feeder.noteEvent(mkEvent({ type: 'user-message', sessionId: 's1', data: { text: 'hi' } }));
    feeder.noteEvent(mkEvent({ type: 'turn-complete', sessionId: 's1' }));
    await flush();

    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.onTitle).not.toHaveBeenCalled();
  });

  it('a rejecting generate skips silently and retries on the NEXT turn-complete (max 3)', async () => {
    deps = mkDeps({ generate: vi.fn(async () => { throw new Error('provider timeout'); }) });
    const feeder = createNativeTitleFeeder(deps);
    feeder.noteEvent(mkEvent({ type: 'user-message', sessionId: 's1', data: { text: 'hi' } }));

    // Fire turn-complete 4 times — only 3 attempts should be made (the 4th is
    // suppressed by the attempts cap), and no error ever propagates.
    for (let i = 0; i < 4; i++) {
      feeder.noteEvent(mkEvent({ type: 'turn-complete', sessionId: 's1' }));
      await flush();
    }

    expect(deps.generate).toHaveBeenCalledTimes(3);
    expect(deps.onTitle).not.toHaveBeenCalled();
  });

  it('sanitizes: strips quotes/newlines, caps at 60 chars, drops empty results', async () => {
    // Quotes + newlines + collapse whitespace.
    deps = mkDeps({ generate: vi.fn(async () => '"Fixing\n  the   login\nbug"') });
    let feeder = createNativeTitleFeeder(deps);
    feeder.noteEvent(mkEvent({ type: 'user-message', sessionId: 's1', data: { text: 'hi' } }));
    feeder.noteEvent(mkEvent({ type: 'turn-complete', sessionId: 's1' }));
    await flush();
    expect(deps.onTitle).toHaveBeenCalledWith('s1', 'Fixing the login bug');

    // 60-char cap.
    const long = 'x'.repeat(120);
    deps = mkDeps({ generate: vi.fn(async () => long) });
    feeder = createNativeTitleFeeder(deps);
    feeder.noteEvent(mkEvent({ type: 'user-message', sessionId: 's2', data: { text: 'hi' } }));
    feeder.noteEvent(mkEvent({ type: 'turn-complete', sessionId: 's2' }));
    await flush();
    const written = (deps.onTitle as any).mock.calls[0][1] as string;
    expect(written.length).toBe(60);

    // Empty result: dropped, no onTitle call, attempt consumed (retries later).
    deps = mkDeps({ generate: vi.fn(async () => '   ') });
    feeder = createNativeTitleFeeder(deps);
    feeder.noteEvent(mkEvent({ type: 'user-message', sessionId: 's3', data: { text: 'hi' } }));
    feeder.noteEvent(mkEvent({ type: 'turn-complete', sessionId: 's3' }));
    await flush();
    expect(deps.onTitle).not.toHaveBeenCalled();
    expect(deps.generate).toHaveBeenCalledTimes(1);
  });

  it('never titles when the binding is unresolvable (getBinding null) — honest skip, no error event', async () => {
    deps = mkDeps({ getBinding: vi.fn(() => null) });
    const feeder = createNativeTitleFeeder(deps);
    feeder.noteEvent(mkEvent({ type: 'user-message', sessionId: 's1', data: { text: 'hi' } }));
    feeder.noteEvent(mkEvent({ type: 'turn-complete', sessionId: 's1' }));
    await flush();

    expect(deps.generate).not.toHaveBeenCalled();
    expect(deps.onTitle).not.toHaveBeenCalled();
  });

  it('forget() drops per-session state so a re-created session starts clean', async () => {
    const feeder = createNativeTitleFeeder(deps);
    feeder.noteEvent(mkEvent({ type: 'user-message', sessionId: 's1', data: { text: 'hi' } }));
    feeder.noteEvent(mkEvent({ type: 'turn-complete', sessionId: 's1' }));
    await flush();
    expect(deps.generate).toHaveBeenCalledTimes(1);

    feeder.forget('s1');
    // A fresh user-message + turn-complete after forget must fire again —
    // proof the internal state was actually dropped, not just marked done.
    feeder.noteEvent(mkEvent({ type: 'user-message', sessionId: 's1', data: { text: 'new topic' } }));
    feeder.noteEvent(mkEvent({ type: 'turn-complete', sessionId: 's1' }));
    await flush();
    expect(deps.generate).toHaveBeenCalledTimes(2);
  });
});
