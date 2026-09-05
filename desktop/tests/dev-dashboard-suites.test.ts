import { describe, it, expect } from 'vitest';
// @ts-expect-error — dev-only helper, plain ESM with no .d.ts
import { SUITES, suiteByKey, runSuite } from '../dev-dashboard/suites.mjs';
// @ts-expect-error — dev-only helper, plain ESM with no .d.ts
import { takeOffset, OFFSET_POOL } from '../dev-dashboard/instances.mjs';

const checkout = { id: 'x', path: '/tmp/wt', name: 'wt', branch: 'feat/x' };

describe('the suite registry', () => {
  it('states every suite\'s weight, so nothing looks equivalent to the 10-second one', () => {
    for (const s of SUITES) expect(s.weight).toBeTruthy();
  });

  it('marks exactly one suite paid', () => {
    expect(SUITES.filter((s: { paid: boolean }) => s.paid).map((s: { key: string }) => s.key))
      .toEqual(['model-eval']);
  });

  it('builds every command as an argument array, never a shell string', () => {
    for (const s of SUITES) {
      const { cmd, args } = s.argv(checkout, '/ws');
      expect(typeof cmd).toBe('string');
      expect(Array.isArray(args)).toBe(true);
      // A shell metacharacter in a built argument means someone concatenated.
      expect(args.some((a: string) => /[;&|`$]/.test(a))).toBe(false);
    }
  });

  it('always passes a spend cap to the paid suite', () => {
    const { args } = suiteByKey('model-eval').argv(checkout, '/ws');
    expect(args).toContain('--max-spend');
  });

  it('never runs Gradle without -x bundleWebUi', () => {
    // bundleWebUi transitively runs `npm ci`, which is destructive against a
    // hardlinked node_modules and has emptied six worktrees at once before.
    const { args } = suiteByKey('android').argv(checkout, '/ws');
    expect(args).toContain('-x');
    expect(args).toContain('bundleWebUi');
  });
});

describe('runSuite', () => {
  it('refuses the paid suite without an explicit confirmation', async () => {
    await expect(runSuite('model-eval', checkout, { workspaceRoot: '/ws', confirmSpend: false }))
      .rejects.toThrow(/confirm/i);
  });

  it('refuses the paid suite when an API key is in the environment', async () => {
    // harness-eval.mjs refuses to start if OPENROUTER_API_KEY is readable by the
    // models it hires. The helper must not defeat that guard by passing one down.
    const prev = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = 'sk-test';
    try {
      await expect(runSuite('model-eval', checkout, { workspaceRoot: '/ws', confirmSpend: true }))
        .rejects.toThrow(/OPENROUTER_API_KEY/);
    } finally {
      if (prev === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = prev;
    }
  });

  it('names an unknown suite instead of silently doing nothing', async () => {
    await expect(runSuite('nope', checkout, { workspaceRoot: '/ws' }))
      .rejects.toThrow(/no suite named nope/);
  });
});

describe('takeOffset', () => {
  it('gives the lowest free offset', () => {
    expect(takeOffset([])).toBe(OFFSET_POOL[0]);
    expect(takeOffset([50])).toBe(60);
    expect(takeOffset([50, 60, 70])).toBe(80);
  });

  it('never hands out an offset already in use', () => {
    // Two dev instances on the same offset SIGKILL each other's window — that
    // collision is possible by hand today and is the reason the pool exists.
    const taken = [50, 70];
    expect(taken).not.toContain(takeOffset(taken));
  });

  it('throws rather than colliding when the pool is exhausted', () => {
    expect(() => takeOffset([...OFFSET_POOL])).toThrow(/no free port offset/i);
  });
});
