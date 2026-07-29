import { describe, it, expect, vi } from 'vitest';
import { createStore } from '../src/renderer/dev/workbench/mock-store';
import { createMockShim, setLatency, getLatency } from '../src/renderer/dev/workbench/mock-shim';

const DEFAULT_LATENCY = getLatency();
setLatency(0);

const shim = () => createMockShim(createStore('default')) as any;

describe('mock shim Proxy semantics', () => {
  // Each of these pins a specific way the catch-all can silently break the app
  // it is standing in for. They are cheap to keep and expensive to rediscover.

  it('an unimplemented channel resolves [] rather than null', async () => {
    // `const rows = await claude.x.list(); rows.map(...)` is the dominant
    // consumer shape — null turns a missing stub into a crash in the surface
    // under design.
    const rows = await shim().skills.list();
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toEqual([]);
  });

  it('gives each caller its own array', async () => {
    const c = shim();
    const a = await c.skills.list();
    a.push('poison');
    expect(await c.skills.list()).toEqual([]);
  });

  it('warns once per channel, not once per call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const c = shim();
    await c.social.somethingUnbuilt();
    await c.social.somethingUnbuilt();
    await c.social.somethingUnbuilt();
    const mine = warn.mock.calls.filter((args) =>
      String(args[0]).includes('social.somethingUnbuilt'));
    expect(mine).toHaveLength(1);
    warn.mockRestore();
  });

  // A namespace that answers `then` with a function looks thenable, so
  // `await claude.session` hangs forever instead of resolving to the object —
  // a hang with no error, in the one place nobody would think to look.
  it('never answers `then` or symbols with a function', async () => {
    const c = shim();
    expect(c.session.then).toBeUndefined();
    expect(c.then).toBeUndefined();
    expect(c.session[Symbol.iterator]).toBeUndefined();
    // The actual failure this prevents: awaiting a namespace must settle.
    await expect(Promise.race([
      Promise.resolve(c.session),
      new Promise((_, reject) => setTimeout(() => reject(new Error('hung')), 50)),
    ])).resolves.toBeTruthy();
  });

  // `off(handler)` and every React dependency array holding a bridge member
  // depend on the member being the same object each read.
  it('returns a stable function identity per member', () => {
    const c = shim();
    expect(c.skills.list).toBe(c.skills.list);
    expect(c.session.list).toBe(c.session.list);
    expect(c.social).toBe(c.social);
  });

  // A `has` trap returning true for everything makes `'x' in claude.y` lie.
  it('does not claim to have members it lacks', () => {
    const c = shim();
    expect('thisIsNotAChannel' in c.session).toBe(false);
    expect('thisIsNotANamespace' in c).toBe(false);
  });

  // Capability gates read this directly; an unknown top-level property must not
  // become a namespace object where a function is expected.
  it('exposes top-level callables as functions, not namespace proxies', async () => {
    const c = shim();
    expect(typeof c.getPlatform).toBe('function');
    expect(typeof c.getHomePath).toBe('function');
    expect(typeof c.off).toBe('function');
    expect(typeof c.removeAllListeners).toBe('function');
    // platform.ts:23 calls this after a truthiness guard — it must not throw.
    await expect(c.getPlatform()).resolves.toBe('linux');
    await expect(c.getFavorites()).resolves.toEqual([]);
  });

  it('unknown namespaces still degrade gracefully', async () => {
    await expect(shim().someFutureNamespace.someFutureCall()).resolves.toEqual([]);
  });

  it('on.* registrars return an unsubscribe synchronously', () => {
    const off = shim().on.somethingNobodyImplemented(() => {});
    expect(typeof off).toBe('function');
    expect(() => off()).not.toThrow();
  });

  it('defaults to non-zero latency so loading states are visible', () => {
    expect(DEFAULT_LATENCY).toBeGreaterThan(0);
  });

  it('applies latency to channel results when set', async () => {
    setLatency(60);
    const started = performance.now();
    await shim().skills.list();
    expect(performance.now() - started).toBeGreaterThanOrEqual(50);
    setLatency(0);
  });
});
