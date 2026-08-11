import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HAND_WRITTEN } from '../src/renderer/dev/workbench/mock-shim';
import { MOCK_ONLY } from '../src/renderer/dev/workbench/mock-only';

const preload = readFileSync(join(__dirname, '../src/main/preload.ts'), 'utf8');
// remote-shim is the OTHER real implementation of window.claude — a handful of
// channels (on.chatHydrate) exist only there, because Electron clients get the
// same data from the transcript watcher. "Mirrors something real" has to mean
// either file, or the mock would be forced to declare a real channel MOCK_ONLY.
const remoteShim = readFileSync(join(__dirname, '../src/renderer/remote-shim.ts'), 'utf8');
const mockOnly = new Set(MOCK_ONLY.map((m) => m.channel));

// WHY namespace-scoped and not a bare `\blist\s*:` over the whole file: `list:`
// exists under session, tags, providers, theme and more, so a file-wide regex
// matches a channel that lives in a DIFFERENT namespace than the one the mock
// claims. The test would read green while proving nothing — worse than absent,
// because it is cited as the thing keeping the mock honest.
//
// preload.ts's exposed object puts namespaces at indent 2 (`  session: {`) and
// their members at indent 4, so scoping is a brace scan rather than a guess.
function namespaceBlock(ns: string): string | null {
  const start = preload.search(new RegExp(`^  ${ns}: \\{`, 'm'));
  if (start < 0) return null;
  const end = preload.indexOf('\n  },', start);
  return end < 0 ? preload.slice(start) : preload.slice(start, end);
}

/** `'session.list'` -> is there a `list` inside preload's `session` block?
 *  A dotless path like `'getPlatform'` is a top-level bridge member (indent 2). */
function existsInPreload(path: string): boolean {
  const parts = path.split('.');
  if (parts.length === 1) {
    return new RegExp(`^  ${parts[0]}\\s*[:(]`, 'm').test(preload);
  }
  const block = namespaceBlock(parts[0]);
  return !!block && new RegExp(`^    ${parts[1]}\\s*[:(]`, 'm').test(block);
}

// remote-shim nests its namespaces one level deeper than preload (indent 4, with
// members at indent 6), so it needs its own brace scan rather than reusing
// namespaceBlock's indent-2 pattern.
function remoteShimNamespaceBlock(ns: string): string | null {
  const start = remoteShim.search(new RegExp(`^    ${ns}: \\{`, 'm'));
  if (start < 0) return null;
  const end = remoteShim.indexOf('\n    },', start);
  return end < 0 ? remoteShim.slice(start) : remoteShim.slice(start, end);
}

/** `'on.chatHydrate'` -> is there a `chatHydrate` inside remote-shim's `on` block?
 *
 *  WHY namespace-scoped and not a bare leaf match (which is what this was until
 *  2026-08-11): a leaf regex reports `permissions.list` as REAL because some
 *  other namespace happens to have a `list:`. That false positive made the
 *  MOCK_ONLY staleness check below fail the moment MOCK_ONLY got its first
 *  entries — the check would have kept firing for any future `*.list` or
 *  `*.remove` channel too. Scoping is strictly stronger; `on.chatHydrate`, the
 *  one channel that legitimately relies on this fallback, still resolves. */
function existsInRemoteShim(path: string): boolean {
  const parts = path.split('.');
  if (parts.length === 1) {
    return new RegExp(`\\b${parts[0]}\\s*:`).test(remoteShim);
  }
  const block = remoteShimNamespaceBlock(parts[0]);
  return !!block && new RegExp(`^      ${parts[1]}\\s*[:(]`, 'm').test(block);
}

function existsSomewhereReal(path: string): boolean {
  return existsInPreload(path) || existsInRemoteShim(path);
}

describe('workbench mock contract', () => {
  // Sanity: if the scan itself breaks (preload reformatted, object moved), every
  // other assertion in this file silently passes. Pin known-real channels.
  it('the preload scan actually resolves known channels', () => {
    expect(existsInPreload('session.list')).toBe(true);
    expect(existsInPreload('getPlatform')).toBe(true);
    expect(existsInPreload('theme.readFile')).toBe(true);
    expect(existsInPreload('session.thisDoesNotExist')).toBe(false);
    // The bug the scoping exists to catch: `memoryCheck` is real, but it lives
    // in `models`, not `session`. A file-wide regex would call this true.
    expect(existsInPreload('session.memoryCheck')).toBe(false);
    expect(existsInPreload('models.memoryCheck')).toBe(true);
  });

  // Same sanity guard for the shim scan: if it silently resolved nothing, the
  // MOCK_ONLY staleness check below would pass vacuously.
  it('the remote-shim scan actually resolves known channels', () => {
    expect(existsInRemoteShim('on.chatHydrate')).toBe(true);
    expect(existsInRemoteShim('providers.list')).toBe(true);
    expect(existsInRemoteShim('on.thisDoesNotExist')).toBe(false);
    // The false positive that scoping exists to kill: `list:` and `remove:` are
    // real leaves elsewhere in the file, but there is no `permissions` namespace.
    expect(existsInRemoteShim('permissions.list')).toBe(false);
    expect(existsInRemoteShim('permissions.remove')).toBe(false);
  });

  // The rule that keeps UI-first development honest: a hand-written channel
  // either mirrors something real, or is registered as not-yet-built.
  it('every hand-written channel is real or registered MOCK_ONLY', () => {
    const orphans = HAND_WRITTEN.filter((p) => !mockOnly.has(p) && !existsSomewhereReal(p));
    expect(orphans).toEqual([]);
  });

  // The preload scan is the strict one, so record which channels rely on the
  // looser remote-shim fallback. If this list grows unexpectedly, something is
  // passing on a leaf match that the namespace-scoped scan would have caught.
  it('only the known channels fall back to remote-shim', () => {
    const shimOnly = HAND_WRITTEN.filter((p) => !existsInPreload(p) && existsInRemoteShim(p));
    expect(shimOnly).toEqual(['on.chatHydrate']);
  });

  // A stale registry is worse than none — it would keep claiming a feature is
  // unbuilt after it shipped.
  it('no MOCK_ONLY entry has since gained a real channel', () => {
    expect(MOCK_ONLY.filter((m) => existsSomewhereReal(m.channel))).toEqual([]);
  });

  it('every MOCK_ONLY entry names the feature it belongs to', () => {
    expect(MOCK_ONLY.filter((m) => !m.feature.trim())).toEqual([]);
  });

  // DERIVED from preload.ts rather than hand-listed, because a hand-list is
  // exactly what failed: the mock's top-level members were enumerated from
  // useIpc.ts, which omits getIncognito — and `window.claude?.getIncognito is
  // not a function` took the app down at boot. A new top-level callable in
  // preload now fails this test instead of the workbench.
  it('implements every top-level callable preload exposes', () => {
    const exposed = preload.slice(preload.indexOf("exposeInMainWorld('claude'"));
    // Filter in JS, not with a lookahead: `(?!\{)` after `\s*` backtracks the
    // whitespace to zero-width and then passes, so namespaces match too.
    const topLevel = [...exposed.matchAll(/^ {2}([a-zA-Z_]\w*):(.*)$/gm)]
      .filter(([, , rest]) => !rest.trim().startsWith('{'))
      .map(([, name]) => name);

    // Sanity: if this scan returns nothing the assertion below is vacuous.
    expect(topLevel).toContain('getIncognito');
    expect(topLevel.length).toBeGreaterThanOrEqual(10);

    const written = new Set(HAND_WRITTEN);
    expect(topLevel.filter((m) => !written.has(m))).toEqual([]);
  });
});
