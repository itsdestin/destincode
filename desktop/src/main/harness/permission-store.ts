// Remembered "Always allow" decisions (spec §2.4 layer 3 — permission-engine's
// rememberedRules input), scoped per project slug, persisted in
// ~/.youcoded/permissions.json. ALL writes go through NativeHome.mutateJson so
// the dev instance and built app (which share this home dir) can't clobber each
// other's writes — the mkdir-based file lock inside mutateJson is mandatory for
// ~/.youcoded/ JSON (native-home invariant). Reads use NativeHome.readJson
// (synchronous; null for a missing/corrupt file).
//
// WHY imported from transcript-watcher: the slug MUST match CC's project-dir
// encoding exactly (one function, one convention — see cwdToProjectSlug docs),
// same as session-store.ts does.
import { cwdToProjectSlug } from '../transcript-watcher';
import type { NativeHome } from '../native-home';
import { normalizeRule, sameRule } from '../../shared/permission-types';
import type { PermissionRule, StoredProject, StoredRule } from '../../shared/permission-types';

const FILE = 'permissions.json';
// One project's slice on disk. `cwd` and each rule's `grantedAt` are PROVENANCE —
// the permission engine never reads either; they exist so the management UI can
// show which folder a grant belongs to and when it was given. Both are optional
// because every rule written before the management UI existed has neither, and
// the file stays at v: 1 (a reader that tolerates missing keys needs no bump).
type PermEntry = { cwd?: string; rules: StoredRule[] };
type PermFile = { v: 1; projects: Record<string, PermEntry> };
const EMPTY: PermFile = { v: 1, projects: {} };

// SLUG COLLISIONS: cwdToProjectSlug collapses ':', '\\', '/', and spaces all to
// '-', so distinct paths can theoretically map to the same slug and share rules.
// This is inherited from CC's project-dir encoding deliberately — do NOT diverge
// here; the whole point of importing cwdToProjectSlug is one convention everywhere.
//
// UNBOUNDED GROWTH: rules per project accumulate without cap or eviction until
// the Phase 3 permission-management UI lets the user prune them — intentional.

export class PermissionStore {
  constructor(private home: NativeHome) {}

  /** Remembered rules for the project owning `cwd`, or [] if none stored. */
  async rulesFor(cwd: string): Promise<PermissionRule[]> {
    // readJson is synchronous and untyped (unknown | null); cast + default.
    const data = (this.home.readJson(FILE) as PermFile | null) ?? EMPTY;
    // Optional-chain `.projects` too: a hand-edited {} / [] / {"projects":null}
    // passes the cast but has no usable projects map — treat it as "nothing here".
    // normalizeRule: a rule written before this feature carries no `match` and
    // would otherwise be evaluated as a glob, which is how "always allow this
    // exact command" turned `rm *.log` into a wildcard grant. Reading it as
    // exact restores the promise the user was actually shown.
    return (data.projects?.[cwdToProjectSlug(cwd)]?.rules ?? []).map(normalizeRule);
  }

  /** Persist one remembered decision for `cwd`'s project, deduping exact repeats. */
  async remember(cwd: string, rule: PermissionRule): Promise<void> {
    const slug = cwdToProjectSlug(cwd);
    // Read-modify-write under the file lock — never a bare write.
    await this.home.mutateJson(FILE, (cur) => {
      const data = (cur as PermFile | null) ?? EMPTY;
      // Optional-chain `.projects` (see rulesFor) so a wrong-shape file rebuilds
      // instead of throwing. Spreading a missing/undefined projects below is safe
      // ({...undefined} === {}), so the write heals the shape on next persist.
      const rules = data.projects?.[slug]?.rules ?? [];
      // Identity is the QUAD (tool, pattern, action, match) — see sameRule, which
      // normalizes both sides so a legacy disk row compares in the semantics it
      // is actually evaluated with. grantedAt stays excluded: re-approving
      // something you already approved must not look like a fresh grant in the
      // management UI, so the original date stays pinned.
      const dup = rules.some((r) => sameRule(r, rule));
      if (!dup) rules.push({ ...rule, grantedAt: new Date().toISOString() });
      // Spread the existing entry, don't rebuild it: rebuilding as { rules }
      // silently drops the recorded cwd on the SECOND write to a project, and
      // the cwd is NOT recoverable from the slug.
      return { ...data, projects: { ...data.projects, [slug]: { ...(data.projects?.[slug] ?? {}), cwd, rules } } };
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
   * is what's on disk, and cwdToProjectSlug is lossy so there is no cwd to pass
   * for a legacy entry. Returns whether anything actually matched, so the caller
   * can tell the user their on-screen list was stale instead of claiming success.
   *
   * NOTE: this is DISK ONLY. A running session keeps its in-memory copy — callers
   * must go through NativeSessionHost.revokeRule, never here directly.
   */
  async remove(slug: string, rule: PermissionRule): Promise<boolean> {
    let hit = false;
    await this.home.mutateJson(FILE, (cur) => {
      const data = (cur as PermFile | null) ?? EMPTY;
      const entry = data.projects?.[slug];
      const rules = entry?.rules;
      // Nothing to remove: hand back a well-shaped file. mutateJson always
      // writes, so returning the healed shape beats writing back garbage.
      if (!entry || !Array.isArray(rules)) return data.projects ? data : EMPTY;
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
      return { ...data, projects: { ...data.projects, [slug]: { ...entry, rules: kept } } };
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
        return projects ? data : EMPTY;
      }
      hit = true;
      // Destructure-omit rather than `delete`: never mutate the value mutateJson
      // handed us — it re-serializes whatever we return, and an in-place delete
      // would also corrupt a retry's view of the file.
      const { [slug]: _dropped, ...rest } = projects;
      return { ...data, projects: rest };
    });
    return hit;
  }
}
