// Pins the resume-time title re-apply. The native title feeder only broadcasts
// a rename when it GENERATES a title, and an already-titled session never
// regenerates — so before this module, resuming an already-named native
// session left its header pill stuck on 'Resuming…' forever.
import { describe, it, expect, vi } from 'vitest';
import { reapplyStoredTitle, type ResumeTitleDeps } from '../src/main/native-resume-title';

function mkDeps(overrides: Partial<ResumeTitleDeps> = {}): ResumeTitleDeps {
  return {
    getStoredTitle: vi.fn(async () => 'Fixing The Login Bug'),
    onTitle: vi.fn(),
    ...overrides,
  };
}

describe('reapplyStoredTitle', () => {
  it('re-applies a real stored title', async () => {
    const deps = mkDeps();
    const applied = await reapplyStoredTitle(deps, 's1');

    expect(applied).toBe('Fixing The Login Bug');
    expect(deps.getStoredTitle).toHaveBeenCalledWith('s1');
    expect(deps.onTitle).toHaveBeenCalledTimes(1);
    expect(deps.onTitle).toHaveBeenCalledWith('s1', 'Fixing The Login Bug');
  });

  it.each([undefined, '', '   ', 'Untitled', 'New Session', 'Resuming…'])(
    'never plants the placeholder %j over the live name',
    async (stored) => {
      const deps = mkDeps({ getStoredTitle: vi.fn(async () => stored as any) });
      const applied = await reapplyStoredTitle(deps, 's1');

      expect(applied).toBeNull();
      expect(deps.onTitle).not.toHaveBeenCalled();
    },
  );

  it('trims the stored title before applying it', async () => {
    const deps = mkDeps({ getStoredTitle: vi.fn(async () => '  Fixing The Login Bug  ') });
    await reapplyStoredTitle(deps, 's1');

    expect(deps.onTitle).toHaveBeenCalledWith('s1', 'Fixing The Login Bug');
  });

  it('swallows a store read failure — a resume must never fail over a title', async () => {
    const deps = mkDeps({ getStoredTitle: vi.fn(async () => { throw new Error('store unavailable'); }) });

    await expect(reapplyStoredTitle(deps, 's1')).resolves.toBeNull();
    expect(deps.onTitle).not.toHaveBeenCalled();
  });

  it('swallows a broadcast failure for the same reason', async () => {
    const deps = mkDeps({ onTitle: vi.fn(() => { throw new Error('window destroyed'); }) });

    await expect(reapplyStoredTitle(deps, 's1')).resolves.toBeNull();
    // Assert we actually REACHED the throwing call. Without this the test would
    // still pass if a future edit made the default stored title a placeholder,
    // short-circuiting before onTitle — a vacuous green.
    expect(deps.onTitle).toHaveBeenCalledTimes(1);
  });
});
