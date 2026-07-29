import type { MockStore } from './mock-store';
import { buildHydratePayload } from './seed-chat';

/** Dotted paths this shim implements by hand (`'session.list'`), plus dotless
 *  top-level bridge members (`'getPlatform'`). The contract test
 *  (tests/workbench-mock-contract.test.ts) checks each against preload.ts. */
export const HAND_WRITTEN: ReadonlyArray<string> = [
  'devLabel', 'getPlatform', 'getHomePath', 'getFavorites', 'setFavorites',
  'off', 'removeAllListeners',
  'session.list', 'session.create', 'session.browse', 'session.destroy',
  'session.setFlag', 'session.setTag', 'session.setNote',
  'providers.list', 'providers.catalog', 'models.memoryCheck',
  'defaults.get', 'defaults.set', 'detach.openDetached',
  'tags.list', 'tags.create', 'tags.update', 'tags.delete',
  'on.sessionCreated', 'on.sessionDestroyed', 'on.sessionRenamed',
  'on.sessionMetaChanged',
  'theme.list', 'theme.readFile', 'theme.writeFile', 'theme.onReload',
  // Real, but served by remote-shim.ts rather than preload.ts — Electron
  // clients get their timelines from the transcript watcher instead. The
  // contract test checks both files for exactly this reason.
  'on.chatHydrate',
];

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

