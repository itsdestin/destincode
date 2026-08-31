import { MARKETPLACE_API_HOST } from '../../state/marketplace-api-client';
import type { MockStore } from './mock-store';
import type { MarketplaceUser } from '../../../main/marketplace-auth-store';
import type { InstalledLocalModel, DownloadProgress } from '../../../shared/model-manager-types';
import type { DelegatedModelsView } from '../../../shared/types';
import { RUNS } from './specialist-runs';
import { FULL_READ_MAX_BYTES } from '../../../shared/artifacts/editable-path-policy';
import { previewKind } from '../../../shared/artifacts/categorization';
import { READ_HEAD_DEFAULT_BYTES, READ_HEAD_MAX_BYTES } from '../../../shared/read-head';
import { buildHydratePayload } from './seed-chat';
import {
  projects as artifactProjects, projectsWithCounts, sessionArtifacts, allFiles,
  CONTENT as ARTIFACT_CONTENT, SAMPLE_PNG_BASE64, SAMPLE_SVG, makeDetailPngBase64, makeSamplePdfBase64, contextGroups,
} from './fixtures/artifacts';
import { resolveFixture, CS_ERR_READ } from './fixtures/chatsearch';
import type { MockState, MockSessionMeta } from './scenarios';
import { specialistRoster, delegatedModels as seedDelegatedModels } from './fixtures/specialists';
import { MARKETPLACE_PLUGINS, MARKETPLACE_THEMES, INSTALLED_SKILLS, INSTALLED_PACKAGES, FEATURED } from './fixtures/marketplace/registry';
// Scripted replies (site scenario / phase-2 play-through): a typed message
// gets a fixture-driven answer instead of being swallowed by the catch-all.
import { playReply, resolvePermission, parseReplyScript, isControl, splitTurns } from './reply-script';
// Task 7c: Connect Four's friends/presence layer (window.claude.social) — see
// fake-party.ts for why this exists and what it stands in for.
import { JAKE_ID, JAKE_USERNAME } from './fake-party';
import { arcadeStatusFor, arcadeBoardFor, arcadeRecordsFor, arcadeVersusIsDown, type ArcadeScenario } from './arcade-fixtures';
import { buildCatalog } from './fixtures/marketplace/catalog';

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

