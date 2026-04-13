# Theme Publish Lifecycle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "Publish to marketplace" button always reflect a user-authored theme's true marketplace state (draft / in-review / published-current / published-drift), with no persisted local flag — state is derived from the registry, GitHub PRs, and a content hash.

**Architecture:** Add a `contentHash` field to theme registry entries (computed at publish time, propagated by destinclaude-themes CI). On each theme detail open, derive button state via a pure resolver fed by three lookups: registry entry match (existing fetch), open/recently-merged PR for `(slug, author)` via `gh pr list` (60s session cache), and a recomputed local content hash. Invalidate the registry cache after a successful publish. Optimistically flip to `in-review` on publish success.

**Tech Stack:** TypeScript (Electron main + React renderer), Node `crypto`, `gh` CLI, Python (destinclaude-themes registry builder), Vitest (existing desktop test runner — confirm during Task 1).

**Spec:** `destincode/desktop/docs/superpowers/specs/2026-04-12-theme-publish-lifecycle-design.md`

**Worktree:** Run this plan in a `destincode` git worktree (e.g., `git -C destincode worktree add ../destincode-publish-lifecycle`). The destinclaude-themes change in Task 11 needs its own worktree under that repo.

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `destincode/desktop/src/main/theme-content-hash.ts` | create | Pure content-hash function for a local theme dir |
| `destincode/desktop/src/main/theme-content-hash.test.ts` | create | Unit tests for hash stability/sensitivity |
| `destincode/desktop/src/main/theme-pr-lookup.ts` | create | `gh pr list` wrappers + 60s session cache |
| `destincode/desktop/src/renderer/state/publish-state-resolver.ts` | create | Pure `resolvePublishState()` function + state types |
| `destincode/desktop/src/renderer/state/publish-state-resolver.test.ts` | create | Exhaustive resolver unit tests |
| `destincode/desktop/src/main/theme-marketplace-provider.ts` | modify | Add `invalidateRegistryCache()`, write `contentHash` into PR manifest, accept `existingEntry` hint, add `resolvePublishState()` orchestration method |
| `destincode/desktop/src/shared/theme-marketplace-types.ts` | modify | Add optional `contentHash` to `ThemeRegistryEntry`; export `PublishState` enum |
| `destincode/desktop/src/main/preload.ts` | modify | Add IPC constants + bridge for resolve-publish-state, refresh-registry |
| `destincode/desktop/src/main/ipc-handlers.ts` | modify | Wire two new IPC handlers |
| `destincode/desktop/src/renderer/remote-shim.ts` | modify | Mirror new methods on `window.claude.theme.marketplace` |
| `destincode/desktop/src/renderer/components/ThemeDetail.tsx` | modify | Render four states + degraded-mode warning + optimistic flip |
| `destincode/desktop/src/renderer/components/MarketplaceModal.tsx` (or equivalent) | modify | Add Refresh icon to marketplace browser header |
| `destinclaude-themes/scripts/build-registry.py` | modify | Read `contentHash` from manifest → registry entry |

---

## Task 1: Establish test harness baseline

**Files:** none (verification only)

- [ ] **Step 1: Confirm desktop test runner**

Run: `cd destincode/desktop && grep -E "\"(test|vitest|jest)\":" package.json`
Expected: a `"test"` script that runs `vitest` (or `jest`). Note which one — every later test step uses it.

- [ ] **Step 2: Confirm baseline passes**

Run: `cd destincode/desktop && npm test`
Expected: existing suite passes (or at minimum, no failures unrelated to this work).

- [ ] **Step 3: Commit nothing**

This task is verification only. If tests don't pass on master, stop and surface to user before continuing.

---

## Task 2: Pure content-hash utility

**Files:**
- Create: `destincode/desktop/src/main/theme-content-hash.ts`
- Test: `destincode/desktop/src/main/theme-content-hash.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// theme-content-hash.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { computeThemeContentHash } from './theme-content-hash';

describe('computeThemeContentHash', () => {
  let tmp: string;

  beforeAll(async () => {
    tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'theme-hash-'));
    await fs.promises.writeFile(
      path.join(tmp, 'manifest.json'),
      JSON.stringify({ name: 'Test', tokens: { canvas: '#fff' } }),
    );
    await fs.promises.mkdir(path.join(tmp, 'assets'));
    await fs.promises.writeFile(path.join(tmp, 'assets', 'a.png'), Buffer.from([1, 2, 3]));
    await fs.promises.writeFile(path.join(tmp, 'assets', 'b.png'), Buffer.from([4, 5, 6]));
  });

  afterAll(async () => {
    await fs.promises.rm(tmp, { recursive: true, force: true });
  });

  it('produces a sha256:<hex> hash', async () => {
    const h = await computeThemeContentHash(tmp);
    expect(h).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is stable across calls', async () => {
    const h1 = await computeThemeContentHash(tmp);
    const h2 = await computeThemeContentHash(tmp);
    expect(h1).toBe(h2);
  });

  it('is order-independent for assets', async () => {
    const h1 = await computeThemeContentHash(tmp);
    // Touch mtime by rewriting in reverse — content unchanged, order on disk may shift
    await fs.promises.writeFile(path.join(tmp, 'assets', 'b.png'), Buffer.from([4, 5, 6]));
    await fs.promises.writeFile(path.join(tmp, 'assets', 'a.png'), Buffer.from([1, 2, 3]));
    const h2 = await computeThemeContentHash(tmp);
    expect(h1).toBe(h2);
  });

  it('changes when manifest changes', async () => {
    const h1 = await computeThemeContentHash(tmp);
    await fs.promises.writeFile(
      path.join(tmp, 'manifest.json'),
      JSON.stringify({ name: 'Test2', tokens: { canvas: '#fff' } }),
    );
    const h2 = await computeThemeContentHash(tmp);
    expect(h1).not.toBe(h2);
  });

  it('changes when an asset changes', async () => {
    const h1 = await computeThemeContentHash(tmp);
    await fs.promises.writeFile(path.join(tmp, 'assets', 'a.png'), Buffer.from([9, 9, 9]));
    const h2 = await computeThemeContentHash(tmp);
    expect(h1).not.toBe(h2);
  });

  it('ignores existing contentHash field in manifest', async () => {
    await fs.promises.writeFile(
      path.join(tmp, 'manifest.json'),
      JSON.stringify({ name: 'Test2', tokens: { canvas: '#fff' } }),
    );
    const without = await computeThemeContentHash(tmp);
    await fs.promises.writeFile(
      path.join(tmp, 'manifest.json'),
      JSON.stringify({ name: 'Test2', tokens: { canvas: '#fff' }, contentHash: 'sha256:fake' }),
    );
    const withField = await computeThemeContentHash(tmp);
    expect(without).toBe(withField);
  });

  it('ignores preview.png if present', async () => {
    const h1 = await computeThemeContentHash(tmp);
    await fs.promises.writeFile(path.join(tmp, 'preview.png'), Buffer.from([7, 7, 7]));
    const h2 = await computeThemeContentHash(tmp);
    expect(h1).toBe(h2);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd destincode/desktop && npm test -- theme-content-hash`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// theme-content-hash.ts
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Stable hash of a local theme's content (manifest + assets), used to detect
 * drift between a published theme and its local source. Hashes:
 *   - manifest.json with the `contentHash`, `source`, and `basePath` fields stripped
 *     (those fields are ephemeral / not part of the published payload)
 *   - all files under assets/, in sorted-path order
 *
 * preview.png is intentionally excluded — CI regenerates it, so including it
 * would make every published theme appear "drifted".
 */
