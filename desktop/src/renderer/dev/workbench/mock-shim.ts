import type { MockStore } from './mock-store';

/** Dotted paths this shim implements by hand (`'session.list'`), plus dotless
 *  top-level bridge members (`'getPlatform'`). The contract test
 *  (tests/workbench-mock-contract.test.ts) checks each against preload.ts. */
export const HAND_WRITTEN: ReadonlyArray<string> = [
  'devLabel', 'getPlatform', 'getHomePath', 'getFavorites', 'setFavorites',
  'off', 'removeAllListeners',
];  // Task 4 appends the namespaced channels.

const warned = new Set<string>();

// --- Latency -----------------------------------------------------------------
// Real IPC resolves a tick or several after the call; a mock that resolves
// immediately hides the entire class of bug UI-first development introduces —
// loading states that never render, empty-then-populated flicker, mount races,
// spinners nobody ever saw because nothing took long enough to show one. That
// is invisible in the workbench and obvious in the app, which is the wrong way
// round. Default 150ms, not 0. Spec §4.
const DEFAULT_LATENCY_MS = 150;

function latencyFromQuery(): number {
  // `location` is absent under the node test environment; the tests set the
  // value they need via setLatency() instead of faking a URL.
  if (typeof location === 'undefined') return DEFAULT_LATENCY_MS;
  const raw = new URLSearchParams(location.search).get('latency');
  if (raw === null) return DEFAULT_LATENCY_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_LATENCY_MS;
}

let latencyMs = latencyFromQuery();

export function setLatency(ms: number): void { latencyMs = ms; }
export function getLatency(): number { return latencyMs; }

function delay<T>(value: T): Promise<T> {
  return latencyMs <= 0
    ? Promise.resolve(value)
    : new Promise((resolve) => setTimeout(() => resolve(value), latencyMs));
}

/** Applies the latency knob to a hand-written channel's result. Non-promise
 *  returns pass through untouched — `on.*` registrars hand back an unsubscribe
 *  function synchronously and delaying it would break every caller's cleanup,
 *  and `native.supported` is a plain boolean, not a call. */
function withLatency(fn: (...a: any[]) => any) {
  return (...args: unknown[]) => {
    const out = fn(...args);
    return out instanceof Promise ? out.then((v) => delay(v)) : out;
  };
}

/** Wraps a namespace so unimplemented members warn once and resolve empty,
 *  instead of throwing "not a function". This is what keeps a few-hundred
 *  channel surface from becoming a stubbing project (spec §3.2). */
function withCatchAll(namespace: string, impl: Record<string, unknown>): Record<string, unknown> {
  // Memoized so a given member is always the SAME function object. Minting a
  // fresh wrapper per property read would break `off(handler)` unsubscribes and
  // silently defeat every React dependency array that holds one.
  const cache = new Map<string, unknown>();

  return new Proxy(impl, {
    get(target, prop) {
      // Symbols and `then` must be undefined. If a namespace answers `then`
      // with a function it looks thenable, so `await claude.session` hangs
      // forever instead of resolving to the object — a hang with no error, in
      // the one place nobody would think to look.
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      const key = prop as string;

      if (key in target) {
        const value = (target as any)[key];
        if (typeof value !== 'function') return value;
        if (!cache.has(key)) cache.set(key, withLatency(value as (...a: any[]) => any));
        return cache.get(key);
      }

      // `on.*` members are subscription registrars — they must return an
      // unsubscribe function synchronously, not a promise.
      if (namespace === 'on') {
        if (!cache.has(key)) cache.set(key, () => () => {});
        return cache.get(key);
      }

      if (!cache.has(key)) {
        cache.set(key, (...args: unknown[]) => {
          const id = `${namespace}.${key}`;
          if (!warned.has(id)) {
            warned.add(id);
            console.warn(`[workbench] unimplemented channel ${id}`, args);
          }
          // WHY [] and not null: the dominant consumer shape is
          // `const rows = await claude.x.list(); rows.map(...)`, and null throws
          // there — turning a missing stub into a crash in the surface under
          // design. [] satisfies list consumers, reads as "no properties" to
          // object consumers exactly as {} would, and never trips a
          // `res.ok === false` check. A fresh array each call so a consumer
          // that mutates the result cannot poison the next one.
          return delay([] as unknown);
        });
      }
      return cache.get(key);
    },
    // NOTE: deliberately no `has` trap. One returning true for everything makes
    // `'x' in claude.y` lie, and optional chaining never consults `has`, so it
    // would cost correctness and buy nothing.
  });
}

// Namespaces the renderer reaches for. Derived from the typed contract in
// renderer/hooks/useIpc.ts (21 namespaces) plus the untyped `theme` namespace
// that theme-context.tsx uses.
const NAMESPACES = [
  'session', 'skills', 'on', 'dialog', 'shell', 'terminal', 'update', 'remote',
  'account', 'social', 'marketplaceApi', 'detach', 'defaults', 'analytics', 'dev',
  'performance', 'app', 'native', 'providers', 'engine', 'models', 'theme',
  'commands', 'tags', 'artifacts', 'firstRun', 'clipboard', 'window',
];

export function createMockShim(store: MockStore): Window['claude'] {
  const impls = handWritten(store);

  const bridge: Record<string, unknown> = {
    devLabel: 'Workbench',

    // Top-level CALLABLE bridge members. These are NOT namespaces, and the
    // bridge catch-all below would hand back a namespace Proxy — an object, not
    // a function. platform.ts:17 guards on `w.claude?.getPlatform` (a Proxy
    // passes that guard), then :23 calls it: TypeError inside an async
    // function, so platform detection never resolves and the rejection is
    // swallowed. All six are hand-written for exactly that reason.
    getPlatform: async () => 'linux' as const,
    getHomePath: async () => '/home/destin',
    getFavorites: async () => [],
    setFavorites: async () => undefined,
    off: () => {},
    removeAllListeners: () => {},
  };
  for (const ns of NAMESPACES) bridge[ns] = withCatchAll(ns, impls[ns] ?? {});

  const unknownNs = new Map<string, unknown>();
  return new Proxy(bridge, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      const key = prop as string;
      if (key in target) return (target as any)[key];
      // Memoized for the same identity-stability reason as above.
      if (!unknownNs.has(key)) unknownNs.set(key, withCatchAll(key, {}));
      return unknownNs.get(key);
    },
    // Same reasoning as withCatchAll: no `has` trap.
  }) as unknown as Window['claude'];
}

/** Hand-written channel implementations. Task 4 fills this in. */
function handWritten(_store: MockStore): Record<string, Record<string, unknown>> {
  return {};
}