// Canned file heads for the mock fs.readHead (attachment cards). The markdown
// one deliberately opens with a `##` heading plus bold and a list: the whole
// point of the preview is that those render as markup, not as literal text.
const WORKBENCH_MARKDOWN_HEAD = [
  '## Design notes',
  '',
  'Composer chips become **cards** with a real preview.',
  '',
  '- image → thumbnail',
  '- markdown → rendered',
  '- text → mono block',
].join('\n');
const WORKBENCH_TEXT_HEADS: Record<string, string> = {
  txt: 'Call Sam about the venue\nOrder 40 chairs\nConfirm catering by Fri\nPrint name tags',
  json: '{\n  "name": "youcoded",\n  "version": "1.3.0",\n  "private": true\n}',
  csv: 'item,qty,cost\nchairs,40,320\ntables,8,560\ncatering,1,1400',
  ts: 'interface Attachment {\n  path: string;\n  name: string;\n}',
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
  'session.sendInput', 'session.respondToPermission', 'on.transcriptEvent', 'on.hookEvent',
  'native.send', 'native.setBinding',
  'providers.list', 'providers.catalog', 'models.memoryCheck',
  // Local Models rows + Resume (2026-08-26). WHY these must be listed: the
  // contract test only checks members named here, so a hand-written mock left
  // off this list escapes the real-or-registered check entirely.
  'models.installed', 'models.curated', 'models.delete', 'models.resume',
  'models.onDownloadProgress', 'models.downloadCancel',
  // Engine card (site row8 loop) — real backend (engine-handlers); hand-written so the
  // card has a version and backend to print instead of "undefined". detectEndpoints: the
  // panel calls it at mount.
  'models.detectEndpoints',
  'engine.status', 'engine.models', 'engine.install', 'engine.restart', 'engine.setContext',
  'engine.onInstallProgress', 'engine.onStatusChanged', 'engine.onModelsChanged',
  // No backend yet (M5 2a) — registered in mock-only.ts. Listed here so the
  // contract test actually covers them; a channel absent from HAND_WRITTEN
  // escapes the real-or-registered check entirely.
  'permissions.list', 'permissions.remove', 'permissions.removeProject',
  // G-1 — real backend as of 2026-08-28; hand-written so the gallery's Bash
  // cards keep their fixture state instead of talking to a real process.
  'native.killShell', 'on.shellEvent',
  'fs.readHead',
  // Specialists 1c — real backend as of Task 8 (see the contract test's
  // remote-shim/preload scan); still hand-written here so the workbench has
  // fixture data to serve instead of a real filesystem/ledger.
  'specialists.list', 'specialists.getDelegatedModels', 'specialists.setDelegatedModel',
  'specialists.steer', 'specialists.interrupt', 'on.specialistEvent',
  'shell.openPath',
  // Chatsearch session references — real backend too, same reason for the fake:
  // the tool gallery needs an index that shows every row state on demand.
  'chatsearch.resolve', 'chatsearch.read',
  'defaults.get', 'defaults.set', 'detach.openDetached',
  'tags.list', 'tags.create', 'tags.update', 'tags.delete',
  'on.sessionCreated', 'on.sessionDestroyed', 'on.sessionRenamed',
  'on.sessionMetaChanged',
  'theme.list', 'theme.readFile', 'theme.writeFile', 'theme.onReload',
  'firstRun.getState', 'terminal.getScreenText',
  'artifacts.listProjectsIndex', 'artifacts.listSession', 'artifacts.listProject',
  'artifacts.listAllFiles', 'artifacts.get', 'artifacts.checkExistence',
  'artifacts.searchContent', 'artifacts.watchProject', 'artifacts.unwatchProject',
  'artifacts.readBinary', 'artifacts.save',
  'syncSpaces.status', 'syncSpaces.syncNow', 'syncSpaces.stopProject',
  'syncSpaces.renameProject', 'syncSpaces.setProjectDescription',
  'folders.rename', 'folders.setDescription',
  'project.listConversations', 'project.listContext', 'project.readContextFile',
  'project.writeContextFile', 'project.repoInfo',
  'account.signedIn', 'account.user', 'account.refresh',
  // Games arcade Step 1 — NO real backend yet; both are declared in
  // mock-only.ts so the contract test knows they are deliberately unbuilt
  // rather than a fake quietly standing in for something real.
  'arcade.status', 'arcade.leaderboard', 'arcade.submitScore',
  // Multiplayer games (Task 7c) — friends graph + presence socket. Real
  // backend (social-handlers.ts / preload.ts), hand-written here so Connect
  // Four has a scripted friend ("Jake") instead of sitting on "Connecting…"
  // forever (see fake-party.ts).
  'social.lookupHandle', 'social.sendRequest', 'social.listRequests',
  'social.acceptRequest', 'social.declineRequest', 'social.cancelRequest',
  'social.listFriends', 'social.unfriend', 'social.block', 'social.unblock',
  'social.listBlocks', 'social.presenceConnect', 'social.presenceDisconnect',
  'social.presenceSend', 'social.onPresenceEvent',
  // Multi-window leader election (Task 7c fix) — see the WHY comment at
  // WORKBENCH_WINDOW_ID. Without these, `isLeader` in App.tsx is false in
  // EVERY workbench session, and presence (Connect Four's lobby, and any
  // future feature gated on isLeader) never connects.
  'window.getId', 'detach.getDirectory',
  'appearance.getFavoriteThemes', 'appearance.favoriteTheme', 'appearance.get',
  'appearance.set', 'appearance.broadcast', 'appearance.onSync',
  'skills.listMarketplace', 'skills.list', 'skills.getFavorites', 'skills.setFavorite', 'skills.getFeatured',
  'marketplace.getPackages', 'theme.marketplace',
  // Real, but served by remote-shim.ts rather than preload.ts — Electron
  // clients get their timelines from the transcript watcher instead. The
  // contract test checks both files for exactly this reason.
  'on.chatHydrate',
  // Task 9 (status-bar relevance review): the CC scenario needs the 5h/7d
  // usage chips and the statusline-sourced cost/token/line-change numbers,
  // both of which ride status:data — previously unwired here, so they sat at
  // their empty defaults forever regardless of scenario. Fast mode's chip
  // needs `modes.get` for the same reason. Both are real preload channels
  // (main/preload.ts), not unbuilt features, so they belong here and not in
  // mock-only.ts.
  'on.statusData', 'modes.get', 'modes.set',
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

// Reply fixtures for scripted replies (`?reply=<name>`, defaults to `demo`) —
// eager + `?raw` so the shim can pick a script at sendInput() time without an
// async fetch (matches the theme-manifest loading pattern just above).
// @ts-ignore TS1343 — Vite rewrites import.meta.glob statically at build time.
const REPLY_SCRIPTS = import.meta.glob('./fixtures/replies/*.jsonl', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
function replyScriptName(): string {
  if (typeof location === 'undefined') return 'demo';
  return new URLSearchParams(location.search).get('reply') ?? 'demo';
}

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

// Task 9 (status-bar relevance review): 'statusbar-cc' is the ONLY scenario
// that needs a status:data fixture — it is the CC session, and CC's chips
// (5h/7d usage, cost/tokens/lines) read the statusline mock below instead of
// SessionTotals. Every other scenario (the 4 native ones, and everything that
// existed before this task) gets `null`, so `on.statusData`'s cb is simply
// never called for them — the exact same "nothing ever arrives" behavior the
// workbench had before this channel was wired at all. That keeps this change
// from touching any sheet outside the status-bar plan.
//
// Numbers here are the brief's linesAdded/linesRemoved/costUsd verbatim; the
// rest (tokens, cache, duration, usage %) are plausible fixture data made up
// for this dev-only mock, internally consistent (cacheReadTokens < inputTokens).
function statusBarFixtureFor(scenario: string): { usage: unknown; sessionStatsMap: Record<string, unknown> } | null {
  if (scenario !== 'statusbar-cc') return null;
  return {
    usage: {
      five_hour: { utilization: 42, resets_at: new Date(Date.now() + 3 * 3_600_000).toISOString() },
      seven_day: { utilization: 61, resets_at: new Date(Date.now() + 4 * 86_400_000).toISOString() },
    },
    sessionStatsMap: {
      'wb-1': {
        costUsd: 0.42,
        inputTokens: 48_000,
        outputTokens: 6_200,
        cacheReadTokens: 39_000,
        cacheCreationTokens: 1_200,
        contextTokens: 61_000,
        duration: 2_280,
        apiDuration: 340,
        linesAdded: 120,
        linesRemoved: 34,
      },
    },
  };
}

/** Hand-written channel implementations, backed by the store. */
function handWritten(store: MockStore): Record<string, Record<string, unknown>> {
  // `location` is guarded the same way latencyFromQuery() above guards it —
  // this module has no node-test importer today, but the pattern is load-
  // bearing everywhere else in the workbench and cheap to keep consistent.
  const activeScenario = typeof location === 'undefined'
    ? 'default'
    : new URLSearchParams(location.search).get('scenario') ?? 'default';

  // `?arcade=<state>` overrides the mapping. WHY it needs its own switch: the
  // app's `empty` scenario has NO SESSIONS, so the header — and with it the
  // games button — never renders, making the brand-new-arcade state
  // unreachable through the app scenario alone (measured: the capture missed
  // in all six themes with MISSING "[title='Games']").
  const arcadeOverride = typeof location === 'undefined'
    ? null
    : new URLSearchParams(location.search).get('arcade');
  const arcadeScenario: ArcadeScenario =
    (arcadeOverride === 'empty' || arcadeOverride === 'alone'
      || arcadeOverride === 'degraded' || arcadeOverride === 'default')
      ? arcadeOverride
      : activeScenario === 'empty' ? 'empty'
      : activeScenario === 'stress' ? 'alone'
      : activeScenario === 'refused' ? 'degraded'
      : 'default';

  // Subscriber sets, one per real event the renderer listens for. These are the
  // channels the UI actually re-fetches on — see the WHY on the emits below.
  const subs = {
    created: new Set<(s: any) => void>(),
    destroyed: new Set<(id: string) => void>(),
    renamed: new Set<(id: string, name: string) => void>(),
    meta: new Set<(id: string, meta: any) => void>(),
    // Scripted replies: transcript/hook subscribers a played reply emits into.
    transcript: new Set<(e: any) => void>(),
    hook: new Set<(e: any) => void>(),
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

  // Site mode / phase-2 play-through: a typed message gets a scripted answer
  // (`?reply=<name>`, fixtures/replies/). Shared by BOTH send channels —
  // `session.sendInput` (Claude/PTY sessions) and `native.send` (native
  // sessions, e.g. the `site` scenario's embed session) — because App picks
  // the channel by `session.provider`, not by anything the reply machinery
  // cares about; duplicating the lookup+play body per channel would just be
  // two copies to keep in sync.
  // A fixture may hold SEVERAL turns (one `turn_complete` each): the Nth
  // message sent in a session plays the Nth turn, wrapping around at the end.
  // The site's row-1 loop is a three-message skit (Claude declines, the model
  // is switched, Grok answers, the user reacts) — replaying one fixed answer
  // to every message could not film it. One-turn fixtures behave as before.
  const replyCursor = new Map<string, number>();
  const startReply = (sessionId: string, text: string) => {
    const raw = REPLY_SCRIPTS[`./fixtures/replies/${replyScriptName()}.jsonl`];
    if (!raw) { console.warn(`[workbench] no reply script "${replyScriptName()}"`); return; }
    const turns = splitTurns(parseReplyScript(raw));
    if (turns.length === 0) return;
    const n = replyCursor.get(sessionId) ?? 0;
    // Control bytes (\r, ESC) must not advance the cursor — playReply ignores them
    // (same predicate, so the two can't drift). Note `?autoplay=` spends turn 1
    // through this path too: the first message TYPED into an autoplayed window
    // plays turn 2 — intended for the sync row's phone half.
    if (!isControl(text)) replyCursor.set(sessionId, n + 1);
    void playReply(sessionId, text, turns[n % turns.length], {
      transcript: (e) => subs.transcript.forEach((f) => f(e)),
      hook: (e) => subs.hook.forEach((f) => f(e)),
    });
  };

  // `?autoplay=<ms>`: play the fixture's first turn into the first seeded session
  // with nothing typed — a message "arriving" (sync row, phone half). The fixture
  // supplies the user bubble via a user_message line.
  if (typeof location !== 'undefined') {
    const ms = Number(new URLSearchParams(location.search).get('autoplay'));
    if (ms > 0) setTimeout(() => { const id = store.getState().sessions[0]?.id; if (id) startReply(id, '(autoplay)'); }, ms);
  }

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

    // Claude/PTY sessions only (native sessions use `native.send` below).
    // Control bytes are ignored inside playReply so the PTY-shaped calls App
    // makes for Claude Code sessions ('\r', '\x1b') never start a script.
    sendInput: (sessionId: string, text: string) => startReply(sessionId, text),
    // Real signature is Promise<boolean> (useIpc.ts/preload.ts), not {ok} —
    // resolvePermission already returns a boolean (false = stale/unknown id).
    respondToPermission: async (requestId: string, _decision: object) => resolvePermission(requestId),

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

  // One fixture per row state, so a design review sees all three at once.
  // Byte counts are Destin's real 2026-08-26 interruption — a four-file split
  // GGUF stranded at part 3 — so the sheets show realistic numbers rather than
  // round ones that hide formatting bugs. NOTE the app's gb() divides by 1024^3:
  // 79_674_559_677 renders as 74.2 GB, 121_334_654_784 as 113.0 GB.
  const LOCAL_MODELS: InstalledLocalModel[] = [
    {
      id: 'Qwen3.5-9B-Q8_0',
      sizeBytes: 9_527_502_048,
      quant: 'Q8_0', quantDescription: 'Highest quality quantization — near-original output',
      parts: 1, status: 'complete', partsPresent: 1,
      totalSizeBytes: null, repo: null,
    },
    {
      id: 'Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004',
      sizeBytes: 79_674_559_677,
      quant: 'UD-Q4_K_XL', quantDescription: 'Balanced quality and size — recommended',
      parts: 4, status: 'unfinished', partsPresent: 2,
      totalSizeBytes: 121_334_654_784, repo: 'unsloth/Qwen3.8-Flash-Next-GGUF',
    },
    {
      id: 'Older-Model-UD-Q4_K_XL-00001-of-00002',
      sizeBytes: 4_100_000_000,
      quant: 'UD-Q4_K_XL', quantDescription: 'Balanced quality and size — recommended',
      parts: 2, status: 'untraceable', partsPresent: 1,
      totalSizeBytes: null, repo: null,
    },
  ];

  // A fake progress stream so the MID-RESUME state (spec §4) can be photographed:
  // Resume emits a 'downloading' event at ~70% and then creeps, never finishing.
  const progressListeners = new Set<(p: DownloadProgress) => void>();
  const emitProgress = (p: DownloadProgress) => { for (const cb of progressListeners) cb(p); };
  let fakeTimer: ReturnType<typeof setInterval> | null = null;
  let lastReceived = 0;

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

    installed: async () => LOCAL_MODELS,
    curated: async () => [],
    delete: async () => true,
    onDownloadProgress: (cb: (p: DownloadProgress) => void) => {
      progressListeners.add(cb);
      return () => { progressListeners.delete(cb); };
    },
    resume: async (modelId: string) => {
      const m = LOCAL_MODELS.find((x) => x.id === modelId);
      if (!m || m.status !== 'unfinished' || !m.repo) throw new Error('Nothing to resume.');
      let received = 85_000_000_000;
      const base = {
        downloadId: 'wb-resume-1', repo: m.repo, quant: m.quant ?? '',
        totalBytes: m.totalSizeBytes ?? 0, parts: m.parts, currentPart: 3,
      };
      if (fakeTimer) clearInterval(fakeTimer);
      lastReceived = received;
      setTimeout(() => emitProgress({ ...base, state: 'downloading', receivedBytes: received }), 300);
      fakeTimer = setInterval(() => {
        received += 1_000_000_000;
        lastReceived = received;
        emitProgress({ ...base, state: 'downloading', receivedBytes: received });
      }, 400);
      return { downloadId: base.downloadId };
    },
    downloadCancel: async (downloadId: string) => {
      if (fakeTimer) { clearInterval(fakeTimer); fakeTimer = null; }
      const m = LOCAL_MODELS[1];
      // Pausing banks the bytes fetched so far — the real models:installed
      // re-reads the directory, so the row must come back at where it STOPPED,
      // not at where it started. Without this the demo pauses at 73% and the
      // row snaps back to 66%, which is the opposite of what resume promises.
      m.sizeBytes = Math.max(m.sizeBytes, lastReceived);
      emitProgress({
        downloadId, repo: m.repo ?? '', quant: m.quant ?? '', state: 'cancelled',
        receivedBytes: m.sizeBytes, totalBytes: m.totalSizeBytes ?? 0, parts: m.parts, currentPart: 3,
      });
      return true;
    },
    detectEndpoints: async () => [],
  };

  // The local llama.cpp engine card (EngineCard.tsx). Without a hand-written
  // status the catch-all's truthy `[]` reached the card with no fields, and it
  // rendered "Installed undefined · undefined" — which the landing-page loop
  // for the builders row (row8) filmed verbatim on 2026-08-27. Shape:
  // shared/engine-types.ts EngineStatus.
  const engine: Ns<'engine'> = {
    status: async () => ({
      installed: true, installedVersion: 'b9986', pinnedVersion: 'b9986', backend: 'vulkan' as const,
      state: 'stopped' as const, cacheDir: '/home/you/.youcoded/models', contextSize: 32768, port: 8080,
    }),
    models: async () => [],
    install: async () => undefined,
    restart: async () => undefined,
    setContext: async () => undefined,
    onInstallProgress: () => () => {},
    onStatusChanged: () => () => {},
    onModelsChanged: () => () => {},
  };

  const defaults: Ns<'defaults'> = {
    get: async () => store.getState().defaults,
    set: (updates) => write(() => {
      store.setState((s) => ({ ...s, defaults: { ...s.defaults, ...updates } }));
    }),
  };

  const native: Ns<'native'> = {
    supported: true,
    // Native sessions (no PTY) send through THIS channel, not
    // `session.sendInput` — see native-send.ts / pty-input-gate.ts's
    // `canPtySend`, which refuses provider:'native' outright. The `site`
    // scenario's embed session is native, so without this the landing-page
    // demo's composer looked broken (message accepted, nothing ever answers).
    // Shares startReply with session.sendInput — see that helper's WHY.
    send: async (sessionId: string, text: string, _attachments?: string[]) => {
      if (store.refuseWrites) return { status: 'failed', reason: 'not-live' };
      startReply(sessionId, text);
      return { status: 'sent' };
    },
    // Model picker (ModelPickerPopup.tsx:304). Real backend rebinds the
    // provider/model on the live session; here it updates the row the status
    // bar and picker read from, so the chip changes on screen. No `subs.*`
    // emit needed — App.tsx:3378 updates its `sessions` state directly from
    // the popup's onNativeModelChanged callback rather than re-listening or
    // re-fetching session.list().
    setBinding: async (sessionId, b) => {
      if (store.refuseWrites) return false;
      store.setState((s) => ({
        ...s,
        sessions: s.sessions.map((x: any) => x.id === sessionId ? { ...x, model: b.modelId, providerId: b.providerId } : x),
      }));
      return true;
    },
    // G-1: the card's Stop just resolves — the gallery fixture stays in its
    // captured state rather than spawning anything real.
    killShell: async (_sessionId: string, _shellId: string) => ({ ok: true }),
  };

  // Fix (final review): SpecialistsSection's "Open folder" button reads
  // shell.openPath's resolved value as an error message whenever it's truthy —
  // correct against the real Electron API, which resolves '' on success and an
  // error string on failure (see that component's own comment). With no `shell`
  // entry here at all, the call used to fall through to the catch-all proxy,
  // which resolves every unknown member to `[]` — and `[]` is truthy, so
  // clicking "Open folder" in the workbench always showed an error box with no
  // text. openPath has nothing to do in a browser tab (there is no OS file
  // manager to hand off to), so '' — the real success value — is the honest
  // stand-in. Other shell.* members called from renderer code (openExternal,
  // openChangelog, showItemInFolder) discard their return value at every call
  // site, so the same truthy-[] bug never surfaces for them; left on the
  // catch-all rather than hand-written for no behavioural gain.
  const shell: Ns<'shell'> = {
    openPath: async () => '',
  };

  // Specialists 1c — roster, model tiers, and the two card actions. Real
  // backend as of Task 8; this is fixture data standing in for a filesystem
  // read + ledger. Tier writes go through `write` so the refused scenario
  // exercises the picker's revert path.
  let tiers = seedDelegatedModels();
  const specialistSubs = new Set<(e: any) => void>();
  const shellSubs = new Set<(e: any) => void>();   // G-1: background command run records
  const specialists = {
    // Task 10: real shape is { definitions, skipped, folders } — the roster
    // hook keys its cache on cwd and the definedBy() provenance line needs
    // `folders.project` to tell a project's own .claude/agents apart from
    // the user's. `skipped` stays empty — none of the seeded fixture rows
    // collide, so there is nothing to demonstrate here yet.
    list: async (opts?: { cwd?: string; ensurePersonalFolder?: boolean }) => ({
      definitions: specialistRoster(),
      skipped: [],
      folders: {
        personal: '/home/destin/.youcoded/specialists',
        claudeUser: '/home/destin/.claude/agents',
        project: opts?.cwd ? `${opts.cwd}/.claude/agents` : undefined,
      },
    }),
    getDelegatedModels: async () => tiers,
    setDelegatedModel: (tier: 'budget' | 'frontier', binding: DelegatedModelsView['budget']) =>
      write(() => {
        // The real backend derives the display label from its catalog; the
        // mock does the same from the seeded one so the row never shows an id.
        const label = binding ? (store.getState().catalog.find(c => c.id === binding.modelId)?.label ?? binding.modelId) : '';
        tiers = { ...tiers, [tier]: binding ? { ...binding, label } : null };
      }),
    // Task 10: notes now ride on the run record (no separate 'note' event
    // kind) — append to the run's `notes` and re-emit the WHOLE run, same
    // shape `interrupt` below already used. The reducer derives the
    // Activity-trail row from `run.notes` itself.
    steer: async (sessionId: string, childId: string, text: string) => {
      const run = RUNS.get(childId);
      if (run) {
        const notes = [...(run.notes ?? []), { text, from: 'user' as const, at: Date.now() }];
        const next = { ...run, notes };
        RUNS.set(childId, next);
        for (const cb of specialistSubs) cb({ kind: 'run', sessionId, run: next });
      }
      return { ok: true };
    },
    interrupt: async (sessionId: string, childId: string) => {
      const run = RUNS.get(childId);
      if (run) {
        const next = { ...run, status: 'interrupted' as const, endedAt: Date.now() };
        RUNS.set(childId, next);
        for (const cb of specialistSubs) cb({ kind: 'run', sessionId, run: next });
      }
      return { ok: true };
    },
  };


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
  //
  // MOCKUP (2026-08-05 project-description design): sync is ENABLED here, with
  // one space per dot state, because the design moves the sync readout into a
  // pill and the only way to judge that is to see every state it must hold —
  // including the two long gray sentences and the red error message, which are
  // the strings a pill is least able to survive. `enabled: false` short-circuits
  // syncDotFor to the same gray for everything (sync-dot-state.ts:62), which
  // would have shown one state and hidden the hard three.
  const descriptions: Record<string, string | null> = {};
  const descriptionFor = (path: string, seeded?: string | null) =>
    path in descriptions ? descriptions[path] : (seeded ?? null);

  const SYNC_NOW = Date.now();
  const syncSpaces = {
    status: async () => ({
      enabled: true,
      spaces: [
        {
          id: 'project:youcoded', root: '/home/destin/youcoded-dev/youcoded',
          displayName: 'youcoded', state: 'active' as const, kind: 'project' as const,
          remote: 'https://github.com/itsdestin/youcoded.git', lastSyncAt: SYNC_NOW - 120_000,
          description: descriptionFor('/home/destin/youcoded-dev/youcoded', artifactProjects()[0].description),
        },
        {
          id: 'project:wecoded-themes', root: '/home/destin/youcoded-dev/wecoded-themes',
          displayName: 'wecoded-themes', state: 'active' as const, kind: 'project' as const,
          remote: 'https://github.com/itsdestin/wecoded-themes.git', lastSyncAt: SYNC_NOW - 3_600_000,
          description: descriptionFor('/home/destin/youcoded-dev/wecoded-themes', artifactProjects()[1].description),
        },
        {
          id: 'project:recipes', root: '/home/destin/recipes',
          displayName: 'recipes', state: 'stopped' as const, kind: 'project' as const,
          remote: 'https://github.com/itsdestin/recipes.git', lastSyncAt: SYNC_NOW - 86_400_000,
          description: descriptionFor('/home/destin/recipes', artifactProjects()[3].description),
        },
        // Personal is what deriveSyncBoxState gates green on — without it the
        // Sync panel header reads 'setup' forever.
        {
          id: 'personal', root: '/home/destin/YouCoded/Personal',
          state: 'active' as const, kind: 'personal' as const,
          remote: 'https://github.com/itsdestin/youcoded-personal.git', lastSyncAt: SYNC_NOW - 60_000,
        },
        // wecoded-marketplace is deliberately ABSENT — no space means the gray
        // "Only on this computer" state, i.e. the unsynced-folder branch.
      ],
      recentEvents: [
        { type: 'synced', spaceId: 'personal', at: SYNC_NOW - 60_000 },
        { type: 'synced', spaceId: 'project:youcoded', at: SYNC_NOW - 120_000 },
        {
          type: 'error', spaceId: 'project:wecoded-themes', at: SYNC_NOW - 90_000,
          message: 'GitHub rejected the push: remote contains work you do not have locally.',
        },
      ],
      syncHub: 'connected',
    }),
    // MOCK_ONLY — no backend yet. The real one becomes setProjectDescription in
    // sync-spaces/service.ts, writing the synced project registry.
    setProjectDescription: async (folderName: string, description: string) => {
      const root = folderName === 'recipes' ? '/home/destin/recipes' : `/home/destin/youcoded-dev/${folderName}`;
      descriptions[root] = description.trim() || null;
      return { ok: true };
    },
    syncNow: async () => ({ ok: true }),
    stopProject: async () => ({ ok: true }),
    renameProject: async () => ({ ok: true }),
  };

  // MOCK_ONLY — the LOCAL-folder half of the same field, mirroring how
  // folders.rename already writes the nickname that becomes the display name.
  const folders = {
    rename: async () => ({ ok: true }),
    setDescription: async (path: string, description: string) => {
      descriptions[path] = description.trim() || null;
      return { ok: true };
    },
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

  // Session references (spec 2026-08-10): the fake IPC pair backing the
  // Preview/Resume cards, both MOCK_ONLY (mock-only.ts) since no real backend
  // exists yet. resolve() reuses the SAME fixture table the tool-gallery and
  // scenario fixtures reference by uuid, so a card built here shows exactly
  // the state its short id was chosen to demonstrate. read() fabricates a
  // fake transcript tail rather than reading anything real; CS_ERR_READ is
  // the one id wired to fail, so the "transcript unreadable" card state has
  // something to point at.
  const chatsearch = {
    resolve: async (shortIds: string[]) => ({ ok: true as const, results: shortIds.map(resolveFixture) }),
    read: async (req: { provider: string; id: string; tail: number; before?: number }) => {
      if (req.id === CS_ERR_READ) return { ok: false as const, error: "EACCES: permission denied, open '/home/destin/YouCoded/Personal/Conversations/claude/transcripts/youcoded/ee0011aa.jsonl'" };
      // 60 fake messages; every 4th assistant message follows a "tool gap".
      const total = 60;
      const end = Math.min(req.before ?? total, total);
      const start = Math.max(0, end - Math.min(req.tail, 200));
      const messages = [];
      for (let seq = start; seq < end; seq++) {
        const assistant = seq % 2 === 1;
        messages.push({
          role: assistant ? 'assistant' : 'user',
          content: assistant
            ? `Here is what I found for step ${seq}:\n\n\`\`\`ts\nconst x = ${seq};\n\`\`\`\n\n- one\n- two`
            : `User question number ${seq}`,
          timestamp: Date.now() - (total - seq) * 60_000,
          seq,
          droppedToolCalls: assistant && seq % 4 === 3 ? 3 : 0,
        });
      }
      return { ok: true as const, messages, hasMore: start > 0 };
    },
  };

  // Signed OUT is the honest default, and the `[]` catch-all gets it backwards:
  // account.signedIn() returning `[]` is TRUTHY, and account.user() returning
  // `[]` is a truthy object with no `handle` — so HandlePrompt concluded the
  // user had just signed in without a handle and threw a modal over the whole
  // app on every load.
  // `?signedIn=1` flips account.signedIn/user/refresh for filming — the
  // landing page's games scene needs Connect Four past its sign-in wall.
  // Signed OUT stays the default (see above) so the sign-in states themselves
  // stay reviewable.
  const signedInSwitch = typeof location !== 'undefined'
    && new URLSearchParams(location.search).get('signedIn') === '1';
  const FIXTURE_USER: MarketplaceUser = {
    id: 'workbench:you', login: 'you', avatar_url: '', display_name: 'You', handle: 'you',
  };
  const account: Ns<'account'> = {
    signedIn: async () => signedInSwitch,
    user: async () => (signedInSwitch ? FIXTURE_USER : null),
    // account-context.tsx calls refresh() from a window "focus" listener that
    // attaches as soon as signedIn flips true (confirmed empirically: it fires
    // within seconds of the panel opening, well inside any real recording
    // session). Leaving this on the old `async () => null` silently flipped
    // `signedIn` back to false the first time the recording window regained
    // focus — sabotaging the exact scene Fix 2 exists for. Must mirror the switch.
    refresh: async () => (signedInSwitch ? FIXTURE_USER : null),
  };

  // Multiplayer games (Task 7c). Before this, `social` fell through to the
  // Proxy catch-all entirely — every call resolved `[]`/no-op, and
  // `onPresenceEvent` never invoked its callback, so GameLobby.tsx never left
  // its "Connecting…" spinner. This gives the workbench one scripted friend,
  // "Jake" — already added, already online — so the lobby (and, via
  // GameLobby.tsx's own auto-play effect, an actual game) work without a real
  // account or a real friend on the other end. Gated on signedInSwitch so a
  // signed-out workbench is unaffected: GameLobby.tsx shows SignInScreen
  // before any of this runs, and `presenceConnect` is never called either
  // (usePresence only connects when `useAccount().signedIn` is true, and that
  // reads from `account` above — same switch).
  const jakeNowSec = Math.floor(Date.now() / 1000);
  const JAKE_FRIEND = {
    id: JAKE_ID, display_name: JAKE_USERNAME, handle: 'jake', avatar_url: null,
    last_seen_at: jakeNowSec, created_at: jakeNowSec - 86_400,
  };
  // Holds the one onPresenceEvent callback the app registers (usePresence.ts
  // subscribes exactly once) so presenceConnect can push events into it.
  let presenceListener: ((ev: { type: string; [k: string]: unknown }) => void) | null = null;
  let presenceLive = false;
  const social: Ns<'social'> = {
    lookupHandle: async () => ({ ok: false, status: 404, message: 'No one has that handle' }),
    sendRequest: async () => ({ ok: false, status: 404, message: 'No one has that handle' }),
    listRequests: async () => ({ ok: true, value: { incoming: [], outgoing: [] } }),
    acceptRequest: async () => ({ ok: true, value: undefined }),
    declineRequest: async () => ({ ok: true, value: undefined }),
    cancelRequest: async () => ({ ok: true, value: undefined }),
    // The only friend that exists in the workbench — Jake, always present so
    // FriendsScreen has something to show even before presence reports him
    // online (mirrors a real friends list, which loads independently of who's
    // currently connected).
    listFriends: async () => ({ ok: true, value: signedInSwitch ? [JAKE_FRIEND] : [] }),
    unfriend: async () => ({ ok: true, value: undefined }),
    block: async () => ({ ok: true, value: undefined }),
    unblock: async () => ({ ok: true, value: undefined }),
    listBlocks: async () => ({ ok: true, value: [] }),
    presenceConnect: async () => {
      presenceLive = true;
      // Fire on a tick, not synchronously — usePresence.ts's onPresenceEvent
      // subscription and its presenceConnect() call happen in the same effect
      // (subscription first), but a real IPC round trip always has *some* gap,
      // and DEFAULT_LATENCY_MS-style delay here is what would surface a
      // "connected fires before anyone is listening" bug if one existed.
      setTimeout(() => {
        if (!presenceLive) return; // disconnected again before this fired
        presenceListener?.({ type: 'connected' });
        // §6.6's degraded case, taken through the REAL path: an `error` frame
        // is what a genuine outage sends, so the picker's "can't reach the game
        // server" line comes from the reducer rather than from a fixture that
        // no server would ever have produced. Solo tiles are untouched (§4.2).
        if (arcadeVersusIsDown(arcadeScenario)) {
          presenceListener?.({ type: 'error', message: "Can't reach the game server" });
          return;
        }
        presenceListener?.({
          type: 'presence',
          users: [{ id: JAKE_FRIEND.id, display_name: JAKE_FRIEND.display_name, handle: JAKE_FRIEND.handle, status: 'idle' }],
        });
      }, 150);
      return { ok: true };
    },
    presenceDisconnect: async () => {
      presenceLive = false;
      // No `code` → the reducer's silent "deliberate teardown" path, matching
      // what a real incognito toggle / sign-out looks like to usePresence.ts.
      presenceListener?.({ type: 'disconnected' });
      return { ok: true };
    },
    // Challenge/accept round-tripping isn't implemented — GameLobby.tsx's
    // auto-play effect skips straight to a game instead of waiting for a
    // click-through handshake with a bot. A real challenge send still needs
    // to resolve `ok` so `usePresence.challengePlayer` doesn't synthesize a
    // CHALLENGE_FAILED for a button a developer clicks while poking around.
    presenceSend: async (msg?: { type?: string; game?: string; opponent?: string; outcome?: string }) => {
      // A reported match settles (games §6.2). The real server holds the report
      // until BOTH players send a matching one, then pushes the agreed record
      // to each of them; here there is only one player, so the echo stands in
      // for the opponent agreeing. It goes back through the SAME presence
      // listener a real settlement uses, so the workbench exercises the actual
      // reducer path rather than a shortcut.
      //
      // The tick of delay is load-bearing for review: the record legitimately
      // arrives a moment AFTER the result card, and a screenshot taken before
      // it lands is a state real players will also see.
      if (msg?.type === 'game-result' && msg.game) {
        const before = arcadeRecordsFor(arcadeScenario, msg.game).value[0];
        const bump = msg.outcome === 'win' ? 'wins' : msg.outcome === 'loss' ? 'losses' : 'draws';
        setTimeout(() => {
          presenceListener?.({
            type: 'game-record',
            game: msg.game!,
            opponent: msg.opponent,
            source: 'attested',
            record: before
              ? { ...before, [bump]: (before[bump as 'wins'] ?? 0) + 1 }
              : { opponent_id: msg.opponent, game: msg.game, wins: 0, losses: 0, draws: 0, last_played_at: 0, [bump]: 1 },
          });
        }, 300);
      }
      return { ok: true };
    },
    onPresenceEvent: (cb) => {
      presenceListener = cb;
      return () => { if (presenceListener === cb) presenceListener = null; };
    },
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
    // ThemeProvider subscribes here for cross-window theme changes and applies
    // them LIVE (no reload). The landing page's embed uses that path: its theme
    // swatches call `__workbenchAppearanceSync({ theme })` on the iframe window
    // instead of reloading the app — a reload flashed the poster for a second.
    onSync: (cb: (prefs: unknown) => void) => { appearanceSyncSubs.add(cb); return () => { appearanceSyncSubs.delete(cb); }; },
  };
  const appearanceSyncSubs = new Set<(prefs: unknown) => void>();
  if (typeof window !== 'undefined') {
    (window as any).__workbenchAppearanceSync = (prefs: unknown) => { appearanceSyncSubs.forEach((f) => f(prefs)); return appearanceSyncSubs.size; };
  }

  // Project View and the artifact panel. Without these both render as empty
  // shells — the catch-all's `[]` is not `{ ok, projects }`, so every consumer
  // bails on the `res?.ok` guard and shows nothing. An empty surface is not a
  // reviewable mockup, which is the whole point of the workbench.
  // Bodies written by the artifact editor this session. Memory only, cleared by
  // a reload — the Workbench has no disk and must not pretend otherwise.
  const EDITED_ARTIFACTS = new Map<string, string>();
  const EDITED_MTIME = new Map<string, number>();
  const artifacts = {
    listProjectsIndex: async (opts?: { withCounts?: boolean }) => ({
      ok: true,
      // MOCKUP: descriptions edited in-session override the seeded ones, so the
      // inline editor behaves like the real thing instead of snapping back.
      projects: (opts?.withCounts ? projectsWithCounts() : artifactProjects())
        .map((p) => ({ ...p, description: descriptionFor(p.path, p.description) })),
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
      // An in-session edit wins over the seeded body. Without this the artifact
      // editor was a dead end in the Workbench: Save had no handler at all, so
      // the panel snapped back to the fixture and the whole edit-a-file story
      // could not be shown, let alone recorded.
      const edited = EDITED_ARTIFACTS.get(artifactId);
      if (edited !== undefined) {
        return { ok: true, content: edited, orphan: false, binary: false,
                 truncated: false, sizeBytes: edited.length, mtimeMs: EDITED_MTIME.get(artifactId) ?? 1 };
      }
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
    // Real handler shape (ipc-handlers.ts artifacts:save): { ok, mtimeMs } or a
    // conflict/refusal. The mock only ever succeeds — there is no second writer
    // in a Workbench, so a stale-mtime conflict is a state it cannot honestly
    // produce, and faking one would put a scary dialog in a recorded demo.
    save: async (
      _projectRoot: string, _projectId: string, _projectName: string,
      artifactId: string, content: string,
    ) => {
      const mtimeMs = Date.now();
      EDITED_ARTIFACTS.set(artifactId, content);
      EDITED_MTIME.set(artifactId, mtimeMs);
      return { ok: true, mtimeMs };
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
      // SVG is a vector source with no native resolution — the one format whose
      // magnified detail should stay perfectly sharp. Served as its own fixture
      // so that path is reviewable at all (it used to fall through to a refusal).
      if (ext === 'svg') {
        return { ok: true, base64: btoa(SAMPLE_SVG), mime: 'image/svg+xml' };
      }
      if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].includes(ext)) {
        // The 96x64 sample is smaller than the 180px magnifier lens, which
        // suppresses itself on tiny sources — so it cannot review the zoom at
        // all. Chart/screenshot paths get a generated 1600x1000 pattern with 7px
        // text instead; everything else keeps the small sample, so the existing
        // thumbnail surfaces look exactly as they did.
        const name = absolutePath.split('/').pop()?.toLowerCase() ?? '';
        if (/chart|screenshot/.test(name)) {
          const detailed = makeDetailPngBase64();
          if (detailed) return { ok: true, base64: detailed, mime: 'image/png' };
        }
        return { ok: true, base64: SAMPLE_PNG_BASE64, mime: 'image/png' };
      }
      if (ext === 'pdf') {
        const pdf = makeSamplePdfBase64();
        if (pdf) return { ok: true, base64: pdf, mime: 'application/pdf' };
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
  // The workbench is always a single window, so it IS the leader — but
  // nothing said so before Task 7c: `window.getId` and `detach.getDirectory`
  // both fell through to the catch-all, which resolves everything to `[]`.
  // App.tsx's `isLeader = myWindowId != null && leaderWindowId === myWindowId`
  // then compared `[] === -1` (the catch-all id vs. the useState default) —
  // never equal, so `isLeader` stayed false forever and `usePresence` never
  // called `presenceConnect()`. That is the ACTUAL reason Connect Four sat on
  // "Connecting…": not the game socket (party-client.ts), the leader check
  // gating whether presence even tries to connect. One fixed id for both
  // sides of the comparison is enough — there is only ever one workbench tab.
  const WORKBENCH_WINDOW_ID = 1;
  // `window` is Electron-only plumbing absent from useIpc.ts entirely (like
  // `theme` below) — no Ns<'window'> to type against, so this stays a plain
  // object.
  const windowNs = {
    getId: async () => WORKBENCH_WINDOW_ID,
  };
  const detach: Ns<'detach'> & { openDetached: (payload: { sessionId: string }) => void } = {
    // Present so `detachAvailable` is true and the "Launch in New Window"
    // toggle renders (SessionStrip.tsx:191, ResumeBrowser.tsx:242 both test
    // `typeof ... === 'function'`). A browser tab cannot actually detach — say
    // so loudly rather than pretending it worked.
    openDetached: () => {
      console.warn('[workbench] detach is not available in a browser tab');
    },
    // App.tsx calls this on mount specifically to avoid racing the
    // onDirectoryUpdated push — pulling `leaderWindowId: WORKBENCH_WINDOW_ID`
    // here is what makes `isLeader` resolve true.
    getDirectory: async () => ({ leaderWindowId: WORKBENCH_WINDOW_ID, windows: [] }),
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

    // Fires once, synchronously, same reasoning as chatHydrate above — App's
    // subscribe happens in an effect, so this lands in the same commit instead
    // of a flash of "no usage data yet". Only ever has something to say for
    // 'statusbar-cc' (see statusBarFixtureFor); every other scenario's cb is
    // simply never invoked, matching this channel's unwired-before-Task-9
    // behavior exactly.
    statusData: (cb) => {
      const fixture = statusBarFixtureFor(activeScenario);
      if (fixture) {
        cb({
          usage: fixture.usage,
          announcement: null,
          updateStatus: null,
          syncWarnings: [],
          contextMap: {},
          gitBranchMap: {},
          sessionStatsMap: fixture.sessionStatsMap,
        });
      }
      return () => {};
    },
  };

  // Fast mode + effort — /fast and /effort UI, and (Task 9) the StatusBar Fast
  // chip, which only renders when `fast` is true AND the session is Claude
  // Code. True only for 'statusbar-cc'; every other scenario gets `fast: false,
  // effort: 'auto'`, which is exactly what App.tsx read before this namespace
  // existed (the untyped `(window.claude as any).modes` access resolved to the
  // catch-all's `[]`, so `m?.fast` was always undefined -> false).
  const modes = {
    get: async () => ({ fast: activeScenario === 'statusbar-cc', effort: 'auto' }),
    set: async () => ({ ok: true }),
  };
  // Scripted replies: the transcript/hook events a played reply fixture emits
  // (playReply in sendInput above). Same attachment pattern as specialistEvent
  // below — Ns<'on'> doesn't carry these members.
  (on as any).transcriptEvent = (cb: (e: any) => void) => { subs.transcript.add(cb); return () => { subs.transcript.delete(cb); }; };
  (on as any).hookEvent = (cb: (e: any) => void) => { subs.hook.add(cb); return () => { subs.hook.delete(cb); }; };
  // Specialists 1c: the delegation feed (run records + delivered notes). Not
  // on Ns<'on'> yet (no real channel) — attached separately so the typed
  // members above stay compiler-checked.
  (on as any).specialistEvent = (cb: (e: any) => void) => { specialistSubs.add(cb); return () => { specialistSubs.delete(cb); }; };
  (on as any).shellEvent = (cb: (e: any) => void) => { shellSubs.add(cb); return () => { shellSubs.delete(cb); }; };

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
  // Quick chips are a STATEFUL mock, not a canned read: the editor writes
  // through setChips on every add/remove/reorder/edit, so a read-only fixture
  // would make every mutation appear to do nothing. Mirrors the real store's
  // defaults so the composer row and the editor agree — QuickChips no longer
  // carries a hardcoded fallback list to paper over an empty answer here.
  let chipList: { skillId?: string; label: string; prompt: string }[] = [
    { skillId: 'journaling-assistant', label: 'Journal', prompt: "let's journal" },
    { skillId: 'claudes-inbox', label: 'Inbox', prompt: 'check my inbox' },
    { label: 'Git Status', prompt: "run git status and summarize what's changed" },
    { label: 'Review PR', prompt: 'review the latest PR on this repo' },
    { label: 'Fix Tests', prompt: 'run the tests and fix any failures' },
    { skillId: 'encyclopedia-librarian', label: 'Briefing', prompt: 'brief me on ' },
    { label: 'Draft Text', prompt: 'help me draft a text to ' },
  ];
  const skills = {
    getChips: async () => chipList.map((c) => ({ ...c })),
    setChips: async (next: { skillId?: string; label: string; prompt: string }[]) => {
      chipList = next.map((c) => ({ ...c }));
    },
    // Marketplace overhaul (2026-08-27): every bundle gets its catalog block
    // (type / origin / scan / capabilities), and the list also carries the
    // member rows (skills, specialists, tools INSIDE bundles) plus a few
    // standalone items — the shape the real catalog will return once built.
    listMarketplace: async () => (marketplaceEmpty ? [] : buildCatalog(MARKETPLACE_PLUGINS)),
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
  // fs:read-head — the first bytes of an attached file, for the composer's
  // attachment cards. Canned per file kind so the screenshot rig sees a REAL
  // rendered-markdown preview for the `composer-attachments` fixture
  // (/home/destin/Documents/design-notes.md) and something honest for the
  // rest; anything non-text gets the same refusal the real handler gives.
  const fs: Ns<'fs'> = {
    readHead: async (filePath: string, maxBytes?: number) => {
      const cap = Math.min(READ_HEAD_MAX_BYTES, Math.max(1, maxBytes ?? READ_HEAD_DEFAULT_BYTES));
      const kind = previewKind(filePath);
      const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
      let text: string | null = null;
      if (kind === 'markdown') text = WORKBENCH_MARKDOWN_HEAD;
      else if (kind === 'text') text = WORKBENCH_TEXT_HEADS[ext] ?? WORKBENCH_TEXT_HEADS.txt;
      if (text === null) return { ok: false as const, error: 'binary' };
      return { ok: true as const, text: text.slice(0, cap), truncated: text.length > cap };
    },
  };
  const marketplace = {
    getPackages: async () => (marketplaceEmpty ? {} : JSON.parse(JSON.stringify(INSTALLED_PACKAGES))),
  };

  // Games arcade (Step 1). Maps the workbench's own scenario switch onto the
  // arcade's four interesting states, so every state that is hard to reach by
  // accident — a board with only you on it, a service that is down, a player
  // who has never played — is one toolbar click away:
  //   default      -> played both, Jake online, everything up
  //   empty        -> brand-new install: nothing played, nobody online
  //   stress       -> you, alone on the board (the §6.5 invitation case)
  //   refused      -> versus service unreachable, solo untouched (§6.6)
  //
  const arcade = {
    status: async () => arcadeStatusFor(arcadeScenario),
    leaderboard: async (gameId: string) => arcadeBoardFor(arcadeScenario, gameId),
    // Answers in the REAL channel's shape (ApiResult around the Worker's reply)
    // so the renderer's "the server knows a higher best than this computer"
    // branch is exercised here rather than only in production. `best` echoes
    // the run: the workbench has no board to compare against.
    records: async (game?: string) => arcadeRecordsFor(arcadeScenario, game),
    submitScore: async (_gameId: string, score: number) =>
      ({ ok: true as const, value: { ok: true as const, best: score, best_at: Math.floor(Date.now() / 1000), runs: 1, is_best: true } }),
  };

  return {
    // Marketplace feedback (overhaul §1.7). PARTIAL on purpose: only these three
    // are hand-written; `install`, `rate`, `deleteRating`, `likeTheme` and
    // `report` keep falling through to the catch-all, because withCatchAll takes
    // from `impl` only the keys it hasOwnProperty — a partial namespace does not
    // shadow the rest.
    //
    // They exist at all because the catch-all answers `[]`, and FeedbackSection
    // correctly reads a non-{ok:true} response as a failure — so without these
    // every vote in the workbench would render "Couldn't save your vote".
    // The HTTP side is answered by fixtures/marketplace/worker-api-mock.ts;
    // these just wrap it in the ApiResult envelope main would return, so the
    // component's real success/failure handling runs.
    marketplaceApi: {
      thumb: async (input: { plugin_id: string; value: 'up' | 'down' | null }) => {
        const r = await fetch(`${MARKETPLACE_API_HOST}/thumbs`, { method: 'POST', body: JSON.stringify(input) });
        const v = (await r.json()) as { vote: 'up' | 'down' | null; thumbs_up: number; thumbs_down: number };
        return { ok: true as const, value: { vote: v.vote, thumbs_up: v.thumbs_up, thumbs_down: v.thumbs_down } };
      },
      myThumb: async (pluginId: string) => {
        const r = await fetch(`${MARKETPLACE_API_HOST}/thumbs/${encodeURIComponent(pluginId)}`);
        return { ok: true as const, value: (await r.json()) as { vote: 'up' | 'down' | null; thumbs_up: number; thumbs_down: number } };
      },
      comment: async (input: { plugin_id: string; text: string }) => {
        const r = await fetch(`${MARKETPLACE_API_HOST}/comments`, { method: 'POST', body: JSON.stringify(input) });
        const v = (await r.json()) as { id: string; hidden: boolean };
        return { ok: true as const, value: { id: v.id, hidden: v.hidden } };
      },
    },
    session, providers, permissions, models, engine, defaults, native, detach, tags, on, theme, firstRun,
    terminal, artifacts, syncSpaces, project, account, social, appearance, specialists, shell,
    skills, marketplace, folders, fs, modes, chatsearch, window: windowNs, arcade,
  } as unknown as Record<string, Record<string, unknown>>;
}
