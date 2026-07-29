import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HAND_WRITTEN } from '../src/renderer/dev/workbench/mock-shim';
import { MOCK_ONLY } from '../src/renderer/dev/workbench/mock-only';

const preload = readFileSync(join(__dirname, '../src/main/preload.ts'), 'utf8');
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

  // The rule that keeps UI-first development honest: a hand-written channel
  // either mirrors something real, or is registered as not-yet-built.
  it('every hand-written channel is real or registered MOCK_ONLY', () => {
    const orphans = HAND_WRITTEN.filter((p) => !mockOnly.has(p) && !existsInPreload(p));
    expect(orphans).toEqual([]);
  });

  // A stale registry is worse than none — it would keep claiming a feature is
  // unbuilt after it shipped.
  it('no MOCK_ONLY entry has since gained a real preload channel', () => {
    expect(MOCK_ONLY.filter((m) => existsInPreload(m.channel))).toEqual([]);
  });

  it('every MOCK_ONLY entry names the feature it belongs to', () => {
    expect(MOCK_ONLY.filter((m) => !m.feature.trim())).toEqual([]);
  });
});
