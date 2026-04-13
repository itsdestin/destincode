# Theme Publish Lifecycle — Design

**Date:** 2026-04-12
**Status:** Draft — pending user review

## Problem

The "Publish to marketplace" button on a user-authored theme is stateless. It reads the same way whether you have never submitted the theme, have an open pull request under review, have already been merged into the registry, or have unpublished local tweaks on top of a published theme. Consequences:

- Users click "Publish" again because nothing changed after the first click — opening duplicate PRs.
- Users can't tell whether a previous submission landed.
- The in-memory registry cache (15 min TTL) is never invalidated after a publish, so even when the registry does update the app serves stale data.
- There is no path to push a small update to an already-published theme — the button either works for the first-time case or not at all.

## Objective

The publish affordance should always reflect where a theme stands relative to the marketplace, so the user never has to guess whether their work landed and never fires a duplicate submission by accident.

## Non-goals

- Cross-device session sync beyond what naturally falls out of deriving state from GitHub + the registry.
- Managing the review lifecycle inside DestinCode (approving/rejecting PRs — that stays on GitHub).
- Editing a published theme directly in the registry UI.
- Handling theme renames gracefully. A renamed theme re-enters the `draft` state and the old registry entry is orphaned. Acceptable for v1.

## State model

State is derived from three lookups, keyed on `(githubHandle, slug)`. No local "I published this" flag is persisted.

| State | Detection | Button |
|-------|-----------|--------|
| `draft` | not in registry AND no open PR | **Publish to marketplace** (active) |
| `in-review` | open PR exists for this slug by this author | **Pull request open · #N ↗** (disabled, links to PR) |
| `published-current` | in registry under this author AND content hash matches | **✓ Published ↗** badge (replaces button, links to marketplace) |
| `published-drift` | in registry under this author AND content hash differs | **Publish update** (active) |

### Lookup details

1. **Registry lookup** — uses the existing `fetchRegistry()` path in `theme-marketplace-provider.ts`. Match: `entry.slug === localSlug && entry.author === myHandle`.
2. **Open PR lookup** — new helper `listOpenThemePRs(slug, author)` that shells out to `gh pr list --repo itsdestin/destinclaude-themes --author @me --state open --search "<slug>" --json number,url,state`. Cached per-session for 60s.
3. **Recently-merged PR lookup** — same command with `--state merged --search "<slug> merged:>=<now-5min>"`. Used only to bridge the short window between merge and registry CI finishing; prevents a false `draft` flicker.
4. **Content drift** — local hash computed from `sha256(manifest.json + sorted asset bytes)`. Compared against `contentHash` stored on the registry entry. Entries without `contentHash` (pre-existing) are treated as matching — zero false positives on legacy themes.

### Pure resolver

The state transition itself is a pure function:

```ts
function resolvePublishState(inputs: {
  registryEntry: ThemeRegistryEntry | null,
  openPR: { number: number, url: string } | null,
  recentlyMergedPR: { number: number, url: string } | null,
  localHash: string,
}): PublishState
```

Unit-tested exhaustively. Everything else is plumbing.

## UI

The button lives in `ThemeDetail.tsx` and the "My Themes" list row actions. Rendered per state as described in the table above.

- **Optimistic flip on publish success.** When `publishTheme()` resolves, the UI flips to `in-review` immediately using the returned PR number/URL. The background PR-status cache is invalidated so the reconciling lookup agrees.
- **Skeleton while lookups resolve** on detail open (not a spinner — usually <200ms and a spinner flickers).
- **Degraded-mode warning icon** when `gh pr list` fails (offline, gh not authed). Falls back to `draft` with a tooltip noting the status couldn't be verified. Better to let the user try than to block.
- **No `published-current` button** — the badge replaces the button entirely. Signals completion; nothing to do.
- **Manual Refresh icon** in the marketplace browser header as a safety valve against the 15-min cache. Calls `invalidateRegistryCache()` + re-lists.

## Cache policy

**Registry cache** (`theme-marketplace-provider.ts`):
- Existing 15-min TTL retained.
- New `invalidateRegistryCache()` method, called at the end of `publishTheme()` on success.
- Manual Refresh button calls the same method.

