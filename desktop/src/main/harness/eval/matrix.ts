// Test plan format and matrix expansion for the model-evaluation harness.
//
// WHY this module is self-contained (imports nothing from cases/ or
// assertions.ts, and takes knownCaseIds/knownModels as validatePlan
// parameters instead of looking them up itself): those live in a sibling
// task being built concurrently in another worktree. Keeping this module
// pure and dependency-free means it never has to reach for them, and it
// stays independently testable/mergeable regardless of that task's state.
// `crypto` is Node's own built-in (not a sibling task's module), so
// importing it for `cellFilename`'s hash does not violate this.
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

import { createHash } from 'node:crypto';

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
  // Fix pass 2 (2026-08-12 review): the hex-suffix scheme cellFilename used
  // to rely on was provably injective, but this uniqueness check is what
  // replaces that proof now that the suffix is a short, truncated hash
  // (astronomically unlikely to collide, not impossible). expandPlan is the
  // only place that ever sees the FULL cell set in one place, so it's the
  // only place that can turn "improbable" into "verified before any run
  // starts" -- at the cost of one extra pass over an array already built.
  assertUniqueFilenames(cells);
  return cells;
}

/** WHY this lives in expandPlan rather than being left to cellFilename
 *  callers to discover downstream: a collision here means two different
 *  cells would silently overwrite each other's result file mid-run, and the
 *  earliest possible point to catch that is right after the full cell set
 *  exists -- before any money is spent running either cell. */
function assertUniqueFilenames(cells: Cell[]): void {
  const seenBy = new Map<string, Cell>();
  for (const cell of cells) {
    const filename = cellFilename(cell);
    const existing = seenBy.get(filename);
    if (existing) {
      throw new Error(
        `Cell filename collision: "${existing.id}" and "${cell.id}" both produce filename `
        + `"${filename}". This should be astronomically unlikely with a 16-hex-char hash -- if `
        + 'it happens for real plan data (not a contrived test), the hash length in '
        + 'cellFilename needs to grow.',
      );
    }
    seenBy.set(filename, cell);
  }
}

// WHY each readable field is capped at MAX_FIELD_CHARS: a filename lands at
// docs/active/investigations/harness-eval-runs/<date>/<name>.json, and on
// Windows MAX_PATH is 260 characters for the WHOLE path, not just the
// filename. The old scheme (full hex-encoded id appended to an unbounded
// slug) measured ~214 characters for the bare filename alone on a realistic
// cell -- combined with an ~80-character directory prefix, that blew the
// budget outright. Capping every field means one unusually long case id or
// model label can no longer blow the budget by itself; the hash suffix
// below is fixed-length regardless of input size, so the whole filename now
// has a small, computable worst case (see the test for the exact bound).
const MAX_FIELD_CHARS = 20;

/** Filesystem-safe name for a cell (no extension). Follows the slugging
 *  convention already used in this repo for the same problem --
 *  `test-engine/review-harness.mjs`'s roster-label-to-transcript-filename
 *  slug: lowercase, then collapse every run of non-alphanumeric characters
 *  to a single '-'. Applied here to all five discriminating fields of the
 *  cell (not just a label), joined with '_', each capped to
 *  `MAX_FIELD_CHARS`.
 *
 *  WHY a short hash (not the old full-hex id) is appended, and why that's
 *  still safe (Fix pass 2, 2026-08-12 review): the slug transform is lossy
 *  by design (folds case, and collapses a literal '-', '_', '/', ' ', etc.
 *  all down to the same single '-'), so two DIFFERENT cells can produce an
 *  IDENTICAL slug -- e.g. a caseId of "a-b" and a caseId of "a_b" both slug
 *  to "a-b". The previous fix closed that gap by appending the full raw id
 *  hex-encoded, which is provably injective -- but hex doubles the id's
 *  length, and a realistic cell id measured ~214 characters as a bare
 *  filename that way, which alone exceeds Windows' 260-character whole-path
 *  budget once the directory prefix is added. That defeated the point of a
 *  function built specifically to be Windows-filename-safe. The fix here
 *  trades the *proof* of injectivity for a *short, fixed-length* digest (16
 *  hex chars of SHA-256, astronomically unlikely to collide but not
 *  impossible in principle) plus an actual check: `expandPlan` verifies
 *  every cell's filename is distinct across the whole matrix before
 *  returning it (see `assertUniqueFilenames`), which is what now guarantees
 *  correctness -- detected before any run starts, not just "probably fine". */
export function cellFilename(cell: Cell): string {
  const readable = [cell.caseId, cell.instructionsId, cell.model, cell.buildId, String(cell.repeat)]
    .map(slugPart)
    .join('_');
  const digest = createHash('sha256').update(cell.id, 'utf8').digest('hex').slice(0, 16);
  return `${readable}_${digest}`;
}

/** Lowercase, collapse every run of non-alphanumeric characters to a single
 *  '-', then cap to `MAX_FIELD_CHARS`. Mirrors
 *  `test-engine/review-harness.mjs`'s roster-label slug exactly for the
 *  first two steps, applied per-field here instead of to a whole label; the
 *  cap is new in Fix pass 2 to keep the Windows path budget. */
function slugPart(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, MAX_FIELD_CHARS);
}

/** Fix pass 2 (2026-08-12 review): the three duplicate-detection call sites
 *  below (cases, instruction arm ids, build ids) each spelled the same
 *  failure differently, and only the build-id one carried "Seen so far"
 *  context -- which is the part that actually helps a plan author spot the
 *  mistake in a long hand-edited list. One shared template means all three
 *  read the same way and all three get that context, instead of a future
 *  fourth duplicate-checked field inventing a fourth phrasing. */
function duplicateError(kind: string, value: string, seenSoFar: Iterable<string>): Error {
  const capitalizedKind = kind.charAt(0).toUpperCase() + kind.slice(1);
  return new Error(
    `Duplicate ${kind} ${describe(value)}. ${capitalizedKind}s must be unique within this plan. `
    + `Seen so far: ${[...seenSoFar].join(', ')}.`,
  );
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
      throw duplicateError('case id', caseId, seenCaseIds);
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
      throw duplicateError('instruction arm id', id, seenInstructionIds);
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
      throw duplicateError('model', model, seenModels);
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
        throw duplicateError('build id', buildId, seenBuildIds);
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
