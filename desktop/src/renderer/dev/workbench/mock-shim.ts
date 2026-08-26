import type { MockStore } from './mock-store';
import { FULL_READ_MAX_BYTES } from '../../../shared/artifacts/editable-path-policy';
import { buildHydratePayload } from './seed-chat';
import {
  projects as artifactProjects, projectsWithCounts, sessionArtifacts, allFiles,
  CONTENT as ARTIFACT_CONTENT, SAMPLE_PNG_BASE64, contextGroups,
} from './fixtures/artifacts';
import type { MockState, MockSessionMeta } from './scenarios';
import { MARKETPLACE_PLUGINS, MARKETPLACE_THEMES, INSTALLED_SKILLS, INSTALLED_PACKAGES, FEATURED } from './fixtures/marketplace/registry';

// artifactId -> pretend on-disk size, for exercising the over-cap artifact
// states (partial-view banner, handoff) against the fake backend.
// artifactId -> pretend on-disk size for fixtures with no text body at all:
// the handler answers binary:true (never orphan), which is how a real
// unsupported format reaches the handoff view rather than "no longer on disk".
const BINARY_FIXTURES: Record<string, number> = {
  'a-clip-mp4': 18 * 1024 * 1024,
};

const OVERSIZE_FIXTURES: Record<string, number> = {
  'a-big-log': 8.4 * 1024 * 1024,     // under FULL_READ_MAX_BYTES -> offers "Load the whole file"
  'a-huge-dump': 500 * 1024 * 1024,   // above it -> no load action
};

/** Dotted paths this shim implements by hand (`'session.list'`), plus dotless
 *  top-level bridge members (`'getPlatform'`). The contract test
 *  (tests/workbench-mock-contract.test.ts) checks each against preload.ts. */