export async function computeThemeContentHash(themeDir: string): Promise<string> {
  const hash = crypto.createHash('sha256');

  // Manifest, with non-publishable fields stripped
  const manifestRaw = await fs.promises.readFile(path.join(themeDir, 'manifest.json'), 'utf-8');
  const manifest = JSON.parse(manifestRaw);
  delete manifest.contentHash;
  delete manifest.source;
  delete manifest.basePath;
  hash.update('manifest:');
  hash.update(JSON.stringify(manifest, Object.keys(manifest).sort()));

  // Assets — recursive walk, sorted paths
  const assetsDir = path.join(themeDir, 'assets');
  if (fs.existsSync(assetsDir)) {
    const files = await walk(assetsDir);
    files.sort();
    for (const abs of files) {
      const rel = path.relative(themeDir, abs).replace(/\\/g, '/');
      const data = await fs.promises.readFile(abs);
      hash.update(`asset:${rel}:${data.length}:`);
      hash.update(data);
    }
  }

  return `sha256:${hash.digest('hex')}`;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await walk(full));
    else out.push(full);
  }
  return out;
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd destincode/desktop && npm test -- theme-content-hash`
Expected: all 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add destincode/desktop/src/main/theme-content-hash.ts destincode/desktop/src/main/theme-content-hash.test.ts
git commit -m "feat(themes): pure content-hash utility for publish-state drift detection"
```

---

## Task 3: Add `contentHash` to shared types + `PublishState` enum

**Files:**
- Modify: `destincode/desktop/src/shared/theme-marketplace-types.ts`

- [ ] **Step 1: Add field + enum**

In `theme-marketplace-types.ts`, find the `ThemeRegistryEntry` interface and add:

```ts
/**
 * sha256:<hex> of the theme's manifest + assets (excluding preview.png and
 * ephemeral fields). Used to detect drift between a published registry entry
 * and its local source. Optional — entries published before this field
 * existed are treated as matching by the resolver.
 */
contentHash?: string;
```

At the bottom of the file, append:

```ts
export type PublishState =
  | { kind: 'draft' }
  | { kind: 'in-review'; prNumber: number; prUrl: string }
  | { kind: 'published-current'; marketplaceUrl: string }
  | { kind: 'published-drift'; marketplaceUrl: string }
  | { kind: 'unknown'; reason: string };  // degraded mode — gh failed, etc.
```

- [ ] **Step 2: Verify typecheck**

Run: `cd destincode/desktop && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add destincode/desktop/src/shared/theme-marketplace-types.ts
git commit -m "feat(themes): add contentHash field + PublishState type for publish lifecycle"
```

---

## Task 4: Pure publish-state resolver

