// Remembered "Always allow" decisions (spec §2.4 layer 3 — permission-engine's
// rememberedRules input), scoped per project slug, persisted in
// ~/.youcoded/permissions.json. ALL writes go through NativeHome.mutateJson so
// the dev instance and built app (which share this home dir) can't clobber each
// other's writes — the mkdir-based file lock inside mutateJson is mandatory for
// ~/.youcoded/ JSON (native-home invariant). Reads use NativeHome.readJson
// (synchronous; null for a missing/corrupt file).
//
// WHY nativeStoreSlug (NOT the CC mirror): this file keys
// ~/.youcoded/permissions.json, which nothing external reads. Routing it to
// ccProjectSlug would silently re-key every project and DROP every remembered
// "Always allow" rule. Frozen on purpose — see slug-encoding.ts.
import { nativeStoreSlug } from '../slug-encoding';
import type { NativeHome } from '../native-home';
import { normalizeRule, sameRule, isCrossProjectRule, CROSS_PROJECT_SLUG } from '../../shared/permission-types';
import type { StoredProject, StoredRule } from '../../shared/permission-types';

const FILE = 'permissions.json';
// One project's slice on disk. `cwd` and each rule's `grantedAt` are PROVENANCE —
// the permission engine never reads either; they exist so the management UI can
// show which folder a grant belongs to and when it was given. Both are optional
// because every rule written before the management UI existed has neither.
type PermEntry = { cwd?: string; rules: StoredRule[] };
// Task 11: the file's first-ever version branch — v2 adds `specialist` onto
// each StoredRule (one axis of the QUINT identity in sameRule — `match` is the
// other addition to the identity, but it never needed a version bump: a
// match-less rule reads as 'exact' via normalizeRule, no migration required).
// A v1 file is valid v2 AS-IS: every rule on it simply has no `specialist` key,
// exactly like a rule with no `grantedAt` — nothing here needs a migration
// step, only a version STAMP.
// The reader accepts either; every WRITE (remember/remove/removeProject, all
// funnelled through mutateJson below) stamps v:2 regardless of what it read,
// so a file only ever moves forward.
type PermFile = { v: 1 | 2; projects: Record<string, PermEntry> };
const EMPTY: PermFile = { v: 2, projects: {} };

// SLUG COLLISIONS: nativeStoreSlug collapses ':', '\\', '/', and spaces all to
// '-', so distinct paths can theoretically map to the same slug and share rules.
// The collapse behavior is FROZEN app-private convention (slug-encoding.ts's
// nativeStoreSlug) — it no longer claims to match CC. Do not re-point at the
// CC mirror: that orphans every stored rule.
//
// UNBOUNDED GROWTH: rules per project accumulate without cap or eviction until
// the Phase 3 permission-management UI lets the user prune them — intentional.

export class PermissionStore {
  constructor(private home: NativeHome) {}

  /** Remembered rules that apply at `cwd`: the CROSS-PROJECT bucket plus the
   *  project's own, or [] if neither is stored.
   *
   *  D2 fix (2026-08-26): the bucket is what makes "applies in every project"
   *  true. Before it, a `user`-scoped specialist grant was written under the
   *  slug of whichever folder happened to be open when it was approved, so the
   *  card's promise, describeRule's wording and the docs were all false — the
   *  next project asked again. See isCrossProjectRule (shared/permission-types)
   *  for which rules land there and why the subject is the discriminator. */
  async rulesFor(cwd: string): Promise<StoredRule[]> {
    // readJson is synchronous and untyped (unknown | null); cast + default.
    const data = (this.home.readJson(FILE) as PermFile | null) ?? EMPTY;
    // Optional-chain `.projects` too: a hand-edited {} / [] / {"projects":null}
    // passes the cast but has no usable projects map — treat it as "nothing here".
    // normalizeRule: a rule written before this feature carries no `match` and
    // would otherwise be evaluated as a glob, which is how "always allow this
    // exact command" turned `rm *.log` into a wildcard grant. Reading it as
    // exact restores the promise the user was actually shown.
    // Bucket FIRST, then this project's own. Order is only about last-match-wins
    // in the engine, and both sides are allow rules for different subjects, so a
    // tie is harmless — the same reasoning as buildDecide's disk/memory union.
    return [
      ...(data.projects?.[CROSS_PROJECT_SLUG]?.rules ?? []),
      ...(data.projects?.[nativeStoreSlug(cwd)]?.rules ?? []),
    ].map(normalizeRule);
  }