export const HAND_WRITTEN: ReadonlyArray<string> = [
  'devLabel', 'getPlatform', 'getHomePath', 'getFavorites', 'setFavorites',
  'getIncognito', 'setIncognito', 'onChatExportSnapshot',
  'sendChatSnapshotResponse', 'fireRemoteAttentionChanged',
  'off', 'removeAllListeners',
  'session.list', 'session.create', 'session.browse', 'session.destroy',
  'session.setFlag', 'session.setTag', 'session.setNote', 'session.getMeta',
  'providers.list', 'providers.catalog', 'models.memoryCheck',
  // No backend yet (M5 2a) — registered in mock-only.ts. Listed here so the
  // contract test actually covers them; a channel absent from HAND_WRITTEN
  // escapes the real-or-registered check entirely.
  'permissions.list', 'permissions.remove', 'permissions.removeProject',
  'defaults.get', 'defaults.set', 'detach.openDetached',
  'tags.list', 'tags.create', 'tags.update', 'tags.delete',
  'on.sessionCreated', 'on.sessionDestroyed', 'on.sessionRenamed',
  'on.sessionMetaChanged',
  'theme.list', 'theme.readFile', 'theme.writeFile', 'theme.onReload',
  'firstRun.getState', 'terminal.getScreenText',
  'artifacts.listProjectsIndex', 'artifacts.listSession', 'artifacts.listProject',
  'artifacts.listAllFiles', 'artifacts.get', 'artifacts.checkExistence',
  'artifacts.searchContent', 'artifacts.watchProject', 'artifacts.unwatchProject',
  'artifacts.readBinary',
  'syncSpaces.status',
  'project.listConversations', 'project.listContext', 'project.readContextFile',
  'project.writeContextFile', 'project.repoInfo',
  'account.signedIn', 'account.user', 'account.refresh',
  'appearance.getFavoriteThemes', 'appearance.favoriteTheme', 'appearance.get',
  'appearance.set', 'appearance.broadcast',
  'skills.listMarketplace', 'skills.list', 'skills.getFavorites', 'skills.setFavorite', 'skills.getFeatured',
  'marketplace.getPackages', 'theme.marketplace',
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
 *  channel surface from becoming a stubbing project (spec §3.2).
 *
 *  WHY THE TARGET IS A FUNCTION: an unknown member of the bridge may be either a
 *  NAMESPACE (`claude.session.list()`) or a BARE CALLABLE
 *  (`claude.getIncognito()`), and nothing about the property access
 *  distinguishes them — by the time you know, you have already had to return
 *  something. A plain object target makes every bare callable throw "is not a
 *  function", which is how `window.claude?.getIncognito is not a function` took
 *  the whole app down at boot even though six other top-level callables were
 *  hand-written. A callable target satisfies both shapes, so the failure mode
 *  cannot come back for the seventh. */
function withCatchAll(namespace: string, impl: Record<string, unknown>): Record<string, unknown> {
  // Memoized so a given member is always the SAME function object. Minting a
  // fresh wrapper per property read would break `off(handler)` unsubscribes and
  // silently defeat every React dependency array that holds one.
  const cache = new Map<string, unknown>();

  // Named for readable stack traces. Its own properties (name/length/prototype)
  // are deliberately NOT consulted below — `hasOwnProperty(impl)` is the check,
  // not `in target`, or `claude.session.name` would return "" instead of a stub.
  const target = function workbenchChannel() {} as unknown as Record<string, unknown>;

  return new Proxy(target, {
    get(_target, prop) {
      // Symbols and `then` must be undefined. If a namespace answers `then`
      // with a function it looks thenable, so `await claude.session` hangs
      // forever instead of resolving to the object — a hang with no error, in
      // the one place nobody would think to look.
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      const key = prop as string;

      if (Object.prototype.hasOwnProperty.call(impl, key)) {
        const value = impl[key];
        // A nested hand-written namespace (`theme.marketplace = { list }`) gets
        // the same catch-all as a top-level one, so the members it does NOT
        // implement still resolve `[]` rather than being undefined — the
        // synchronous-throw-inside-Promise.all bug workbench-shim-semantics pins.
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          if (!cache.has(key)) cache.set(key, withCatchAll(`${namespace}.${key}`, value as Record<string, unknown>));
          return cache.get(key);
        }
        if (typeof value !== 'function') return value;
        if (!cache.has(key)) cache.set(key, withLatency(value as (...a: any[]) => any));
        return cache.get(key);
      }

      // Subscription registrars must return an unsubscribe function
      // SYNCHRONOUSLY, not a promise. Two shapes qualify, and missing the
      // second one is what produced `cleanupDir is not a function` at boot:
      //
      //   1. everything in the `on` namespace  (claude.on.sessionCreated)
      //   2. any `on[A-Z]…` member of ANY namespace — claude.detach.onDirectoryUpdated,
      //      claude.theme.onReload, claude.window.onFullscreenChanged, …
      //
      // Callers routinely do `const cleanup = ns.onThing(cb)` inside a
      // useEffect and return it, so handing back a Promise makes React call a
      // Promise as the cleanup and take the whole app down via
      // RootErrorBoundary. `on[A-Z]` is a consistent convention in preload.ts
      // (verified 2026-07-29: onDirectoryUpdated, onReload, onInstallProgress,
      // onFullscreenChanged, onLeaderChanged, …).
      if (namespace === 'on' || /^on[A-Z]/.test(key)) {
        if (!cache.has(key)) cache.set(key, () => () => {});
        return cache.get(key);
      }

      // An unknown member may itself be a NESTED NAMESPACE, not a leaf channel:
      // `claude.theme.marketplace.list()`, `claude.skills.getFeatured`. Returning
      // a plain function makes `.list` undefined, and calling it throws
      // SYNCHRONOUSLY — before any `.catch()` in the caller's expression is
      // attached. That is how one unimplemented nested channel rejected the
      // whole marketplace load and left theme favourites empty, which showed up
      // as "the Appearance panel only offers one theme". Recursing keeps the
      // member callable AND indexable to any depth.
      if (!cache.has(key)) {
        cache.set(key, withCatchAll(`${namespace}.${key}`, {}));
      }
      return cache.get(key);
    },

    // Reached when the member is used as a bare callable rather than a
    // namespace — `claude.getIncognito()`, or `claude.theme.marketplace()`.
    apply(_target, _thisArg, args: unknown[]) {
      if (!warned.has(namespace)) {
        warned.add(namespace);
        console.warn(`[workbench] unimplemented channel ${namespace}`, args);
      }
      return delay([] as unknown);
    },

    // The trap must delegate to `impl`, NOT to the function target: the default
    // would report `name`, `length` and `prototype` as present. It still answers
    // honestly for real members, which is the point — a trap returning true for
    // everything makes `'x' in claude.y` lie.
    has(_target, prop) {
      return Object.prototype.hasOwnProperty.call(impl, prop);
    },
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

    // Top-level CALLABLE bridge members — NOT namespaces. The catch-all is
    // callable now, so a missing one degrades instead of crashing; these are
    // hand-written anyway because a bare `[]` is the wrong ANSWER for most of
    // them (getIncognito must be a boolean, getHomePath a string).
    //
    // Enumerated from preload.ts, which is the authority — deriving this list
    // from useIpc.ts instead is what missed getIncognito/setIncognito and the
    // three chat-snapshot members, and a missing getIncognito took the whole
    // app down at boot with "is not a function".
    // Verified 2026-07-29: preload.ts:372,518,523,525,586,808,810,900-905.
    getPlatform: async () => 'linux' as const,
    getHomePath: async () => '/home/destin',
    getFavorites: async () => [],
    setFavorites: async () => undefined,
    getIncognito: async () => false,
    setIncognito: async () => undefined,
    // Desktop's chat-snapshot export path. The workbench hydrates via
    // on.chatHydrate instead (seed-chat.ts), so these are inert by design:
    // registering a callback that never fires is what a browser tab with no
    // main process actually offers.
    onChatExportSnapshot: () => () => {},
    sendChatSnapshotResponse: () => undefined,
    fireRemoteAttentionChanged: () => undefined,
    off: () => {},
    removeAllListeners: () => {},
  };
  // Union, NOT just NAMESPACES: a hand-written namespace missing from that list
  // would otherwise be silently REPLACED by an empty catch-all, and the symptom
  // is not "channel missing" but "channel returns []" — which is how a
  // hand-written syncSpaces.status still crashed Project View with
  // "Cannot read properties of undefined (reading 'find')". Driving the impl
  // keys means a new namespace works the moment it is written.
  for (const ns of new Set([...NAMESPACES, ...Object.keys(impls)])) {
    bridge[ns] = withCatchAll(ns, impls[ns] ?? {});
  }

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
const themeRaw = import.meta.glob('./fixtures/themes/*/manifest.json', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

// Asset URLs, resolved by Vite. `?url` gives a real servable path, which is the
// whole point: a pack's manifest references its assets RELATIVELY
// ("assets/pattern.svg"), and theme-asset-resolver.ts would turn that into a
// theme-asset:// URI — an Electron custom protocol a browser tab cannot load,
// so every pattern, mascot and wallpaper rendered broken. Rewriting the relative
// paths to Vite URLs before the resolver sees them makes the pack render exactly
// as it does in the app. (The resolver passes root-absolute paths through
// unchanged — that is the contract its docblock always claimed.)
// @ts-ignore TS1343 — Vite rewrites import.meta.glob at build time.
const themeAssets = import.meta.glob('./fixtures/themes/*/assets/**/*', {
  query: '?url', import: 'default', eager: true,
}) as Record<string, string>;

const slugOf = (path: string) => path.split('/fixtures/themes/')[1].split('/')[0];

/** `halftone-dimension` -> { 'assets/pattern.svg': '/…/pattern.svg', … } */
const ASSET_URLS: Record<string, Record<string, string>> = {};
for (const [path, url] of Object.entries(themeAssets)) {
  const slug = slugOf(path);
  const rel = path.split(`/fixtures/themes/${slug}/`)[1];
  (ASSET_URLS[slug] ??= {})[rel] = url;
}

/** Deep-walks a parsed manifest and swaps every relative asset reference for its
 *  Vite URL. Walks values rather than string-replacing the raw JSON so a path
 *  appearing inside custom_css or a nested mascot map is handled the same way. */
function withResolvedAssets(value: unknown, urls: Record<string, string>): unknown {
  if (typeof value === 'string') {
    // Exact match first (the common case), then substring for custom_css blocks
    // that embed url(assets/…) inside a larger declaration.
    if (urls[value]) return urls[value];
    let out = value;
    for (const [rel, url] of Object.entries(urls)) {
      if (out.includes(rel)) out = out.split(rel).join(url);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => withResolvedAssets(v, urls));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, withResolvedAssets(v, urls)]),
    );
  }
  return value;
}

