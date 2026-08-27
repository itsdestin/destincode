import type { SpecialistRunView } from '../../../shared/types';

/** Specialists 1c: run records the seeded conversation fixture declared, keyed
 *  by childId, so the mock `specialists.interrupt` can flip the right one.
 *  Populated by seed-chat.ts as it replays `specialist_run` lines. Its own
 *  module (not mock-shim.ts) so seed-chat ↔ mock-shim never import each other. */
export const RUNS = new Map<string, SpecialistRunView>();
