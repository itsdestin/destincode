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
import type { PermissionRule } from '../../shared/permission-types';

const FILE = 'permissions.json';
type PermFile = { v: 1; projects: Record<string, { rules: PermissionRule[] }> };
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
    return data.projects?.[cwdToProjectSlug(cwd)]?.rules ?? [];
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
      const dup = rules.some(
        (r) => r.tool === rule.tool && r.pattern === rule.pattern && r.action === rule.action
      );
      if (!dup) rules.push(rule);
      return { ...data, projects: { ...data.projects, [slug]: { rules } } };
    });
  }
}
