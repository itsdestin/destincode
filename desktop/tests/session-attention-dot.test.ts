// The dot's colour rule in one pure function, so it can be pinned without
// mounting the hook. Destin's rule (2026-08-16): AMBER means "this is taking a
// while and something may be wrong, but I don't know"; RED means "something
// definitely needs your attention".
import { describe, it, expect } from 'vitest';
import { attentionDotColor } from '../src/renderer/hooks/useSessionAttention';

describe('attention dot colour', () => {
  it('a parked turn is RED — the user has to choose', () => {
    expect(attentionDotColor('stalled')).toBe('red');
  });
  it('"stuck" stays AMBER — it is the "I do not know" state', () => {
    expect(attentionDotColor('stuck')).toBe('amber');
  });
  it('a dead session is RED — the turn is over and the user must act', () => {
    expect(attentionDotColor('session-died')).toBe('red');
  });
  it('a provider error is RED for the same reason', () => {
    expect(attentionDotColor('error')).toBe('red');
  });
  it('"ok" contributes no colour', () => {
    expect(attentionDotColor('ok')).toBeNull();
  });
});