**Files:**
- Create: `destincode/desktop/src/renderer/state/publish-state-resolver.ts`
- Test: `destincode/desktop/src/renderer/state/publish-state-resolver.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// publish-state-resolver.test.ts
import { describe, it, expect } from 'vitest';
import { resolvePublishState } from './publish-state-resolver';

const baseEntry = {
  slug: 'sunset', author: 'alice', name: 'Sunset', dark: false,
  features: [], manifestUrl: 'x', source: 'community' as const,
  contentHash: 'sha256:abc',
} as any;

describe('resolvePublishState', () => {
  it('draft when no registry hit and no PR', () => {
    expect(resolvePublishState({
      registryEntry: null, openPR: null, recentlyMergedPR: null, localHash: 'sha256:abc',
    })).toEqual({ kind: 'draft' });
  });

  it('in-review when an open PR exists (even with no registry entry)', () => {
    expect(resolvePublishState({
      registryEntry: null,
      openPR: { number: 42, url: 'https://github.com/x/y/pull/42' },
      recentlyMergedPR: null,
      localHash: 'sha256:abc',
    })).toEqual({ kind: 'in-review', prNumber: 42, prUrl: 'https://github.com/x/y/pull/42' });
  });

  it('in-review (with merged PR) bridges the post-merge / pre-CI window', () => {
    expect(resolvePublishState({
      registryEntry: null, openPR: null,
      recentlyMergedPR: { number: 7, url: 'https://github.com/x/y/pull/7' },
      localHash: 'sha256:abc',
    })).toEqual({ kind: 'in-review', prNumber: 7, prUrl: 'https://github.com/x/y/pull/7' });
  });

  it('published-current when registry hit and hashes match', () => {
    expect(resolvePublishState({
      registryEntry: baseEntry, openPR: null, recentlyMergedPR: null,
      localHash: 'sha256:abc',
    })).toEqual({
      kind: 'published-current',
      marketplaceUrl: 'https://github.com/itsdestin/destinclaude-themes/tree/main/themes/sunset',
    });
  });

  it('published-drift when registry hit but hashes differ', () => {
    expect(resolvePublishState({
      registryEntry: baseEntry, openPR: null, recentlyMergedPR: null,
      localHash: 'sha256:DIFFERENT',
    })).toEqual({
      kind: 'published-drift',
      marketplaceUrl: 'https://github.com/itsdestin/destinclaude-themes/tree/main/themes/sunset',
    });
  });

  it('treats missing contentHash on registry entry as matching (legacy)', () => {
    const legacy = { ...baseEntry, contentHash: undefined };
    expect(resolvePublishState({
      registryEntry: legacy, openPR: null, recentlyMergedPR: null,
      localHash: 'sha256:anything',
    }).kind).toBe('published-current');
  });

  it('open PR wins over registry entry (in-review trumps published)', () => {
    // Edge case: theme is published AND has an open update PR → show in-review
    expect(resolvePublishState({
      registryEntry: baseEntry,
      openPR: { number: 99, url: 'u' },
      recentlyMergedPR: null,
      localHash: 'sha256:abc',
    }).kind).toBe('in-review');
  });

  it('returns unknown when degraded reason is provided', () => {
    expect(resolvePublishState({
      registryEntry: null, openPR: null, recentlyMergedPR: null,
      localHash: 'sha256:abc',
      degradedReason: 'gh not authenticated',
    })).toEqual({ kind: 'unknown', reason: 'gh not authenticated' });
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `cd destincode/desktop && npm test -- publish-state-resolver`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// publish-state-resolver.ts
import type { ThemeRegistryEntry, PublishState } from '../../shared/theme-marketplace-types';

export interface PRRef { number: number; url: string }

export interface ResolverInputs {
  registryEntry: ThemeRegistryEntry | null;
  openPR: PRRef | null;
  recentlyMergedPR: PRRef | null;
  localHash: string;
  /** When set, all other inputs are ignored and we return `unknown`. */
  degradedReason?: string;
}

const MARKETPLACE_BASE = 'https://github.com/itsdestin/destinclaude-themes/tree/main/themes';

export function resolvePublishState(inputs: ResolverInputs): PublishState {
  if (inputs.degradedReason) {
    return { kind: 'unknown', reason: inputs.degradedReason };
  }

  // An in-flight or just-merged PR always wins — it's the most recent intent.
  const pendingPR = inputs.openPR ?? inputs.recentlyMergedPR;
  if (pendingPR) {
    return { kind: 'in-review', prNumber: pendingPR.number, prUrl: pendingPR.url };
  }

  if (inputs.registryEntry) {
    const marketplaceUrl = `${MARKETPLACE_BASE}/${inputs.registryEntry.slug}`;
    // Legacy entries with no contentHash are treated as matching — never block
    // the user with a "drift" state caused by missing data.
    const matches =
      !inputs.registryEntry.contentHash ||
      inputs.registryEntry.contentHash === inputs.localHash;
    return matches
      ? { kind: 'published-current', marketplaceUrl }
      : { kind: 'published-drift', marketplaceUrl };
  }

  return { kind: 'draft' };
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd destincode/desktop && npm test -- publish-state-resolver`
Expected: all 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add destincode/desktop/src/renderer/state/publish-state-resolver.ts destincode/desktop/src/renderer/state/publish-state-resolver.test.ts
git commit -m "feat(themes): pure resolver mapping registry+PR+hash to publish state"
```

---

## Task 5: PR-status lookup with session cache

**Files:**
- Create: `destincode/desktop/src/main/theme-pr-lookup.ts`
- Test: `destincode/desktop/src/main/theme-pr-lookup.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// theme-pr-lookup.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ThemePRLookup } from './theme-pr-lookup';

