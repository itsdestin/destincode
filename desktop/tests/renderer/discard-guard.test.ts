import { describe, it, expect, vi } from 'vitest';
import { runGuardedDiscard } from '../../src/renderer/components/git/discard-guard';

// Pins the 2026-07-22 stale-banner bug: a discard result that lands after the
// review closed (token bumped) must never write into the reopened view.
describe('runGuardedDiscard', () => {
  it('surfaces the real error verbatim while the attempt is current', async () => {
    const setError = vi.fn();
    await runGuardedDiscard(
      async () => ({ ok: false, error: 'fatal: could not restore f.ts' }),
      { current: 0 }, setError,
    );
    expect(setError).toHaveBeenCalledWith('fatal: could not restore f.ts');
  });

  it('clears the banner on success', async () => {
    const setError = vi.fn();
    await runGuardedDiscard(async () => ({ ok: true }), { current: 0 }, setError);
    expect(setError).toHaveBeenCalledWith(null);
  });

  it('drops a result that lands after the review closed (token bumped mid-flight)', async () => {
    const setError = vi.fn();
    const gen = { current: 0 };
    let resolve!: (v: { ok: boolean; error?: string }) => void;
    const pending = runGuardedDiscard(
      () => new Promise((r) => { resolve = r; }), gen, setError,
    );
    gen.current += 1; // user closed (and maybe reopened) the review
    resolve({ ok: false, error: 'stale failure from the OLD attempt' });
    await pending;
    expect(setError).not.toHaveBeenCalled();
  });

  it('a rejected discard surfaces its message — but not when superseded', async () => {
    const setError = vi.fn();
    await runGuardedDiscard(
      () => Promise.reject(new Error('spawn git ENOENT')), { current: 0 }, setError,
    );
    expect(setError).toHaveBeenCalledWith('spawn git ENOENT');

    const setError2 = vi.fn();
    const gen = { current: 0 };
    let reject!: (e: Error) => void;
    const pending = runGuardedDiscard(
      () => new Promise((_r, rj) => { reject = rj; }), gen, setError2,
    );
    gen.current += 1;
    reject(new Error('late failure'));
    await pending;
    expect(setError2).not.toHaveBeenCalled();
  });

  it('an unavailable git api reports the generic non-committal failure', async () => {
    const setError = vi.fn();
    // window.claude?.git?.discard?.(…) evaluates to undefined when the API is absent.
    await runGuardedDiscard(() => undefined, { current: 0 }, setError);
    expect(setError).toHaveBeenCalledWith('git discard failed');
  });
});