  /** Persist one remembered decision, deduping exact repeats. Filed under
   *  `cwd`'s project — EXCEPT a cross-project rule, which is filed under the
   *  reserved bucket instead so every project reads it (D2). */
  async remember(cwd: string, rule: StoredRule): Promise<void> {
    // The rule's own subject decides where it lives (isCrossProjectRule) —
    // nothing extra is threaded in, so a rule read back off disk can never
    // disagree with the bucket it is sitting in.
    const crossProject = isCrossProjectRule(rule);
    const slug = crossProject ? CROSS_PROJECT_SLUG : nativeStoreSlug(cwd);
    // Read-modify-write under the file lock — never a bare write.
    await this.home.mutateJson(FILE, (cur) => {
      const data = (cur as PermFile | null) ?? EMPTY;
      // Optional-chain `.projects` (see rulesFor) so a wrong-shape file rebuilds
      // instead of throwing. Spreading a missing/undefined projects below is safe
      // ({...undefined} === {}), so the write heals the shape on next persist.
      const rules = data.projects?.[slug]?.rules ?? [];
      // Identity is the QUINT (tool, pattern, action, match, specialist) — see
      // sameRule, which normalizes both sides so a legacy disk row compares in
      // the semantics it is actually evaluated with. `specialist` joined the
      // identity in Task 11: without it, a specialist-keyed grant for the same
      // (tool, pattern, action) as an existing ROOT grant (or a different
      // specialist's grant) would silently merge into one entry, discarding
      // whichever grant lost the race — exactly the cross-scope leak this axis
      // exists to prevent. grantedAt stays excluded: re-approving something you
      // already approved must not look like a fresh grant in the management UI,
      // so the original date stays pinned.
      const dup = rules.some((r) => sameRule(r, rule));
      if (!dup) rules.push({ ...rule, grantedAt: new Date().toISOString() });
      // Spread the existing entry, don't rebuild it: rebuilding as { rules }
      // silently drops the recorded cwd on the SECOND write to a project, and
      // the cwd is NOT recoverable from the slug. `v: 2` unconditionally: this
      // file's first-ever version branch (Task 11) — every write moves a v1
      // file forward, never backward.
      // The bucket is NOT a folder, so it never records a cwd — writing the
      // folder that happened to be open when the grant was given would make
      // Settings print a path under a card that applies everywhere, which is
      // exactly the false-scope claim this bucket exists to end.
      const entry = { ...(data.projects?.[slug] ?? {}), ...(crossProject ? {} : { cwd }), rules };
      return { ...data, v: 2, projects: { ...data.projects, [slug]: entry } };
    });
  }

  /** Every project that has remembered rules, for the management UI. */
  async list(): Promise<StoredProject[]> {
    const data = (this.home.readJson(FILE) as PermFile | null) ?? EMPTY;
    const projects = data.projects;
    // A hand-edited {"projects":null} / [] passes the cast but has no usable map.
    // Object.entries(null) THROWS, so guard before iterating — same
    // tolerate-wrong-shape contract rulesFor() already has.
    if (!projects || typeof projects !== 'object') return [];
    return Object.entries(projects).map(([slug, entry]) => ({
      slug,
      // Omit the key entirely rather than emitting `cwd: undefined`: absent means
      // "never recorded", which the UI states plainly instead of guessing a path
      // back out of the lossy slug.
      ...(entry?.cwd !== undefined ? { cwd: entry.cwd } : {}),
      // Normalized for the same reason rulesFor() normalizes: the screen must
      // describe a legacy rule the way the engine now evaluates it, and the
      // renderer round-trips these objects straight back into remove().
      rules: (entry?.rules ?? []).map(normalizeRule),
    }));
  }

  /**
   * Delete one remembered rule from a project. Keys by SLUG, not cwd — the slug
   * is what's on disk, and nativeStoreSlug is lossy so there is no cwd to pass
   * for a legacy entry. Returns whether anything actually matched, so the caller
   * can tell the user their on-screen list was stale instead of claiming success.
   *
   * NOTE: this is DISK ONLY. A running session keeps its in-memory copy — callers
   * must go through NativeSessionHost.revokeRule, never here directly.
   */
  async remove(slug: string, rule: StoredRule): Promise<boolean> {
    let hit = false;
    await this.home.mutateJson(FILE, (cur) => {
      const data = (cur as PermFile | null) ?? EMPTY;
      const entry = data.projects?.[slug];
      const rules = entry?.rules;
      // Nothing to remove: hand back a well-shaped file, still stamped v:2 —
      // mutateJson always writes, so returning the healed shape beats writing
      // back garbage (and this IS a write, so the version stamp still moves).
      if (!entry || !Array.isArray(rules)) return data.projects ? { ...data, v: 2 } : EMPTY;
      // Same identity as remember()'s dedupe (sameRule, Task 11) — a
      // specialist-keyed rule and an otherwise-identical root/other-specialist
      // rule are DIFFERENT rules, so revoking one must never also remove the other.
      const kept = rules.filter((r) => {
        // sameRule normalizes both sides. The renderer round-trips what list()
        // gave it (already normalized) against disk rows that are not, and an
        // un-normalized comparison here would silently fail to remove every
        // rule written before this feature existed.
        const match = sameRule(r, rule);
        if (match) hit = true;
        return !match;
      });
      // Spread the entry so the recorded cwd survives a removal.
      return { ...data, v: 2, projects: { ...data.projects, [slug]: { ...entry, rules: kept } } };
    });
    return hit;
  }

  /** Delete a project's whole slice (the "clear all for this folder" control). */
  async removeProject(slug: string): Promise<boolean> {
    let hit = false;
    await this.home.mutateJson(FILE, (cur) => {
      const data = (cur as PermFile | null) ?? EMPTY;
      const projects = data.projects;
      if (!projects || typeof projects !== 'object' || !(slug in projects)) {
        return projects ? { ...data, v: 2 } : EMPTY;
      }
      hit = true;
      // Destructure-omit rather than `delete`: never mutate the value mutateJson
      // handed us — it re-serializes whatever we return, and an in-place delete
      // would also corrupt a retry's view of the file.
      const { [slug]: _dropped, ...rest } = projects;
      return { ...data, v: 2, projects: rest };
    });
    return hit;
  }
}