describe('ThemePRLookup', () => {
  let calls: string[][];
  let stubResults: Record<string, string>;
  let lookup: ThemePRLookup;

  beforeEach(() => {
    calls = [];
    stubResults = {};
    const fakeExec = async (_bin: string, args: string[]) => {
      calls.push(args);
      const key = args.join(' ');
      return { stdout: stubResults[key] ?? '[]' };
    };
    lookup = new ThemePRLookup({ execFile: fakeExec as any, ttlMs: 60_000, now: () => 1_000 });
  });

  it('returns null when gh returns empty list', async () => {
    const result = await lookup.findOpenPR('sunset', 'alice');
    expect(result).toBeNull();
  });

  it('returns first matching PR', async () => {
    const args = ['pr', 'list', '--repo', 'itsdestin/destinclaude-themes',
      '--author', 'alice', '--state', 'open', '--search', 'sunset',
      '--json', 'number,url'];
    stubResults[args.join(' ')] = JSON.stringify([{ number: 42, url: 'https://x/42' }]);
    const result = await lookup.findOpenPR('sunset', 'alice');
    expect(result).toEqual({ number: 42, url: 'https://x/42' });
  });

  it('caches results within the TTL window', async () => {
    await lookup.findOpenPR('sunset', 'alice');
    await lookup.findOpenPR('sunset', 'alice');
    expect(calls.length).toBe(1);
  });

  it('refetches after invalidation', async () => {
    await lookup.findOpenPR('sunset', 'alice');
    lookup.invalidate('sunset', 'alice');
    await lookup.findOpenPR('sunset', 'alice');
    expect(calls.length).toBe(2);
  });

  it('searches recently merged PRs (5 minute window)', async () => {
    await lookup.findRecentlyMergedPR('sunset', 'alice');
    expect(calls[0]).toContain('--state');
    expect(calls[0]).toContain('merged');
    // Search includes a merged:>= filter; just confirm it's present
    const search = calls[0][calls[0].indexOf('--search') + 1];
    expect(search).toContain('sunset');
    expect(search).toMatch(/merged:>=/);
  });

  it('falls back to null on gh failure', async () => {
    const failing = new ThemePRLookup({
      execFile: (async () => { throw new Error('gh not found'); }) as any,
      ttlMs: 60_000, now: () => 1_000,
    });
    const result = await failing.findOpenPR('sunset', 'alice');
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests, verify failure**

Run: `cd destincode/desktop && npm test -- theme-pr-lookup`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// theme-pr-lookup.ts
import { execFile } from 'child_process';
import { promisify } from 'util';

const REPO = 'itsdestin/destinclaude-themes';
const DEFAULT_TTL_MS = 60_000;
const MERGED_WINDOW_MIN = 5;

export interface PRRef { number: number; url: string }

interface CacheEntry { value: PRRef | null; expires: number }

export interface ThemePRLookupOpts {
  execFile?: (bin: string, args: string[]) => Promise<{ stdout: string }>;
  ttlMs?: number;
  now?: () => number;
  ghPath?: string;
}

export class ThemePRLookup {
  private openCache = new Map<string, CacheEntry>();
  private mergedCache = new Map<string, CacheEntry>();
  private execFile: (bin: string, args: string[]) => Promise<{ stdout: string }>;
  private ttlMs: number;
  private now: () => number;
  private ghPath: string;

  constructor(opts: ThemePRLookupOpts = {}) {
    this.execFile = opts.execFile ?? (promisify(execFile) as any);
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
    this.now = opts.now ?? Date.now;
    this.ghPath = opts.ghPath ?? 'gh';
  }

  invalidate(slug: string, author: string) {
    const key = `${author}/${slug}`;
    this.openCache.delete(key);
    this.mergedCache.delete(key);
  }

  async findOpenPR(slug: string, author: string): Promise<PRRef | null> {
    return this.cached(this.openCache, `${author}/${slug}`, async () => {
      const args = ['pr', 'list', '--repo', REPO, '--author', author,
        '--state', 'open', '--search', slug, '--json', 'number,url'];
      return this.runAndParseFirst(args);
    });
  }

  async findRecentlyMergedPR(slug: string, author: string): Promise<PRRef | null> {
    return this.cached(this.mergedCache, `${author}/${slug}`, async () => {
      const cutoff = new Date(this.now() - MERGED_WINDOW_MIN * 60_000).toISOString();
      const args = ['pr', 'list', '--repo', REPO, '--author', author,
        '--state', 'merged', '--search', `${slug} merged:>=${cutoff}`,
        '--json', 'number,url'];
      return this.runAndParseFirst(args);
    });
  }

  private async cached(
    cache: Map<string, CacheEntry>, key: string, fetcher: () => Promise<PRRef | null>,
  ): Promise<PRRef | null> {
    const hit = cache.get(key);
    if (hit && hit.expires > this.now()) return hit.value;
    const value = await fetcher();
    cache.set(key, { value, expires: this.now() + this.ttlMs });
    return value;
  }

  private async runAndParseFirst(args: string[]): Promise<PRRef | null> {
    try {
      const { stdout } = await this.execFile(this.ghPath, args);
      const arr = JSON.parse(stdout || '[]');
      if (Array.isArray(arr) && arr.length > 0 && typeof arr[0]?.number === 'number') {
        return { number: arr[0].number, url: String(arr[0].url) };
      }
      return null;
    } catch {
      // Degraded mode — caller treats null as "no PR found", but may also
      // surface a degraded warning if it independently knows gh is broken.
      return null;
    }
  }
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `cd destincode/desktop && npm test -- theme-pr-lookup`
Expected: all 6 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add destincode/desktop/src/main/theme-pr-lookup.ts destincode/desktop/src/main/theme-pr-lookup.test.ts
git commit -m "feat(themes): gh-backed PR lookup with 60s session cache"
```

---

## Task 6: Wire `contentHash` into `publishTheme()` + add `invalidateRegistryCache()` + `existingEntry` hint

**Files:**
- Modify: `destincode/desktop/src/main/theme-marketplace-provider.ts`

- [ ] **Step 1: Add cache invalidation method**

In `theme-marketplace-provider.ts`, inside the `ThemeMarketplaceProvider` class, add (place near the top, alongside `cachedIndex`):

```ts
/** Drop the in-memory registry cache so the next list/detail call refetches. */
invalidateRegistryCache(): void {
  this.cachedIndex = null;
  this.cacheTimestamp = 0;
}
```

- [ ] **Step 2: Update `publishTheme` signature and body**

Find the method declaration `async publishTheme(slug: string): Promise<{ prUrl: string }> {` and replace the *signature line* and the cleanManifest construction (currently around line 380-388) with the version below. The rest of the method body stays unchanged except for two named differences inline.

```ts
async publishTheme(
  slug: string,
  opts: { existingEntry?: ThemeRegistryEntry } = {},
): Promise<{ prUrl: string; prNumber: number }> {
  // ... existing slug validation, manifest read, gh auth, fork, base-sha,
  // branch-name decision (see below), branch creation, preview generation
  // (lines 299-376 of original) ...
}
```

Then make these specific in-place edits within the method body:

  a. **Compute branch name based on update vs new:** Replace `const branchName = `theme/${slug}`;` (around line 327) with:

```ts
const isUpdate = !!opts.existingEntry;
const branchName = isUpdate
  ? `update-theme/${slug}-${Date.now()}`
  : `theme/${slug}`;
```

  b. **Compute and inject `contentHash` into the cleaned manifest** before the file is added to `filesToUpload`. Replace the block that builds `cleanManifest` (currently lines 380-388) with:

```ts
const { computeThemeContentHash } = await import('./theme-content-hash');
const contentHash = await computeThemeContentHash(themeDir);

// Strip ephemeral fields, then bake in the content hash so the destinclaude-themes
// CI can copy it into the registry entry without recomputing.
const cleanManifest = { ...manifest };
delete cleanManifest.source;
delete cleanManifest.basePath;
cleanManifest.contentHash = contentHash;

filesToUpload.push({
  repoPath: `themes/${slug}/manifest.json`,
  localPath: manifestPath,
  binary: false,
});
```

  c. **Update PR title/body for the update case.** Replace the `prTitle` line and the `prBody` array (currently lines 482-493) with:

```ts
const prTitle = isUpdate
  ? `[Theme Update] ${manifest.name || slug}`
  : `[Theme] ${manifest.name || slug}`;

const prBody = [
  isUpdate
    ? `## Theme Update: ${manifest.name || slug}`
    : `## New Theme: ${manifest.name || slug}`,
  '',
  manifest.description ? `> ${manifest.description}` : '',
  '',
  `- **Author:** ${manifest.author || username}`,
  `- **Mode:** ${manifest.dark ? 'Dark' : 'Light'}`,
  `- **Slug:** \`${slug}\``,
  `- **Content hash:** \`${contentHash}\``,
  '',
  isUpdate
    ? '_Update submitted via DestinCode Theme Marketplace_'
    : '_Submitted via DestinCode Theme Marketplace_',
].join('\n');
```

  d. **Return the PR number alongside `prUrl`.** The existing `gh pr create` returns the URL only. Replace:

```ts
return { prUrl: prUrlRaw.trim() };
```

with:

```ts
const prUrl = prUrlRaw.trim();
return { prUrl, prNumber: extractPRNumber(prUrl) };
```

And in the existing-PR fallback branch:

```ts
if (existingPr.trim()) {
  const prUrl = existingPr.trim();
  return { prUrl, prNumber: extractPRNumber(prUrl) };
}
```

  e. **Add the helper at the bottom of the file (outside the class):**

```ts
/** Pull the numeric PR id out of a github.com PR url. Throws on malformed input. */
function extractPRNumber(url: string): number {
  const m = url.match(/\/pull\/(\d+)/);
  if (!m) throw new Error(`Could not parse PR number from ${url}`);
  return Number(m[1]);
}
```

  f. **Invalidate the registry cache on success.** At the very end of `publishTheme()` — immediately before each `return` statement that hands back a `prUrl` — call:

```ts
this.invalidateRegistryCache();
```

(There are two return points in the method — the success path and the existing-PR fallback. Both get the call.)

- [ ] **Step 3: Verify typecheck**

Run: `cd destincode/desktop && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Verify existing publish tests still pass**

Run: `cd destincode/desktop && npm test -- theme-marketplace`
Expected: any pre-existing tests continue passing. (If none exist, that's fine — manual end-to-end is in Task 13.)

- [ ] **Step 5: Commit**

```bash
git add destincode/desktop/src/main/theme-marketplace-provider.ts
git commit -m "feat(themes): publish writes contentHash, supports update PRs, invalidates cache"
```

---

## Task 7: Provider-level orchestration method `resolvePublishState`

**Files:**
- Modify: `destincode/desktop/src/main/theme-marketplace-provider.ts`

- [ ] **Step 1: Add the orchestration method**

Add to the `ThemeMarketplaceProvider` class (place after `publishTheme`):

```ts
private prLookup = new (require('./theme-pr-lookup').ThemePRLookup)();

/**
 * Resolve the publish-state for a local user theme. Combines the registry
 * fetch, gh PR lookups, and a recomputed local content hash. Returns a
 * pure-data PublishState the renderer can render directly. Pure errors
 * degrade to { kind: 'unknown' } rather than throwing.
 */
async resolvePublishStateForSlug(
  slug: string,
): Promise<import('../shared/theme-marketplace-types').PublishState> {
  const { resolvePublishState } = await import('../renderer/state/publish-state-resolver');
  const { computeThemeContentHash } = await import('./theme-content-hash');

  if (!SAFE_SLUG_RE.test(slug)) {
    return { kind: 'unknown', reason: 'invalid slug' };
  }

  const themeDir = path.join(THEMES_DIR, slug);
  const manifestPath = path.join(themeDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    return { kind: 'unknown', reason: 'theme not found on disk' };
  }

  // Resolve author from the local manifest first; fall back to gh auth.
  let author: string;
  try {
    const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf-8'));
    if (typeof manifest.author === 'string' && manifest.author.length > 0) {
      author = manifest.author;
    } else {
      const { stdout } = await execFileAsync(ghPath, ['api', 'user', '--jq', '.login']);
      author = stdout.trim();
    }
  } catch {
    return { kind: 'unknown', reason: 'gh not authenticated' };
  }

  // Run lookups in parallel — they're independent.
  const [index, openPR, recentlyMergedPR, localHash] = await Promise.all([
    this.fetchRegistry().catch(() => null),
    this.prLookup.findOpenPR(slug, author),
    this.prLookup.findRecentlyMergedPR(slug, author),
    computeThemeContentHash(themeDir),
  ]);

  const registryEntry = index?.themes.find(t => t.slug === slug && t.author === author) ?? null;

  return resolvePublishState({ registryEntry, openPR, recentlyMergedPR, localHash });
}

/** Invalidate PR-status cache for a given (slug, author). */
invalidatePRStatus(slug: string, author: string): void {
  this.prLookup.invalidate(slug, author);
}
```

- [ ] **Step 2: Hook PR-cache invalidation into `publishTheme` success**

Inside `publishTheme`, immediately before each `return` statement that hands back a `prUrl` (the same two spots as `invalidateRegistryCache`), also call:

```ts
this.invalidatePRStatus(slug, username);
```

(`username` is already in scope — it was set earlier in `publishTheme` from `gh api user`.)

- [ ] **Step 3: Verify typecheck**

Run: `cd destincode/desktop && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add destincode/desktop/src/main/theme-marketplace-provider.ts
git commit -m "feat(themes): provider.resolvePublishStateForSlug() orchestrates lookups"
```

---

## Task 8: IPC channel + handlers

**Files:**
- Modify: `destincode/desktop/src/main/preload.ts`
- Modify: `destincode/desktop/src/main/ipc-handlers.ts`

- [ ] **Step 1: Add IPC channel constants in preload.ts**

In `preload.ts`, find the `IPC` constants block (the block that contains `THEME_MARKETPLACE_PUBLISH`) and add two entries:

```ts
THEME_MARKETPLACE_RESOLVE_PUBLISH_STATE: 'theme-marketplace:resolve-publish-state',
THEME_MARKETPLACE_REFRESH_REGISTRY: 'theme-marketplace:refresh-registry',
```

- [ ] **Step 2: Bridge them on `window.claude.theme.marketplace` in preload.ts**

In the same file, find the `theme.marketplace` exposure block (which already has `publish: (slug)`...). Add:

```ts
resolvePublishState: (slug: string): Promise<any> =>
  ipcRenderer.invoke(IPC.THEME_MARKETPLACE_RESOLVE_PUBLISH_STATE, slug),
refreshRegistry: (): Promise<any> =>
  ipcRenderer.invoke(IPC.THEME_MARKETPLACE_REFRESH_REGISTRY),
```

- [ ] **Step 3: Wire handlers in ipc-handlers.ts**

In `ipc-handlers.ts`, find where `THEME_MARKETPLACE_PUBLISH` is handled and add (next to it):

```ts
ipcMain.handle(IPC.THEME_MARKETPLACE_RESOLVE_PUBLISH_STATE, async (_e, slug: string) => {
  return themeMarketplaceProvider.resolvePublishStateForSlug(slug);
});

ipcMain.handle(IPC.THEME_MARKETPLACE_REFRESH_REGISTRY, async () => {
  themeMarketplaceProvider.invalidateRegistryCache();
  // Return a fresh listing so the renderer can update in one round-trip.
  return themeMarketplaceProvider.listThemes();
});
```

(Use the existing `themeMarketplaceProvider` instance variable — name may be slightly different in the file; match what's already there.)

- [ ] **Step 4: Verify typecheck**

Run: `cd destincode/desktop && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 5: Commit**

```bash
git add destincode/desktop/src/main/preload.ts destincode/desktop/src/main/ipc-handlers.ts
git commit -m "feat(themes): IPC channels for resolve-publish-state + refresh-registry"
```

---

## Task 9: Mirror new methods in `remote-shim.ts`

**Files:**
- Modify: `destincode/desktop/src/renderer/remote-shim.ts`

- [ ] **Step 1: Add the two methods in `theme.marketplace`**

Find the existing `theme.marketplace` block (which has `list`, `detail`, `install`, `uninstall`, `update`, `publish`, `generatePreview`). Add immediately after `generatePreview`:

```ts
resolvePublishState: (slug: string) =>
  invoke('theme-marketplace:resolve-publish-state', slug)
    .catch((err: any) => ({ kind: 'unknown', reason: err?.message ?? 'IPC failed' })),
refreshRegistry: () =>
  invoke('theme-marketplace:refresh-registry').catch(() => null),
```

- [ ] **Step 2: Verify typecheck**

Run: `cd destincode/desktop && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add destincode/desktop/src/renderer/remote-shim.ts
git commit -m "feat(themes): expose resolvePublishState + refreshRegistry on remote-shim"
```

---

## Task 10: ThemeDetail UI — render four states + optimistic flip + degraded mode

**Files:**
- Modify: `destincode/desktop/src/renderer/components/ThemeDetail.tsx`

- [ ] **Step 1: Replace the action-buttons block**

Replace the existing `{/* Install / Apply / Uninstall */}` action button block (currently lines 271-298 of `ThemeDetail.tsx`) with the version below. This adds publish-state derivation, optimistic flip, and the four state-specific buttons. The existing `isInstalled` check stays — install/apply/uninstall are unchanged for already-installed *community* themes.

```tsx
import type { PublishState } from '../../shared/theme-marketplace-types';

// ...inside the component, alongside the existing useState calls:
const [publishState, setPublishState] = useState<PublishState | null>(null);
const [publishing, setPublishing] = useState(false);

// Resolve publish state on mount (only for user-authored themes — `entry.source === 'destinclaude'`
// or community themes don't get a publish button).
const isUserAuthored = entry.source !== 'community';
useEffect(() => {
  if (!isUserAuthored) return;
  let cancelled = false;
  (async () => {
    const claude = (window as any).claude;
    const state = await claude?.theme?.marketplace?.resolvePublishState(entry.slug);
    if (!cancelled && state) setPublishState(state);
  })();
  return () => { cancelled = true; };
}, [entry.slug, isUserAuthored]);

const handlePublish = useCallback(async () => {
  setPublishing(true);
  setError(null);
  try {
    const claude = (window as any).claude;
    const result = await claude?.theme?.marketplace?.publish(entry.slug);
    if (result?.prUrl && result?.prNumber) {
      // Optimistic flip — don't wait for re-resolve
      setPublishState({ kind: 'in-review', prNumber: result.prNumber, prUrl: result.prUrl });
    } else {
      setError('Publish completed but no PR info returned. Check GitHub.');
    }
  } catch (err: any) {
    setError(err?.message || 'Publish failed');
  } finally {
    setPublishing(false);
  }
}, [entry.slug]);
```

And replace the action-buttons JSX block with:

```tsx
{/* Install / Apply / Uninstall (community themes) OR Publish state (user-authored) */}
{isUserAuthored ? (
  <PublishButton
    state={publishState}
    publishing={publishing}
    onPublish={handlePublish}
  />
) : (
  <div className="flex gap-2">
    {isInstalled ? (
      <>
        <button onClick={handleApply} className="flex-1 py-2 text-xs font-medium rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors">
          Apply Theme
        </button>
        <button onClick={handleUninstall} disabled={uninstalling} className="py-2 px-4 text-xs font-medium rounded-lg border border-edge-dim text-fg-muted hover:text-fg hover:border-edge transition-colors disabled:opacity-50">
          {uninstalling ? 'Removing...' : 'Uninstall'}
        </button>
      </>
    ) : (
      <button onClick={handleInstall} disabled={installing} className="flex-1 py-2 text-xs font-medium rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors disabled:opacity-50">
        {installing ? 'Installing...' : 'Install Theme'}
      </button>
    )}
  </div>
)}
```

Add the `PublishButton` subcomponent at the bottom of the file (above `OverlayPreviewStrip`):

```tsx
function PublishButton({
  state, publishing, onPublish,
}: { state: PublishState | null; publishing: boolean; onPublish: () => void }) {
  // Pre-resolution skeleton — usually < 200ms, no spinner to avoid flicker
  if (!state) {
    return (
      <div className="w-full py-2 text-xs rounded-lg border border-edge-dim text-fg-faint text-center">
        Checking publish status…
      </div>
    );
  }

  if (state.kind === 'unknown') {
    return (
      <div>
        <button
          onClick={onPublish}
          disabled={publishing}
          className="w-full py-2 text-xs font-medium rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors disabled:opacity-50"
          title={`Couldn't verify publish status — proceed at your own risk (${state.reason})`}
        >
          {publishing ? 'Publishing…' : '⚠ Publish to marketplace'}
        </button>
        <p className="text-[10px] text-fg-faint mt-1 text-center">
          Could not verify status: {state.reason}
        </p>
      </div>
    );
  }

  if (state.kind === 'in-review') {
    return (
      <a
        href={state.prUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="w-full py-2 text-xs font-medium rounded-lg border border-edge text-fg-muted text-center cursor-pointer hover:text-fg hover:border-edge-bright transition-colors block"
        title="Your submission is awaiting review. You'll see ✓ Published here once it's merged."
      >
        Pull request open · #{state.prNumber} ↗
      </a>
    );
  }

  if (state.kind === 'published-current') {
    return (
      <a
        href={state.marketplaceUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="w-full py-2 text-xs font-medium rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-500 text-center hover:bg-emerald-500/20 transition-colors block"
      >
        ✓ Published ↗
      </a>
    );
  }

  // published-drift
  return (
    <div className="space-y-1">
      <button
        onClick={onPublish}
        disabled={publishing}
        className="w-full py-2 text-xs font-medium rounded-lg bg-accent text-on-accent hover:brightness-110 transition-colors disabled:opacity-50"
      >
        {publishing ? 'Publishing update…' : 'Publish update'}
      </button>
      <p className="text-[10px] text-fg-faint text-center">
        Local changes not yet published
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Verify typecheck**

Run: `cd destincode/desktop && npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Verify build**

Run: `cd destincode/desktop && npm run build`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add destincode/desktop/src/renderer/components/ThemeDetail.tsx
git commit -m "feat(themes): publish-state-aware button in ThemeDetail (4 states + optimistic flip)"
```

---

## Task 11: Marketplace browser Refresh button

**Files:**
- Modify: `destincode/desktop/src/renderer/components/MarketplaceModal.tsx` (or whichever component renders the marketplace browser header — confirm via grep before editing)

- [ ] **Step 1: Confirm the file**

Run from the repo root: `grep -rln "theme.marketplace.list\|theme-marketplace:list" destincode/desktop/src/renderer/components/`
Use the result that renders the marketplace header (the file containing the search input and filter chips for browsing themes). If multiple files match, pick the one that actually renders a browser-style list view.

- [ ] **Step 2: Add a Refresh icon button next to the search/filter row**

Add a small icon button (use the project's existing icon convention — likely a Lucide `RefreshCw` import; check imports at the top of the file). Wire its onClick to:

```tsx
const handleRefresh = useCallback(async () => {
  setRefreshing(true);
  try {
    const claude = (window as any).claude;
    await claude?.theme?.marketplace?.refreshRegistry();
    await reloadList(); // call whatever method the component uses to re-render the list
  } finally {
    setRefreshing(false);
  }
}, [reloadList]);
```

```tsx
<button
  onClick={handleRefresh}
  disabled={refreshing}
  title="Refresh marketplace from GitHub"
  className="p-1.5 rounded-md text-fg-muted hover:text-fg hover:bg-well transition-colors disabled:opacity-50"
>
  <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
</button>
```

Add `const [refreshing, setRefreshing] = useState(false);` near the other useState calls. Add `RefreshCw` to the existing `lucide-react` import.

- [ ] **Step 3: Verify build**

Run: `cd destincode/desktop && npm run build`
Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add destincode/desktop/src/renderer/components/MarketplaceModal.tsx
git commit -m "feat(themes): manual refresh button in marketplace browser"
```

---

## Task 12: destinclaude-themes — propagate `contentHash` in registry rebuild

**Files:**
- Modify: `destinclaude-themes/scripts/build-registry.py`

This task ships as a separate PR to the destinclaude-themes repo. Create a worktree there: `git -C destinclaude-themes worktree add ../destinclaude-themes-contenthash`.

- [ ] **Step 1: Add contentHash to the entry**

In `build-registry.py`, find the dictionary literal `entry = { ... }` (around line 117). Add a `contentHash` line to the entry:

```python
entry = {
    "slug": slug,
    "name": manifest.get("name", slug),
    "author": author,
    "dark": manifest.get("dark", False),
    "description": manifest.get("description"),
    "preview": preview_url,
    "previewTokens": preview_tokens if len(preview_tokens) >= 5 else None,
    "version": manifest.get("version", "1.0.0"),
    "created": manifest.get("created"),
    "updated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
    "source": source,
    "features": detect_features(manifest),
    "manifestUrl": f"{REPO_BASE}/themes/{slug}/manifest.json",
    "assetUrls": collect_asset_urls(slug, theme_dir, manifest),
    "contentHash": manifest.get("contentHash"),  # propagated from publish; legacy entries: None
}
```

- [ ] **Step 2: Run the script locally to verify**

From the destinclaude-themes worktree:

```bash
python3 scripts/build-registry.py
```

Expected: `Registry rebuilt with N theme(s)`. Open `registry/theme-registry.json` — entries that have a `contentHash` in their `manifest.json` should now have a `contentHash` field; legacy entries should have `"contentHash": null`.

- [ ] **Step 3: Commit and PR**

```bash
git add scripts/build-registry.py
git commit -m "feat(registry): propagate contentHash from theme manifests"
```

Open a PR to `itsdestin/destinclaude-themes`. Title: `Propagate contentHash from theme manifests`. Body should reference the desktop spec at `destincode/desktop/docs/superpowers/specs/2026-04-12-theme-publish-lifecycle-design.md`.

---

## Task 13: Manual end-to-end verification

**Files:** none

- [ ] **Step 1: Create a throwaway test theme**

In the running app, create a new user theme named `lifecycle-test-<random>` with at least one wallpaper asset.

- [ ] **Step 2: Verify `draft` state**

Open the theme detail. Expected: button reads **"Publish to marketplace"**.

- [ ] **Step 3: Publish, verify optimistic flip**

Click publish. Expected within 5–10 seconds: the button replaces itself with **"Pull request open · #N ↗"**, links to the PR.

- [ ] **Step 4: Verify `in-review` survives reload**

Close and reopen the theme detail. Expected: still **"Pull request open · #N ↗"**.

- [ ] **Step 5: Merge the PR (manually on GitHub) and verify the merge bridge**

Within 5 minutes of merge: open the theme detail. Expected: still **"Pull request open · #N ↗"** (recently-merged PR bridges the registry-rebuild gap).

- [ ] **Step 6: Wait for CI rebuild + cache expiry, verify `published-current`**

Once the destinclaude-themes registry rebuild has run AND either 15 min has elapsed OR you've clicked the new Refresh button: open the theme detail. Expected: button replaced by green **"✓ Published ↗"** badge linking to the marketplace.

- [ ] **Step 7: Modify the local theme, verify `published-drift`**

Edit any token in the local manifest (or swap an asset). Reopen the theme detail. Expected: button reads **"Publish update"** with subtitle "Local changes not yet published".

- [ ] **Step 8: Publish the update, verify back to `in-review`**

Click "Publish update". Expected: optimistic flip back to **"Pull request open · #N ↗"** (a different PR number from the original).

- [ ] **Step 9: Verify degraded mode**

Run `gh auth logout` in a terminal. Restart the app. Open any user-authored theme detail. Expected: button reads **"⚠ Publish to marketplace"** with footer "Could not verify status: gh not authenticated". Re-auth (`gh auth login`) when done.

- [ ] **Step 10: Cleanup**

Delete the test theme locally. Close any test PRs on destinclaude-themes (or merge if they're harmless). Remove the test theme directory from the repo if it landed there.

- [ ] **Step 11: Commit nothing**

This task is verification. Any issues found → return to the relevant earlier task.

---

## Self-review checklist (perform before handing off for execution)

1. **Spec coverage** — every section of the spec has a corresponding task: state model (Tasks 4, 7), UI (Task 10), cache policy (Tasks 6, 7, 11), update flow (Task 6), registry schema change (Tasks 3, 6, 12), edge cases (Tasks 4, 10, 13), testing (Tasks 2, 4, 5, 13). ✓
2. **Placeholder scan** — no TBD, TODO, "fill in later", or generic "add error handling" steps. ✓
3. **Type consistency** — `PublishState` definition in Task 3 matches resolver in Task 4 matches consumer in Task 10. `PRRef` shape in Task 5 matches resolver inputs in Task 4. `publishTheme` return type updated in Task 6 (`{ prUrl, prNumber }`) is what Task 10's optimistic flip reads. ✓
4. **Each step is self-contained** — no "similar to Task N"; all code blocks shown in full. ✓