const THEME_FIXTURES: Record<string, string> = Object.fromEntries(
  Object.entries(themeRaw).map(([path, raw]) => {
    const slug = slugOf(path);
    const urls = ASSET_URLS[slug] ?? {};
    try {
      return [slug, JSON.stringify(withResolvedAssets(JSON.parse(raw), urls))];
    } catch {
      // A corrupt vendored manifest should surface as theme-context's own
      // validation warning, not as a crash inside the mock.
      return [slug, raw];
    }
  }),
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
  getMeta: (sessionId: string) => Promise<{ tags: string[]; note: string; supported: boolean; flags: Record<string, boolean> }>;
}

/** Upsert one session's meta slice, seeding from a `past` row of the same id so
 *  a first write doesn't drop metadata the fixtures already gave that row. */
function mergeMeta(
  s: MockState,
  sessionId: string,
  patch: (m: MockSessionMeta) => MockSessionMeta,
): Record<string, MockSessionMeta> {
  const row = s.past.find((p) => p.sessionId === sessionId);
  const current: MockSessionMeta = s.meta[sessionId] ?? {
    tags: row?.tags ?? [],
    note: row?.note ?? '',
    flags: (row?.flags ?? {}) as Record<string, boolean>,
  };
  return { ...s.meta, [sessionId]: patch(current) };
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

    // Reads the live-session meta slice, falling back to a `past` row of the
    // same id, then to empty. `supported: true` always — the desktop refuses
    // nothing here since Task 5, and a workbench that answered false would
    // render every tag control disabled and hide the surfaces being designed.
    getMeta: async (sessionId: string) => {
      const st = store.getState();
      const m = st.meta[sessionId];
      if (m) return { tags: m.tags, note: m.note, supported: true, flags: m.flags };
      const row = st.past.find((p) => p.sessionId === sessionId);
      return {
        tags: row?.tags ?? [],
        note: row?.note ?? '',
        supported: true,
        flags: (row?.flags ?? {}) as Record<string, boolean>,
      };
    },

    setFlag: (sessionId, flag, value) => write(() => {
      store.setState((s) => ({
        ...s,
        meta: mergeMeta(s, sessionId, (m) => ({ ...m, flags: { ...m.flags, [flag]: value } })),
        past: s.past.map((p) => (p.sessionId === sessionId
          ? { ...p, flags: { ...(p.flags ?? {}), [flag]: value } }
          : p)),
      }));
      subs.meta.forEach((f) => f(sessionId, { flag, value }));
    }),

    setTag: (sessionId, tagId, value) => write(() => {
      store.setState((s) => ({
        ...s,
        meta: mergeMeta(s, sessionId, (m) => ({
          ...m,
          tags: value ? [...new Set([...m.tags, tagId])] : m.tags.filter((t) => t !== tagId),
        })),
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
        meta: mergeMeta(s, sessionId, (m) => ({ ...m, note })),
        past: s.past.map((p) => (p.sessionId === sessionId ? { ...p, note } : p)),
      }));
      subs.meta.forEach((f) => f(sessionId, { note }));
    }),
  };

  const providers: Ns<'providers'> = {
    list: async () => store.getState().providers,
    catalog: async () => store.getState().catalog,
  };

  // M5 2a. NO real backend yet — registered in MOCK_ONLY. Removal matches on
  // (tool, pattern, action) because remember() dedupes exact repeats, so that
  // triple is unique within a project; no rule id is needed.
  const permissions: Ns<'permissions'> = {
    list: async () => store.getState().permissions,
    remove: async (slug, rule) => {
      if (store.refuseWrites) return false;
      let hit = false;
      store.setState((s) => ({
        ...s,
        permissions: s.permissions.map((p) => {
          if (p.slug !== slug) return p;
          const rules = p.rules.filter((r) => {
            const match = r.tool === rule.tool && r.pattern === rule.pattern && r.action === rule.action;
            if (match) hit = true;
            return !match;
          });
          return { ...p, rules };
        }),
      }));
      return hit;
    },
    removeProject: async (slug) => {
      if (store.refuseWrites) return false;
      const hit = store.getState().permissions.some((p) => p.slug === slug);
      store.setState((s) => ({ ...s, permissions: s.permissions.filter((p) => p.slug !== slug) }));
      return hit;
    },
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

  // The attention classifier polls this every second while a turn is in flight
  // and does `raw.split('\n')` (useAttentionClassifier.ts:126,133). The catch-all
  // `[]` has no .split, so the workbench threw once per second — non-fatal, but
  // it buries real errors in the console during a design review, which is the
  // console you are actually reading. An empty STRING is the honest answer:
  // there is no PTY here, so the screen is blank.
  const terminal: Ns<'terminal'> = {
    getScreenText: async () => '',
  };

  // Another routing-shaped gate the `[]` default gets WRONG rather than merely
  // empty: sync-dot-state.ts:38 does `status.spaces.find(...)` behind a
  // `if (!status) return null` guard. `[]` is not null, so it sails past the
  // guard and `[].spaces` is undefined — opening Project View threw
  // "Cannot read properties of undefined (reading 'find')".
  // Shape from sync-spaces/service.ts:420. Sync off is the honest state here:
  // there is no sync engine behind a browser tab.
  const syncSpaces = {
    status: async () => ({
      enabled: false,
      spaces: [] as unknown[],
      recentEvents: [] as unknown[],
      syncHub: 'off',
    }),
  };

  // Project View's Conversations and Context tabs. Conversations reuse the same
  // seeded past sessions the Resume browser shows, filtered by project, so the
  // two surfaces cannot disagree about what exists.
  const project = {
    listConversations: async (projectPath: string) => ({
      ok: true,
      conversations: store.getState().past
        .filter((p) => p.projectPath === projectPath)
        .map((p) => ({ ...p, preview: p.note ?? `Session in ${p.projectSlug}` })),
    }),
    listContext: async (projectPath: string) => ({
      ok: true,
      groups: contextGroups(projectPath),
    }),
    readContextFile: async (_root: string, absolutePath: string) => ({
      ok: true,
      content: ARTIFACT_CONTENT[absolutePath.split('/').pop() ?? ''] ?? `# ${absolutePath}\n`,
    }),
    writeContextFile: async () => ({ ok: true }),
    repoInfo: async () => ({ ok: true, branch: 'master', dirty: false }),
  };

  // Signed OUT is the honest default, and the `[]` catch-all gets it backwards:
  // account.signedIn() returning `[]` is TRUTHY, and account.user() returning
  // `[]` is a truthy object with no `handle` — so HandlePrompt concluded the
  // user had just signed in without a handle and threw a modal over the whole
  // app on every load.
  const account: Ns<'account'> = {
    signedIn: async () => false,
    user: async () => null,
    refresh: async () => null,
  };

  // Settings → Appearance shows FAVOURITED themes plus the active one as a
  // fallback (ThemeScreen.tsx:111-117) — the full list lives behind "Browse all
  // themes". With no favourites the panel renders exactly one card, which reads
  // as "only one theme exists" rather than "you have not starred any". Seeding
  // favourites is what actually puts a choice in front of a reviewer.
  //
  // Held in the store so starring/unstarring in the panel behaves like the real
  // thing instead of snapping back on the next read.
  let favouriteThemes = ['midnight', 'dark', 'creme', 'halftone-dimension', 'meadow-mist'];
  const appearance = {
    getFavoriteThemes: async () => [...favouriteThemes],
    favoriteTheme: async (slug: string, favorited: boolean) => {
      favouriteThemes = favorited
        ? [...new Set([...favouriteThemes, slug])]
        : favouriteThemes.filter((s) => s !== slug);
      return [...favouriteThemes];
    },
    // Appearance prefs live in localStorage in the workbench (ThemeProvider
    // already persists there), so the IPC mirror is a no-op rather than a
    // second source of truth that could disagree with it.
    get: async () => null,
    set: async () => true,
    broadcast: () => {},
  };

  // Project View and the artifact panel. Without these both render as empty
  // shells — the catch-all's `[]` is not `{ ok, projects }`, so every consumer
  // bails on the `res?.ok` guard and shows nothing. An empty surface is not a
  // reviewable mockup, which is the whole point of the workbench.
  const artifacts = {
    listProjectsIndex: async (opts?: { withCounts?: boolean }) => ({
      ok: true,
      projects: opts?.withCounts ? projectsWithCounts() : artifactProjects(),
    }),
    listSession: async (sessionId: string) => ({
      ok: true, artifacts: sessionArtifacts(sessionId),
    }),
    listProject: async (projectId: string) => ({
      ok: true, artifacts: allFiles(projectId),
    }),
    listAllFiles: async (projectId: string) => ({
      ok: true, files: allFiles(projectId), truncated: false,
    }),
    get: async (_projectRoot: string, artifactId: string, opts?: { full?: boolean }) => {
      const content = ARTIFACT_CONTENT[artifactId];
      const asBinary = BINARY_FIXTURES[artifactId];
      if (asBinary !== undefined) {
        return { ok: true, content: null, orphan: false, binary: true,
                 truncated: false, sizeBytes: asBinary, mtimeMs: 1 };
      }
      if (content === undefined) {
        // Honest miss rather than a fabricated body: the reader renders its
        // own missing-file state, which is a state worth being able to see.
        // orphan:true matches the real handler's not-found shape — without it
        // the tri-state read lifecycle would classify this as a resolved read
        // with no content (blank pane) instead of "no longer on disk".
        return { ok: true, content: null, orphan: true, binary: false, sizeBytes: 0 };
      }
      // Over-cap fixtures: report a pretend on-disk size far larger than the
      // body we serve, so the partial-view banner and the handoff states are
      // reachable in the Workbench without a real 8 MB file (spec §5).
      // `full` opts into a BIGGER read, not an unbounded one — main refuses it
      // above FULL_READ_MAX_BYTES, so the mock has to refuse it too or the
      // Workbench would show a state the real backend can never produce.
      const fake = OVERSIZE_FIXTURES[artifactId];
      const grantFull = opts?.full === true && fake !== undefined && fake <= FULL_READ_MAX_BYTES;
      if (fake !== undefined && !grantFull) {
        return {
          ok: true, content: content.slice(0, content.lastIndexOf('\n', 400) + 1), orphan: false, binary: false,
          truncated: true, sizeBytes: fake, mtimeMs: 1,
        };
      }
      return {
        ok: true, content, orphan: false, binary: false, truncated: false,
        sizeBytes: fake ?? content.length, mtimeMs: 1,
      };
    },
    // Nothing is missing from disk here — every fixture "exists" by construction.
    checkExistence: async () => ({ ok: true, missingIds: [] as string[] }),
    // Image bytes for ArtifactThumbnail / ImageView. Real handler shape
    // (read-binary-access.ts): { ok, base64, mime } or { ok:false, reason }.
    // Every image path gets the same sample PNG — the workbench reviews the
    // CARD, not the picture. Non-images get an honest refusal so the glyph
    // fallback stays reviewable.
    readBinary: async (absolutePath: string) => {
      const ext = absolutePath.split('.').pop()?.toLowerCase() ?? '';
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].includes(ext)) {
        return { ok: true, base64: SAMPLE_PNG_BASE64, mime: 'image/png' };
      }
      return { ok: false, reason: 'not-an-image' };
    },
    searchContent: async (_root: string, query: string) => ({
      ok: true,
      matches: Object.entries(ARTIFACT_CONTENT)
        .filter(([, body]) => body.toLowerCase().includes(query.toLowerCase()))
        .map(([id]) => ({ artifactId: id })),
    }),
    watchProject: async () => ({ ok: true }),
    unwatchProject: async () => ({ ok: true }),
  };

  // MUST be hand-written, and this is the sharpest example of why the []
  // catch-all default is a compromise rather than a solution: App.tsx:458 does
  // `resolve(!!(state && state.currentStep !== 'COMPLETE'))`. A stubbed `[]` is
  // truthy and `[].currentStep` is undefined, so the app concluded it WAS a
  // first run and routed to the onboarding wizard — which then crashed on
  // `prerequisites.some(...)`. Any channel that gates app-level routing has to
  // return a real shape; the catch-all can only ever be right about SHAPE, not
  // MEANING. Shape from shared/first-run-types.ts.
  // `?firstRun=<STEP>` renders the onboarding wizard at that step (e.g.
  // DETECT_PREREQUISITES, INSTALL_PREREQUISITES, ENABLE_DEVELOPER_MODE,
  // AUTHENTICATE, LAUNCH_WIZARD). WHY: the wizard is the first thing a new user
  // sees and, until 2026-08-25, the only surface no review rig could reach —
  // the mock always answered COMPLETE, so App routed straight past it.
  const firstRunStep = (typeof location !== 'undefined' && new URLSearchParams(location.search).get('firstRun')) || 'COMPLETE';
  const firstRun = {
    getState: async () => ({
      currentStep: firstRunStep,
      prerequisites: [],
      overallProgress: 100,
      statusMessage: '',
      authMode: 'none',
      authComplete: true,
      needsDevMode: false,
    }),
  };

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
  // `?marketplace=empty` keeps the registry-less state reachable (the Marketplace
  // and Library empty states are real surfaces too); default is the sampled
  // registry in fixtures/marketplace/registry.ts.
  const marketplaceEmpty = typeof location !== 'undefined'
    && new URLSearchParams(location.search).get('marketplace') === 'empty';
  const theme = {
    list: async () => Object.keys(THEME_FIXTURES),
    readFile: async (slug: string) => THEME_FIXTURES[slug] ?? '{}',
    // Writes never touch disk. Editing a fixture + Vite HMR is the reload path.
    writeFile: async () => ({ ok: true }),
    onReload: (_cb: (slug: string) => void) => () => {},
    // Registry themes with their installed flag — what the Marketplace's Themes
    // tab, Library › Themes and the theme-favourites strip read.
    // A plain nested object: withCatchAll wraps object-valued members itself, so
    // `theme.marketplace.detail` (unimplemented) still resolves `[]` instead of
    // throwing synchronously inside marketplace-context's Promise.all.
    marketplace: {
      list: async () => (marketplaceEmpty ? [] : MARKETPLACE_THEMES.map((t) => ({ ...t }))),
    },
  };

  // WHY these four and not the whole `skills` namespace: marketplace-context's
  // fetchAll (state/marketplace-context.tsx) awaits exactly listMarketplace,
  // list, getFavorites and getFeatured (+ marketplace.getPackages + the theme
  // list above); every other skills channel keeps the catch-all `[]`. Before
  // 2026-08-25 all of these answered `[]`, so Marketplace/Library/skills drawer
  // rendered empty in the workbench and were unreviewable in any theme.
  let skillFavourites: string[] = ['civic-report', 'superpowers'];
  const skills = {
    listMarketplace: async () => (marketplaceEmpty ? [] : MARKETPLACE_PLUGINS.map((p) => ({ ...p }))),
    list: async () => (marketplaceEmpty ? [] : INSTALLED_SKILLS.map((s) => ({ ...s }))),
    getFavorites: async () => [...skillFavourites],
    setFavorite: async (id: string, favorited: boolean) => {
      skillFavourites = favorited
        ? [...new Set([...skillFavourites, id])]
        : skillFavourites.filter((x) => x !== id);
      return [...skillFavourites];
    },
    getFeatured: async () => (marketplaceEmpty ? { hero: [], rails: [] } : JSON.parse(JSON.stringify(FEATURED))),
  };
  const marketplace = {
    getPackages: async () => (marketplaceEmpty ? {} : JSON.parse(JSON.stringify(INSTALLED_PACKAGES))),
  };

  return {
    session, providers, permissions, models, defaults, native, detach, tags, on, theme, firstRun,
    terminal, artifacts, syncSpaces, project, account, appearance, skills, marketplace,
  } as unknown as Record<string, Record<string, unknown>>;
}
