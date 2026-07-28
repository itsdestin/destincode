// WHERE a dispatcher result goes. Two call sites consumed this decision
// independently (InputBar and App.runSlashResult) and each checked `handled`
// BEFORE `nativeAction` — which was fine while every native action was also a
// recognized command, and became a bug the moment /skill-name started riding the
// handled:false branch. One pure function now owns the ordering.
import { describe, it, expect } from 'vitest';
import { routeSlashResult } from '../src/renderer/state/native-slash-actions';

describe('routeSlashResult', () => {
  it('a native session runs a native action from a HANDLED result', () => {
    const r = routeSlashResult('native', { handled: true, alsoSendToPty: '/clear\r', nativeAction: { kind: 'clear' } });
    expect(r).toEqual({ via: 'native', action: { kind: 'clear' } });
  });

  it('a native session runs a native action from an UNHANDLED result too', () => {
    // The /skill-name case. Checking `handled` first would drop it silently.
    const r = routeSlashResult('native', { handled: false, nativeAction: { kind: 'invoke-skill', skill: 'journal' } });
    expect(r).toEqual({ via: 'native', action: { kind: 'invoke-skill', skill: 'journal' } });
  });

  it('a Claude Code session ignores the native action and uses the PTY', () => {
    const r = routeSlashResult('claude-code', { handled: true, alsoSendToPty: '/clear\r', nativeAction: { kind: 'clear' } });
    expect(r).toEqual({ via: 'pty', text: '/clear\r' });
  });

  it('an unrecognized command in a Claude Code session passes through unchanged', () => {
    // Nothing about CC behavior may change: /whatever still goes out as before.
    const r = routeSlashResult('claude-code', { handled: false, nativeAction: { kind: 'invoke-skill', skill: 'whatever' } });
    expect(r).toEqual({ via: 'passthrough' });
  });

  it('a fully handled command with no PTY text and no native action is done', () => {
    expect(routeSlashResult('claude-code', { handled: true })).toEqual({ via: 'none' });
    expect(routeSlashResult('native', { handled: true })).toEqual({ via: 'none' });
  });

  it('a native session with a handled result and NO native action is done, not sent to a PTY it lacks', () => {
    // e.g. /cost renders a card. Forwarding alsoSendToPty here would hit
    // guardedPtySend, which refuses natively — the silent dead end M3 removes.
    const r = routeSlashResult('native', { handled: true, alsoSendToPty: '/cost\r' });
    expect(r).toEqual({ via: 'none-native-no-pty', command: '/cost' });
  });

  it('plain text passes through for both providers', () => {
    for (const p of ['native', 'claude-code'] as const) {
      expect(routeSlashResult(p, { handled: false })).toEqual({ via: 'passthrough' });
    }
  });

  it('an unknown provider is treated as Claude Code, never as native', () => {
    // Conservative: routing to a harness a session may not have would strand it.
    const r = routeSlashResult(undefined, { handled: false, nativeAction: { kind: 'invoke-skill', skill: 'x' } });
    expect(r).toEqual({ via: 'passthrough' });
  });
});
