// Test plan format and matrix expansion for the model-evaluation harness.
//
// WHY this module is self-contained (imports nothing from cases/ or
// assertions.ts, and takes knownCaseIds/knownModels as validatePlan
// parameters instead of looking them up itself): those live in a sibling
// task being built concurrently in another worktree. Keeping this module
// pure and dependency-free means it never has to reach for them, and it
// stays independently testable/mergeable regardless of that task's state.
//
// WHY expandPlan must be deterministic: a later task uses the cell id both
// as a filename and as a resume key, so the same plan must always produce
// the same cells in the same order across process runs.

export interface InstructionArm {
  id: string;
  file: string | null;
}

export interface BuildArm {
  id: string;
  dist: string;
}

export interface EvalPlan {
  name: string;
  cases: string[];
  instructions: InstructionArm[];
  models: string[]; // roster labels
  builds?: BuildArm[]; // default [{ id: 'current', dist: '.' }]
  judge?: string | null; // OpenRouter model id; null/absent = no judging
  repeats?: number; // default 1
}

export interface Cell {
  id: string; // stable: `${caseId}|${instructionsId}|${model}|${buildId}|${repeat}`
  caseId: string;
  instructionsId: string;
  model: string;
  buildId: string;
  dist: string;
  repeat: number;
}

const DEFAULT_BUILDS: BuildArm[] = [{ id: 'current', dist: '.' }];

/** Expand a validated plan into the ordered list of runs.
 *
 *  Order is cases → instructions → models → builds → repeats, outermost
 *  first, so a report generated in this order reads case-by-case. Pure and
 *  deterministic: no filesystem, no network, no clock, no randomness. */
export function expandPlan(plan: EvalPlan): Cell[] {
  const builds = plan.builds && plan.builds.length > 0 ? plan.builds : DEFAULT_BUILDS;
  const repeats = plan.repeats ?? 1;

  const cells: Cell[] = [];
  for (const caseId of plan.cases) {
    for (const instruction of plan.instructions) {
      for (const model of plan.models) {
        for (const build of builds) {
          for (let repeat = 0; repeat < repeats; repeat++) {
            cells.push({
              id: `${caseId}|${instruction.id}|${model}|${build.id}|${repeat}`,
              caseId,
              instructionsId: instruction.id,
              model,
              buildId: build.id,
              dist: build.dist,
              repeat,
            });
          }
        }
      }
    }
  }
  return cells;
}

/** Validate an untrusted, hand-editable plan (e.g. parsed from JSON) before
 *  any run is scheduled. This is the boundary between a hand-edited file
 *  and everything downstream, so every input shape is treated as suspect —
 *  not just the shapes the brief calls out. Every failure names both the
 *  bad value and the valid set, so a typo doesn't send the reader digging
 *  through source files for the right spelling. */
export function validatePlan(plan: unknown, knownCaseIds: string[], knownModels: string[]): EvalPlan {
  if (typeof plan !== 'object' || plan === null || Array.isArray(plan)) {
    throw new Error(`Plan must be an object, got ${describe(plan)}.`);
  }
  const p = plan as Record<string, unknown>;

  if (typeof p.name !== 'string' || p.name.length === 0) {
    throw new Error(`Plan "name" must be a non-empty string, got ${describe(p.name)}.`);
  }

  if (!Array.isArray(p.cases) || p.cases.length === 0) {
    throw new Error(`Plan "cases" must be a non-empty array, got ${describe(p.cases)}.`);
  }
  for (const caseId of p.cases) {
    if (typeof caseId !== 'string' || !knownCaseIds.includes(caseId)) {
      throw new Error(`Unknown case id ${describe(caseId)}. Known case ids: ${knownCaseIds.join(', ')}.`);
    }
  }

  if (!Array.isArray(p.instructions) || p.instructions.length === 0) {
    throw new Error(`Plan "instructions" must be a non-empty array, got ${describe(p.instructions)}.`);
  }
  const seenInstructionIds = new Set<string>();
  for (const instruction of p.instructions) {
    if (
      typeof instruction !== 'object'
      || instruction === null
      || typeof (instruction as Record<string, unknown>).id !== 'string'
      || (instruction as Record<string, unknown>).id === ''
    ) {
      throw new Error(`Every instruction arm needs a non-empty string "id", got ${describe(instruction)}.`);
    }
    const id = (instruction as InstructionArm).id;
    if (seenInstructionIds.has(id)) {
      throw new Error(`Duplicate instruction arm id ${describe(id)}. Instruction arm ids must be unique.`);
    }
    seenInstructionIds.add(id);
    const file = (instruction as Record<string, unknown>).file;
    if (file !== null && typeof file !== 'string') {
      throw new Error(`Instruction arm ${describe(id)} has an invalid "file": ${describe(file)}. Must be a string or null.`);
    }
  }

  if (!Array.isArray(p.models) || p.models.length === 0) {
    throw new Error(`Plan "models" must be a non-empty array, got ${describe(p.models)}.`);
  }
  for (const model of p.models) {
    if (typeof model !== 'string' || !knownModels.includes(model)) {
      throw new Error(`Unknown model ${describe(model)}. Known models: ${knownModels.join(', ')}.`);
    }
  }

  let builds: BuildArm[] | undefined;
  if (p.builds !== undefined) {
    if (!Array.isArray(p.builds) || p.builds.length === 0) {
      throw new Error(`Plan "builds" must be a non-empty array when present, got ${describe(p.builds)}.`);
    }
    const seenBuildIds = new Set<string>();
    for (const build of p.builds) {
      if (
        typeof build !== 'object'
        || build === null
        || typeof (build as Record<string, unknown>).id !== 'string'
        || (build as Record<string, unknown>).id === ''
        || typeof (build as Record<string, unknown>).dist !== 'string'
        || (build as Record<string, unknown>).dist === ''
      ) {
        throw new Error(`Every build arm needs a non-empty string "id" and "dist", got ${describe(build)}.`);
      }
      const id = (build as BuildArm).id;
      if (seenBuildIds.has(id)) {
        throw new Error(`Duplicate build id ${describe(id)}. Build ids must be unique. Seen so far: ${[...seenBuildIds].join(', ')}.`);
      }
      seenBuildIds.add(id);
    }
    builds = p.builds as BuildArm[];
  }

  let judge: string | null | undefined;
  if (p.judge !== undefined) {
    if (p.judge !== null && typeof p.judge !== 'string') {
      throw new Error(`Plan "judge" must be a string, null, or absent, got ${describe(p.judge)}.`);
    }
    judge = p.judge;
  }

  let repeats: number | undefined;
  if (p.repeats !== undefined) {
    if (typeof p.repeats !== 'number' || !Number.isInteger(p.repeats) || p.repeats < 1) {
      throw new Error(`Plan "repeats" must be a positive integer, got ${describe(p.repeats)}.`);
    }
    repeats = p.repeats;
  }

  return {
    name: p.name,
    cases: p.cases as string[],
    instructions: p.instructions as InstructionArm[],
    models: p.models as string[],
    ...(builds !== undefined ? { builds } : {}),
    ...(judge !== undefined ? { judge } : {}),
    ...(repeats !== undefined ? { repeats } : {}),
  };
}

/** Render an arbitrary value for embedding in an error message: strings get
 *  quoted so an empty/whitespace value is visible, everything else falls
 *  back to JSON (or String() for values JSON can't render, like undefined). */
function describe(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    const json = JSON.stringify(value);
    return json === undefined ? String(value) : json;
  } catch {
    return String(value);
  }
}
