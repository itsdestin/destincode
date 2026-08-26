// ---------------------------------------------------------------------------
// TWO slug encodings, ON PURPOSE. Read this before "unifying" them.
//
// ccProjectSlug   — mirrors Claude Code's ~/.claude/projects/<slug>/ encoding
//                   bug-for-bug (extracted from the shipped CC 2.1.228 binary).
//                   Anything that READS or NAMES a directory CC created must
//                   use this. Its collisions are CC's collisions — never dedup.
// nativeStoreSlug — YouCoded's own FROZEN rule for app-private directories
//                   (~/.youcoded/sessions/<slug>/, permissions.json keys).
//                   Nothing external depends on it; changing it ORPHANS user
//                   data (native transcripts + remembered Always-allow rules).
//
// History: one shared function (the old transcript-watcher.ts slug helper)
// served both jobs and mirrored CC wrongly, twice (2026-04-23, 2026-08-11). Spec:
// docs/active/specs/2026-08-11-project-slug-encoding-repair.md.
// Guard: tests/slug-encoding.test.ts — anchored to directories a real CC
// created (tests/fixtures/cc-slug-pairs.json), never to this file's output.
//
// Version note (final review, MINOR fold): the rule below was recovered from
// the shipped CC 2.1.228 binary; tests/fixtures/cc-slug-pairs.json was
// independently regenerated against 2.1.229 — behavior is identical across
// both versions, so no divergence to reconcile.
// ---------------------------------------------------------------------------

export const CC_SLUG_MAX = 200;

// CC's rolling hash ((h<<5)-h+c | 0). NOTE: there is NO int32-min edge in JS —
// Math.abs takes a double, so Math.abs(-2147483648) === 2147483648 ("zik0zk").
// CC has no guard; adding one breaks the mirror. (Kotlin's mirror DOES need
// a Long widen — see CcProjectSlug.kt.)
export function ccHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

// Mirrors CC 2.1.228: every non-alphanumeric → '-'; slugs over 200 chars are
// truncated and suffixed with the base36 hash of the ORIGINAL path (not the
// slug). The drive-uppercase pre-step is OUR input normalization for
// YouCoded's canonicalizer emitting `c:/…` — NOT part of CC's rule. Do not
// delete it as "unfaithful": without it, project-filtered conversations and
// the Memory group come back EMPTY on Windows. The hash input is the
// drive-normalized string, deliberately: we hash what we pretend CC saw.
export function ccProjectSlug(cwd: string): string {
  const p = cwd.replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`);
  const slug = p.replace(/[^a-zA-Z0-9]/g, '-');
  return slug.length <= CC_SLUG_MAX ? slug : `${slug.slice(0, CC_SLUG_MAX)}-${ccHash(p)}`;
}

// FROZEN — the historical shared slug helper, renamed so its job is
// unmistakable. It names app-private dirs; changing it orphans
// ~/.youcoded/sessions transcripts and every remembered "Always allow" rule.
// It is NOT CC's rule and must never be "fixed" to match one.
export function nativeStoreSlug(cwd: string): string {
  return cwd
    .replace(/\\/g, '/')
    .replace(/:/g, '-')
    .replace(/\//g, '-')
    .replace(/ /g, '-');
}
