// Specialist naming (Task 8) — a small easter egg: instead of a bare role
// label, each specialist child gets an alliterative fun title ("Rowan the
// Relentless Researcher"), so several children of the same role showing up
// in one conversation read as distinct characters, not interchangeable
// copies. The first-name pool is shared across roles (spec: names alone
// don't say what the specialist DOES, so there's no reason to segregate the
// pool by role); the descriptor pool alliterates per role and is what
// actually signals "explorer" vs "worker" at a glance.
//
// Draw is WITHOUT REPLACEMENT: the caller (NativeSessionHost.createChild)
// owns a `taken` set of already-used first names, scoped per PARENT session
// and cleared when the parent tears down (see native-session-host.ts). This
// module never crashes when a pool empties — it falls back to a numbered
// title instead, so a parent that spawns more specialists than there are
// names still gets a coherent (if less whimsical) result.
import namePools from './name-pools.json';

interface NamePools {
  firstNames: string[];
  descriptors: Record<string, string[]>;
}

const POOLS = namePools as NamePools;

// Human-facing role label for the title's tail — mirrors
// SpecialistDefinition.displayName in registry.ts, but this module
// deliberately does not import the registry (no reason to couple a naming
// easter egg to the specialist-definition module; agentType strings are the
// only thing they need to agree on, and the registry test suite pins those).
const ROLE_LABELS: Record<string, string> = {
  explorer: 'Explorer',
  researcher: 'Researcher',
  reviewer: 'Reviewer',
  worker: 'Worker',
};

// Pool exhaustion point: once every first name in the shared pool is taken,
// assignSpecialistName falls back to a numbered title. Exported so tests (and
// anything curious) can drive exactly to — and past — that boundary without
// hardcoding the pool's size.
export const POOL_SIZE = POOLS.firstNames.length;

export function assignSpecialistName(agentType: string, taken: Set<string>): { name: string; title: string } {
  const role = ROLE_LABELS[agentType] ?? agentType;
  const descriptors = POOLS.descriptors[agentType] ?? POOLS.descriptors.worker;
  const available = POOLS.firstNames.filter((n) => !taken.has(n));

  if (available.length > 0) {
    const name = available[Math.floor(Math.random() * available.length)];
    const descriptor = descriptors[Math.floor(Math.random() * descriptors.length)];
    return { name, title: `${name} the ${descriptor} ${role}` };
  }

  // FALLBACK: the shared pool is exhausted for this parent. Never crash, never
  // repeat a first name — count from the size of `taken` (which the caller
  // grows by one per assignment, fallback names included) so consecutive
  // overflow calls under the same parent keep numbering upward instead of
  // colliding on the same fallback title.
  const n = taken.size + 1;
  const title = `${role} ${n}`;
  return { name: title, title };
}
