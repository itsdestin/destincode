// desktop/src/main/sync-spaces/materialization-planner.ts
// PURE decision core (no I/O — same pattern as resolve-local-project.ts,
// buildSavedFolderProjects, discoverContext). Given the synced registry + what's
// on this device, decide what to reconcile, and which spaces the engine should
// actually run.
import type { ProjectRegistryEntry } from './project-registry';
import type { SyncSpace } from './types';

export interface ReconcilePlan {
  toMaterialize: ProjectRegistryEntry[]; // active registry projects missing locally
  toStop: string[];                      // project names whose live space must detach
}

function spaceProjectName(s: SyncSpace): string {
  return s.id.startsWith('project:') ? s.id.slice('project:'.length) : '';
}

/** Reconcile the synced registry against local state.
 *  - toMaterialize: active + not local (deduped). Skipping already-local names
 *    avoids clobbering a live folder — a same-named local project already
 *    converges to the same repo via ensureRemote + the unrelated-histories merge.
 *  - toStop: stopped + currently live here (the mid-session case). A stopped
 *    project with no live space is already detached — nothing to do. */
export function planReconcile(
  registry: ProjectRegistryEntry[],
  localProjectNames: string[],
  liveSpaceNames: string[],
): ReconcilePlan {
  const local = new Set(localProjectNames);
  const live = new Set(liveSpaceNames);
  const seen = new Set<string>();
  const toMaterialize: ProjectRegistryEntry[] = [];
  const toStop: string[] = [];
  for (const e of registry) {
    if (seen.has(e.name)) continue;
    seen.add(e.name);
    if (e.state === 'stopped') {
      if (live.has(e.name)) toStop.push(e.name);
      continue;
    }
    if (!local.has(e.name)) toMaterialize.push(e);
  }
  return { toMaterialize, toStop };
}

/** The spaces the engine should run: everything EXCEPT project spaces whose
 *  registry record is `stopped`. Personal and unregistered project folders pass
 *  through. This is the single enforcement point for "stopped stays stopped" —
 *  route every raw `roots.spaces()` add/sync/backup loop through it (spec §7). */
export function activeManagedSpaces(
  registry: ProjectRegistryEntry[],
  spaces: SyncSpace[],
): SyncSpace[] {
  const stopped = new Set(registry.filter(e => e.state === 'stopped').map(e => e.name));
  return spaces.filter(s => s.kind !== 'project' || !stopped.has(spaceProjectName(s)));
}
