import { describe, it, expect } from 'vitest';
import { assignSpecialistName, POOL_SIZE } from '../src/main/harness/specialists/names';

// ---- Task 8: the naming easter egg -----------------------------------------
// Each specialist child gets a fun, alliterative title ("Rowan the Relentless
// Researcher") instead of a bare role label — the descriptor alliterates with
// the role, and the first name is drawn without replacement per parent (the
// caller owns the `taken` set and re-adds each drawn name before the next
// call, mirroring how the host will use this against its per-parent set).

describe('assignSpecialistName', () => {
  it('titles alliterate with the role and draw without replacement', () => {
    const taken = new Set<string>();
    const a = assignSpecialistName('explorer', taken); taken.add(a.name);
    const b = assignSpecialistName('explorer', taken);
    expect(a.title).toMatch(/^\w+ the E\w+ Explorer$/);
    expect(b.name).not.toBe(a.name);
  });

  it('falls back gracefully when a pool is exhausted (numbered, never a crash)', () => {
    const taken = new Set<string>();
    // Drain the whole pool, then one more: expect "Explorer 13"-style fallback.
    for (let i = 0; i < POOL_SIZE; i++) taken.add(assignSpecialistName('explorer', taken).name);
    const overflow = assignSpecialistName('explorer', taken);
    expect(overflow.title).toMatch(/^Explorer \d+$/);
  });

  it('picks role-matching descriptors for researcher, reviewer, and worker too', () => {
    const taken = new Set<string>();
    expect(assignSpecialistName('researcher', taken).title).toMatch(/^\w+ the R\w+ Researcher$/);
    expect(assignSpecialistName('reviewer', taken).title).toMatch(/^\w+ the R\w+ Reviewer$/);
    expect(assignSpecialistName('worker', taken).title).toMatch(/^\w+ the W\w+ Worker$/);
  });
});
