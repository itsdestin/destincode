// Lookup surface for specialist definitions. Task 4 scope is the four built-ins
// as pure data (builtins.ts); file-based custom specialists are a later task —
// this module's shape (a lookup by id, plus an enumeration for the Task tool's
// enum) is written so that a future file-based provider can be merged in here
// without callers (Task 5, Task 6) changing how they call it.
import { BUILTIN_SPECIALISTS } from './builtins';

export interface SpecialistDefinition {
  id: string;                       // 'explorer' | 'worker' | 'reviewer' | 'researcher' | future file-based ids
  displayName: string;              // "Explorer"
  description: string;              // one-line, model-facing (Task tool enum docs)
  systemPrompt: string;             // definition body
  allowedTools: string[];           // native tool names; NEVER includes 'Task' (depth-by-omission)
  charter: 'read-only' | 'read-write';  // renders on the launch card; drives permission cap
  // Task 14: 'budget'/'frontier' name the user-designated tiers (Settings, 1c
  // ships the UI) — renamed from the earlier 'cheap'/'strongest' vocabulary,
  // which implied the app itself judged price/strength; it never has. The
  // field stays declared-but-never-read here (every BUILTIN_SPECIALISTS entry
  // omits it — see builtins.ts), so the rename is free: nothing on master
  // reads this field yet. delegated-models.ts's resolveRequestedModel (called
  // from tools/task.ts) is the first reader.
  modelPreference?: 'parent' | 'budget' | 'frontier';
  stepCap: number;                  // wired to the child's harness.limits.maxSteps (Task 5)
  reportBudgetTokens: number;       // static half of the headroom-aware cap (Task 7)
}

// Indexed once at module load rather than re-scanning BUILTIN_SPECIALISTS on
// every lookup — this list is small and static today, but resolveSpecialist is
// called once per Task-tool invocation and there's no reason to pay O(n) for it.
const BY_ID = new Map<string, SpecialistDefinition>(BUILTIN_SPECIALISTS.map((d) => [d.id, d]));

export function resolveSpecialist(id: string): SpecialistDefinition | undefined {
  return BY_ID.get(id);
}

export function listSpecialists(): SpecialistDefinition[] {
  return BUILTIN_SPECIALISTS;
}