// Community theme packs, vendored so the workbench never opens a socket (§2).
// The four builtins need nothing — theme-context.tsx imports them directly.
// @ts-ignore TS1343 — Vite rewrites import.meta.glob at build time.
const themeRaw = import.meta.glob('./fixtures/themes/*.json', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

const THEME_FIXTURES: Record<string, string> = Object.fromEntries(
  Object.entries(themeRaw).map(([p, raw]) => [p.split('/').pop()!.replace('.json', ''), raw]),
);

/** Each namespace is typed against the real consumer contract, so `tsc` rejects
 *  a wrong method name or signature. `Partial` is what lets the mock implement
 *  three of a namespace's twelve methods — the three still have to match.
 *  Spec §1.3. */
type Ns<K extends keyof Window['claude']> = Partial<Window['claude'][K]>;

// Channels that exist in preload.ts but are ABSENT from useIpc.ts's typed
// contract, so the compiler cannot check them — these are the `(window as any)`
// call sites spec §1.3 names as the caveat. Verified against preload.ts
// 2026-07-29: session.setFlag/setTag/setNote (preload session block),
// detach.openDetached (preload:959), the whole `tags` namespace (preload:405),
// and on.sessionMetaChanged (preload:472). The contract test is the only guard
// on these four groups; do not delete it.
interface UntypedSessionWrites {
  setFlag: (sessionId: string, flag: string, value: boolean) => Promise<{ ok: boolean }>;
  setTag: (sessionId: string, tagId: string, value: boolean) => Promise<{ ok: boolean }>;
  setNote: (sessionId: string, note: string) => Promise<{ ok: boolean }>;
}

/** Hand-written channel implementations, backed by the store. */
function handWritten(store: MockStore): Record<string, Record<string, unknown>> {
  // Subscriber sets, one per real event the renderer listens for. These are the
  // channels the UI actually re-fetches on — see the WHY on the emits below.
  const subs = {
    created: new Set<(s: any) => void>(),
    destroyed: new Set<(id: string) => void>(),
    renamed: new Set<(id: string, name: string) => void>(),
    meta: new Set<(id: string, meta: any) => void>(),
  };

  /** Applies a mutation only when writes are allowed, so the refused scenario
   *  exercises the components' revert paths rather than silently succeeding.
   *  EVERY {ok}-shaped write goes through this — including defaults.set. A
   *  write that quietly succeeds under `refused` teaches the reviewer the
   *  revert path is fine when it never ran. */
  const write = (mutate: () => void): Promise<{ ok: boolean }> => {
    if (store.refuseWrites) return Promise.resolve({ ok: false });
    mutate();
    return Promise.resolve({ ok: true });
  };

  const session: Ns<'session'> & UntypedSessionWrites = {
    list: async () => store.getState().sessions,
    browse: async () => store.getState().past,

    create: async (opts) => {
      // Deterministic-ish id without Date.now(): the store's length is enough
      // to keep ids unique within a page, and stable across reloads.
      const id = `wb-new-${store.getState().sessions.length + 1}`;
      const created = {
        id,
        name: opts.name || 'new session',
        cwd: opts.cwd || '',
        permissionMode: opts.skipPermissions ? 'bypass' : 'normal',
        skipPermissions: !!opts.skipPermissions,
        status: 'active',
        createdAt: 1_753_800_000_000,
        provider: opts.provider ?? 'claude',
        harnessId: (opts as any).harnessId,
        model: opts.model,
      };
      store.setState((s) => ({ ...s, sessions: [...s.sessions, created as any] }));
      // WHY emit: the renderer does not poll. App re-fetches on
      // `on.sessionCreated`; without this the row lands in the store and never
      // on screen, which reads as a bug in the surface under design rather
      // than a hole in the mock. Spec §3.3.
      subs.created.forEach((f) => f(created));
      return created;
    },

    // Typed `Promise<boolean>` in useIpc.ts — NOT the {ok} shape the other
    // writes use. A caller treating `false` as success is exactly the bug the
    // type is there to prevent, so it does not go through write().
    destroy: async (sessionId: string) => {
      if (store.refuseWrites) return false;
      store.setState((s) => ({ ...s, sessions: s.sessions.filter((x) => x.id !== sessionId) }));
      subs.destroyed.forEach((f) => f(sessionId));
      return true;
    },

    setFlag: (sessionId, flag, value) => write(() => {
      store.setState((s) => ({
        ...s,
        past: s.past.map((p) => (p.sessionId === sessionId
          ? { ...p, flags: { ...(p.flags ?? {}), [flag]: value } }
          : p)),
      }));
      subs.meta.forEach((f) => f(sessionId, { flag, value }));
    }),

    setTag: (sessionId, tagId, value) => write(() => {
      store.setState((s) => ({
        ...s,
        past: s.past.map((p) => (p.sessionId === sessionId
          ? {
            ...p,
            tags: value
              ? [...new Set([...(p.tags ?? []), tagId])]
              : (p.tags ?? []).filter((t) => t !== tagId),
          }
          : p)),
      }));
      subs.meta.forEach((f) => f(sessionId, { flag: `tag:${tagId}`, value }));
    }),

    setNote: (sessionId, note) => write(() => {
      store.setState((s) => ({
        ...s,
        past: s.past.map((p) => (p.sessionId === sessionId ? { ...p, note } : p)),
      }));
      subs.meta.forEach((f) => f(sessionId, { note }));
    }),
  };

  const providers: Ns<'providers'> = {
    list: async () => store.getState().providers,
    catalog: async () => store.getState().catalog,
  };

  const models: Ns<'models'> = {
    // RuntimeBinding.tsx only calls this for the local-engine provider. The
    // verdict union is checked by the compiler — useIpc.ts:329.
    memoryCheck: async (modelId: string) => (modelId.includes('14b')
      ? {
        verdict: 'tight' as const,
        headline: 'This model is a tight fit.',
        detail: 'Loading it may evict another resident model.',
      }
      : { verdict: 'ok' as const, headline: '', detail: '' }),
  };

  const defaults: Ns<'defaults'> = {
    get: async () => store.getState().defaults,
    set: (updates) => write(() => {
      store.setState((s) => ({ ...s, defaults: { ...s.defaults, ...updates } }));
    }),
  };

  const native: Ns<'native'> = { supported: true };

  // `openDetached` is real (preload:959) but missing from useIpc.ts's `detach`
  // block, so it cannot come from Ns<'detach'>. Note the real signature takes an
  // OBJECT, not a positional sessionId.
  const detach: Ns<'detach'> & { openDetached: (payload: { sessionId: string }) => void } = {
    // Present so `detachAvailable` is true and the "Launch in New Window"
    // toggle renders (SessionStrip.tsx:191, ResumeBrowser.tsx:242 both test
    // `typeof ... === 'function'`). A browser tab cannot actually detach — say
    // so loudly rather than pretending it worked.
    openDetached: () => {
      console.warn('[workbench] detach is not available in a browser tab');
    },
  };

  // No `tags` namespace exists in useIpc.ts at all, so none of this is
  // compiler-checked. preload.ts:405 names the delete channel `delete`, NOT
  // `remove` — the contract test is what caught that.
  const tags = {
    list: async () => store.getState().tags,
    create: async (label: string, color: string) => {
      const tag = {
        id: `tag_${label}`,
        label,
        color,
        archived: false,
        createdAt: '2026-07-29T12:00:00.000Z',
      };
      store.setState((s) => ({ ...s, tags: [...s.tags, tag as any] }));
      return tag;
    },
    update: (id: string, patch: object) => write(() => {
      store.setState((s) => ({
        ...s,
        tags: s.tags.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      }));
    }),
    delete: (id: string) => write(() => {
      store.setState((s) => ({ ...s, tags: s.tags.filter((t) => t.id !== id) }));
    }),
  };

  // Registrars return their unsubscribe synchronously — never a promise. The
  // shim's withLatency() passes non-promise returns through untouched for
  // exactly this reason.
  //
  // sessionRenamed is registered but never fired: preload has no renderer-side
  // rename writer (renames are emitted by the main process's auto-namer), so
  // there is nothing in a browser-only workbench that could trigger one.
  const on: Ns<'on'> & { sessionMetaChanged: (fn: (id: string, meta: any) => void) => () => void } = {
    sessionCreated: (cb) => { subs.created.add(cb); return () => { subs.created.delete(cb); }; },
    sessionDestroyed: (cb) => { subs.destroyed.add(cb); return () => { subs.destroyed.delete(cb); }; },
    sessionRenamed: (cb) => { subs.renamed.add(cb); return () => { subs.renamed.delete(cb); }; },
    sessionMetaChanged: (cb) => { subs.meta.add(cb); return () => { subs.meta.delete(cb); }; },

    // Seeds the chat timelines the moment App subscribes (App.tsx:1465), the
    // same way remote-shim delivers a snapshot to a remote browser on connect.
    // Fires synchronously rather than on a timer: App's subscribe happens in an
    // effect, so dispatching here lands in the same commit and the timeline is
    // present on first paint instead of flashing empty.
    chatHydrate: (cb) => {
      cb(buildHydratePayload());
      return () => {};
    },
  };

  // `theme` is absent from useIpc.ts entirely, so NONE of this is
  // compiler-checked — the contract test is the only guard. Typed as a plain
  // object rather than Ns<'theme'> because there is no 'theme' key on
  // Window['claude'] to index; that is an exception, not an oversight.
  //
  // FIDELITY GAP, stated rather than hidden (spec §4): theme-asset-resolver.ts
  // rewrites a pack's asset paths to `theme-asset://<slug>/<path>`, an Electron
  // custom protocol. A browser tab has no such scheme, so Halftone Dimension's
  // pattern, mascots and icons render as broken images here — colors, radii,
  // fonts and the glass cascade are all faithful. Making assets load would mean
  // teaching theme-asset-resolver.ts a second scheme, which is a production
  // change for a dev-only gain; left undone deliberately.
  const theme = {
    list: async () => Object.keys(THEME_FIXTURES),
    readFile: async (slug: string) => THEME_FIXTURES[slug] ?? '{}',
    // Writes never touch disk. Editing a fixture + Vite HMR is the reload path.
    writeFile: async () => ({ ok: true }),
    onReload: (_cb: (slug: string) => void) => () => {},
  };

  return {
    session, providers, models, defaults, native, detach, tags, on, theme,
  } as unknown as Record<string, Record<string, unknown>>;
}
