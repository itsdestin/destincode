// Test plan format and matrix expansion for the model-evaluation harness.
//
// WHY this module is self-contained (imports nothing from cases/ or
// assertions.ts, and takes knownCaseIds/knownModels as validatePlan
// parameters instead of looking them up itself): those live in a sibling
// task being built concurrently in another worktree. Keeping this module
// pure and dependency-free means it never has to reach for them, and it
// stays independently testable/mergeable regardless of that task's state.
//
// WHY expandPlan must be deterministic: a later task uses the cell id as a
// resume key, so the same plan must always produce the same cells in the
// same order across process runs.
//
// WHY `Cell.id` is not also the filename (Fix 2, 2026-08-12 review): `id` is
// the logical key -- `|`-joined, stable, fine to compare/store/resume by --
// but it can never double as a filesystem name. Two reasons, the second
// worse than the first: `|` is reserved on Windows (which this product
// ships on), AND `model` is a roster *label* (e.g. "Claude Opus 5", "Qwen
// 3.8 Max") which contains spaces, while a raw model id would contain `/`
// (e.g. "anthropic/claude-opus-5") -- so the id was never a valid filename
// on any platform, independent of which delimiter joins it. `cellFilename`
// below produces the filesystem-safe name; `id` and the slug are
// deliberately different strings serving different purposes.

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

/** Filesystem-safe name for a cell (no extension). Follows the slugging
 *  convention already used in this repo for the same problem --
 *  `test-engine/review-harness.mjs`'s roster-label-to-transcript-filename
 *  slug: lowercase, then collapse every run of non-alphanumeric characters
 *  to a single '-'. Applied here to all five discriminating fields of the
 *  cell (not just a label), joined with '_'.
 *
 *  WHY a hex suffix is appended rather than trusting the slug alone: the
 *  slug transform is lossy by design (folds case, and collapses a literal
 *  '-', '_', '/', ' ', etc. all down to the same single '-'), so two
 *  DIFFERENT cells can produce an IDENTICAL slug -- e.g. a caseId of "a-b"
 *  and a caseId of "a_b" both slug to "a-b". Hoping that never happens is
 *  exactly what the review asked us not to do. Appending
 *  `Buffer.from(cell.id, 'utf8').toString('hex')` closes the gap
 *  deterministically: hex encoding is byte-for-byte reversible (injective),
 *  so two different raw ids can never produce the same suffix, and `id` is
 *  already guaranteed unique per cell within one `expandPlan` call (the
 *  Fix-1 duplicate checks in `validatePlan`, plus `instructions`/`builds`
 *  already being duplicate-checked, mean every cell's 5-tuple is a distinct
 *  combination). So the filename is unique even in the exact case where the
 *  human-readable part collides -- provably, not just probably. */
export function cellFilename(cell: Cell): string {
  const readable = [cell.caseId, cell.instructionsId, cell.model, cell.buildId, String(cell.repeat)]
    .map(slugPart)
    .join('_');
  const suffix = Buffer.from(cell.id, 'utf8').toString('hex');
  return `${readable}_${suffix}`;
}

/** Lowercase, then collapse every run of non-alphanumeric characters to a
 *  single '-'. Mirrors `test-engine/review-harness.mjs`'s roster-label slug
 *  exactly, applied per-field here instead of to a whole label. */
function slugPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-');
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

  // Fix 3 (2026-08-12 review): '' was already rejected, but '   ' passed
  // through -- same blank-title hazard, just spelled with spaces instead of
  // zero characters. trim() catches both with the existing check.
  if (typeof p.name !== 'string' || p.name.trim().length === 0) {
    throw new Error(`Plan "name" must be a non-empty string, got ${describe(p.name)}.`);
  }

  if (!Array.isArray(p.cases) || p.cases.length === 0) {
    throw new Error(`Plan "cases" must be a non-empty array, got ${describe(p.cases)}.`);
  }
  // Fix 1 (2026-08-12 review): membership alone isn't enough -- ['a', 'a']
  // passed the old check, and expandPlan would then emit two cells sharing
  // one id, so one run's result silently clobbers the other's downstream.
  // Same duplicate-detection shape already used below for instructions/builds.
  const seenCaseIds = new Set<string>();
  for (const caseId of p.cases) {
    if (typeof caseId !== 'string' || !knownCaseIds.includes(caseId)) {
      throw new Error(`Unknown case id ${describe(caseId)}. Known case ids: ${knownCaseIds.join(', ')}.`);
    }
    if (seenCaseIds.has(caseId)) {
      throw new Error(`Duplicate case id ${describe(caseId)}. Plan "cases" must not repeat a case.`);
    }
    seenCaseIds.add(caseId);
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
  // Fix 1 (2026-08-12 review): same duplicate hazard as "cases" above --
  // ['M1', 'M1'] validated fine and produced two byte-identical cell ids.
  const seenModels = new Set<string>();
  for (const model of p.models) {
    if (typeof model !== 'string' || !knownModels.includes(model)) {
      throw new Error(`Unknown model ${describe(model)}. Known models: ${knownModels.join(', ')}.`);
    }
    if (seenModels.has(model)) {
      throw new Error(`Duplicate model ${describe(model)}. Plan "models" must not repeat a model.`);
    }
    seenModels.add(model);
  }

  let builds: BuildArm[] | undefined;
  if (p.builds !== undefined) {
    if (!Array.isArray(p.builds) || p.builds.length === 0) {
      throw new Error(`Plan "builds" must be a non-empty array when present, got ${describe(p.builds)}.`);
    }
    const seenBuildIds = new Set<string>();
    for (const build of p.builds) {
      // Fix 3 (2026-08-12 review): name which field is wrong instead of
      // dumping the whole object -- matches the precision the case/model
      // messages already have, instead of leaving the reader to spot which
      // of two fields is the problem.
      if (typeof build !== 'object' || build === null) {
        throw new Error(`Every build arm must be an object with "id" and "dist", got ${describe(build)}.`);
      }
      const buildId = (build as Record<string, unknown>).id;
      if (typeof buildId !== 'string' || buildId === '') {
        throw new Error(`Build arm has an invalid "id": ${describe(buildId)}. Must be a non-empty string.`);
      }
      const dist = (build as Record<string, unknown>).dist;
      if (typeof dist !== 'string' || dist === '') {
        throw new Error(`Build arm ${describe(buildId)} has an invalid "dist": ${describe(dist)}. Must be a non-empty string.`);
      }
      if (seenBuildIds.has(buildId)) {
        throw new Error(`Duplicate build id ${describe(buildId)}. Build ids must be unique. Seen so far: ${[...seenBuildIds].join(', ')}.`);
      }
      seenBuildIds.add(buildId);
    }
    builds = p.builds as BuildArm[];
  }

  let judge: string | null | undefined;
  if (p.judge !== undefined) {
    // Fix 3 (2026-08-12 review): same blank-value class as "name" above,
    // applied asymmetrically before -- '' silently passed as a "judge model
    // id" that would 400 far downstream at the actual judge call. null stays
    // valid; it's the explicit "no judging" spelling, not a blank string.
    if (p.judge !== null && (typeof p.judge !== 'string' || p.judge.trim().length === 0)) {
      throw new Error(`Plan "judge" must be a non-empty string, null, or absent, got ${describe(p.judge)}.`);
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