**PR-status cache** (new):
- In-memory per-session, keyed `(slug, author)`, 60s TTL.
- Invalidated at the end of `publishTheme()` on success.
- Not persisted across restarts.

**Content-hash drift** is not cached — computed from local files on every detail open.

## Update flow

When the user clicks **Publish update** (only surfaced in `published-drift`):

- `publishTheme()` receives the existing registry entry as a hint.
- PR title: `Update theme: <name>` (vs. `Add theme: <name>` for new entries).
- Branch: `update-theme-<slug>-<timestamp>`.
- Body: notes that this is an update; links to existing registry entry.
- Files: same layout as first publish — the destinclaude-themes CI regenerates `theme-registry.json` from `themes/<slug>/manifest.json` on merge, so "update" is literally "replace files in the same directory."
- Recomputed `contentHash` is written into the manifest so drift clears after merge.

## Registry schema change

Add a single optional field to each theme registry entry:

```json
{
  "slug": "sunset",
  "author": "alice",
  "...": "existing fields",
  "contentHash": "sha256:a1b2c3..."
}
```

- Populated by `publishTheme()` when writing the manifest PR.
- Regenerated by destinclaude-themes CI (`update-registry.yml`) when rebuilding `theme-registry.json`.
- Missing field on legacy entries → drift check short-circuits to "matches". No backfill needed.

## Edge cases

| Case | Behavior |
|------|----------|
| User not `gh` authed | PR lookups fail → degraded-mode warning icon, button falls back to `draft`. Publish itself surfaces existing "run `gh auth login`" error. |
| Slug collision across authors | CI on destinclaude-themes rejects. App surfaces the CI error. No special UI state. |
| Theme renamed locally after publish | Slug changes → registry lookup misses → state flips to `draft`. Old registry entry orphaned; user deletes manually. v1 acceptable. |
| Another user's theme with same slug in registry | Registry lookup requires `author === myHandle`, so ignored. |
| PR merged but CI not yet rebuilt | Recently-merged PR lookup bridges the window; state shows `in-review` with copy "Merging — registry updating" until registry catches up. |
| Publish call fails mid-flight | Existing error toast; state stays `draft`. No partial-state to clean up. |

## Testing

- **Unit:** `resolvePublishState` — every combination of (registry hit/miss) × (open PR yes/no) × (merged PR yes/no) × (hash match/mismatch).
- **Unit:** content-hash computation — stable across file order, detects manifest edits, detects asset edits.
- **Integration:** mock registry fetch + `gh pr list` + content hash; assert each state renders the expected button.
- **Manual end-to-end:** publish a throwaway theme to a fork of destinclaude-themes; walk the full `draft → in-review → published-current → published-drift` lifecycle.

## Affected files

- `destincode/desktop/src/main/theme-marketplace-provider.ts` — add `invalidateRegistryCache()`, add `listOpenThemePRs()`, add content-hash computation, add `existingEntry` param to `publishTheme()`, write `contentHash` into PR manifest.
- `destincode/desktop/src/main/ipc-handlers.ts` — expose `themes:resolve-publish-state` and `themes:refresh-registry` channels.
- `destincode/desktop/src/main/preload.ts` + `src/renderer/remote-shim.ts` — parity additions for the new channels. Android bridge (SessionService.kt) parity is deferred: the publish flow depends on `gh` CLI which is desktop-focused today. On Android, the new states render as read-only (detail view shows correct state; publish/update buttons are absent). Revisit when/if Android-side publish is in scope.
- `destincode/desktop/src/renderer/components/ThemeDetail.tsx` — render the four states, optimistic flip, degraded-mode warning.
- `destincode/desktop/src/renderer/components/` — Marketplace browser header gets a Refresh icon.
- `destincode/desktop/src/renderer/state/publish-state-resolver.ts` — new pure resolver + tests.
- `destinclaude-themes/.github/workflows/update-registry.yml` — preserve/propagate `contentHash` when rebuilding `theme-registry.json`.

## Open questions

None known at spec time.
