// The report: the one page a non-developer reads to decide whether a block of
// guidance actually changed how models write.
//
// WHY it is PURE (a string in, a string out, no filesystem, no clock, no
// network): the same property append-review.ts has, for the same reason. "This
// never disturbs an earlier result" and "the same run always renders the same
// page" are assertable in a unit test rather than habits the runner is trusted
// to keep. The orchestrator (test-engine/harness-eval.mjs) does the writing.
//
// WHY the layout is what it is: the reader paid real money for these runs and
// has to be able to (a) see the answer at a glance and (b) check any single
// claim in about five seconds without opening a transcript. So: a grid of
// tasks x instruction arms per model, then every model's full written answer
// verbatim, then a pointer to the raw conversations on disk. Every grade
// carries the quote it was based on, spelled exactly as the answer spells it,
// so Ctrl-F finds it.
//
// SEVEN THINGS THIS FILE REFUSES TO HIDE — each is here because something went
// wrong earlier in this project:
//   1. A check that never ran is NOT a check that passed. `never ran` is
//      rendered as its own state, never folded into a pass or a failure.
//   2. A run whose grades were ALL discarded is ungraded, and says so. An
//      empty grade list must never read as "no issues found".
//   3. Judge warnings print ABOVE the grades and are never averaged into a
//      score — including the contradiction warnings, which are heuristic and
//      can be wrong in a way a reader can see and dismiss.
//   4. Self-grading (the judge model is also under test) is flagged on the
//      rows it affects.
//   5. Every grade prints its verbatim quote.
//   6. A combination that never ran is NAMED. Silence reads as success.
//   7. The stated limits print unconditionally: one run per combination is
//      noise, not evidence, and there is no resume.
import type { Cell, EvalPlan } from './matrix';
import { cellFilename } from './matrix';
import type { CaseRun, CheckResult } from './case-types';
import type { JudgeResult } from './judge';
import { JUDGE_SCALE_MAX } from './judge';
import type { RunFacts } from './run-facts';
import { renderRunFacts } from './run-facts';

/** Everything the report knows about one cell of the matrix.
 *
 *  WHY the graded parts are all optional: a cell can fail at any point along
 *  the chain (the worker never started, the run errored, the checks could not
 *  be evaluated, the judge 402'd), and each of those is a DIFFERENT sentence
 *  in the report. Collapsing them into one "no data" shape is exactly how a
 *  402 gets rendered as a green row. */
export interface CellResult {
  cell: Cell;
  /** The finished run, or null/absent when the cell produced none. */
  run?: CaseRun | null;
  /** The REAL failure text from the orchestrator, never a guess. */
  error?: string;
  timedOut?: boolean;
  /** Mechanical checks, three-state (`passed` / `failed` / `never-ran`). */
  checks?: CheckResult[];
  /** The judge's verdict. Absent = grading was not attempted at all. */
  judge?: JudgeResult;
  /** What the transcript measurably shows (run-facts.ts). */
  facts?: RunFacts;
  /** Set when grading itself could not be carried out (as opposed to the
   *  judge answering and being unusable, which is `judge.unavailable`). */
  gradingError?: string;
}

export interface ReportMeta {
  /** Full ISO timestamp of when the run started. Split as a string, never
   *  parsed into a Date — that would make this function timezone-dependent and
   *  therefore not pure across machines. */
  startedISO: string;
  buildSha: string;
  /** The real reason the matrix stopped early, if it did. Optional so the
   *  brief's `{ startedISO, buildSha }` signature still type-checks. */
  stopReason?: string;
}

/** Widest a grid cell's error excerpt gets before the reader is sent to the
 *  detail block below, which carries the untruncated text. */
const GRID_ERROR_CHARS = 60;

// --- small pure helpers ------------------------------------------------------

/** `2026-08-12T14:03:22.941Z` -> `2026-08-12 14:03 UTC`. A plain string split,
 *  for the same reason append-review.ts uses one: no Date, no timezone, no
 *  locale — the same input renders the same everywhere. "UTC" is printed only
 *  when the timestamp actually claims it. */
function stamp(iso: string): string {
  const [date, time = ''] = String(iso).split('T');
  const hhmm = time.slice(0, 5);
  if (!hhmm) return date;
  return /z$/i.test(time) ? `${date} ${hhmm} UTC` : `${date} ${hhmm}`;
}

/** A `|` inside a markdown table cell ends the cell. Roster labels and case
 *  ids are hand-written, so escape rather than trust. */
function cellText(value: string): string {
  return value.replace(/\|/g, '\\|');
}

/** A fence long enough to contain `text` whatever backticks it holds.
 *
 *  WHY fenced at all: a model's answer routinely contains its own headings and
 *  code fences, and pasting it raw would let it take over the document's
 *  structure (or silently swallow the sections after it). WHY a computed
 *  length: a fixed ``` breaks the moment an answer contains one, which is
 *  every answer about code. */
function fenceFor(text: string): string {
  let longest = 2;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return '`'.repeat(longest + 1);
}

const CHECK_ICON: Record<CheckResult['state'], string> = {
  passed: '✅',
  failed: '❌',
  // WHY not a green or red mark: `never-ran` is neither. It is the state that
  // caused the `notes/pristine.md` class of bug — a check whose precondition
  // never happened silently counting as a pass.
  'never-ran': '⚠️',
};

const CHECK_WORD: Record<CheckResult['state'], string> = {
  passed: 'PASSED',
  failed: 'FAILED',
  'never-ran': 'NEVER RAN',
};

/** The one-line check tally that goes in a grid cell. Every state that is
 *  present is named; a state with zero entries is omitted so a clean row stays
 *  short. `never ran` is spelled out in full, never abbreviated into the pass
 *  count. */
function checkTally(checks: CheckResult[] | undefined): string {
  // Fix pass 1 (2026-08-12 review, IMPORTANT 4): `undefined` is NOT `[]`.
  // Nothing recorded means the checks could not be evaluated (the grading step
  // threw before or during them); an empty array means the case genuinely
  // declares none. Collapsing the two printed "nothing could be measured" as a
  // definite fact about the case — the never-ran failure shape one level up.
  if (checks === undefined) return '⚠️ checks not recorded';
  if (!checks.length) return 'no checks';
  const count = (state: CheckResult['state']) => checks.filter((c) => c.state === state).length;
  const parts: string[] = [];
  if (count('passed')) parts.push(`✅ ${count('passed')} passed`);
  if (count('failed')) parts.push(`❌ ${count('failed')} failed`);
  if (count('never-ran')) parts.push(`⚠️ ${count('never-ran')} never ran`);
  return parts.join(', ');
}

/** Why a cell has no grades, in the words of whatever actually failed — or
 *  `null` when it does have grades. Ordered most-specific first. */
function ungradedReason(result: CellResult, judgeModelId: string | null | undefined): string | null {
  const judge = result.judge;
  // Fix pass 1 (2026-08-12 review, MINOR 2): kept grades outrank a
  // `gradingError`. The judge answering and THEN the .grades.json write failing
  // used to render as NOT GRADED, suppressing grades that had already been paid
  // for. The error is not hidden — renderCellBlock prints it as a warning above
  // the grades — but it no longer deletes the thing it happened after.
  if (judge && judge.grades.length > 0) return null;
  if (result.gradingError) return `grading could not be carried out: ${result.gradingError}`;
  if (!judge) {
    // No judge result AT ALL, and no grading error either — nothing recorded
    // grading for this cell. Say only that; the orchestrator always assigns a
    // judge result, so guessing a cause here would be inventing one.
    return judgeModelId
      ? 'no judge result was recorded for this cell, so nothing was graded'
      : 'no judge was configured for this plan, so nothing was graded';
  }
  // Fix pass 1 (2026-08-12 review, IMPORTANT 3): FIRST, because "no call was
  // made" must never fall through to a sentence about what a judge returned.
  // judgeRun sets this on both of its no-op paths (no judge, empty rubric); the
  // orchestrator hands that result straight through, so this is the branch a
  // plan without a judge actually reaches.
  if (judge.notAttempted) return judge.notAttempted;
  if (judge.unavailable) return judge.unavailable;
  if (judge.grades.length === 0 && judge.attempted > 0) {
    return `the judge returned ${judge.attempted} grade${judge.attempted === 1 ? '' : 's'} and ALL of them were `
      + 'discarded (0 kept) — see the warnings above. This is not "no issues found"; it is "nothing the judge said '
      + 'could be verified".';
  }
  // Only reachable now when a judge call WAS made and came back with an empty
  // grade list (`{"grades": []}` parses to attempted 0 with no `unavailable`).
  // The no-call cases are caught by `notAttempted` above, so this sentence no
  // longer asserts a call that never happened.
  if (judge.grades.length === 0) return 'the judge returned no grades for this run';
  return null;
}

/** `8/10 (2 of 3 rubric items kept)` — the score, and how much of the rubric it
 *  actually covers. WHY the denominator is `kept`, not the rubric length: a
 *  total over items that were never graded would read as a low score instead of
 *  a thin one. */
function gradeTotal(judge: JudgeResult, rubricSize: number): string {
  const sum = judge.grades.reduce((total, grade) => total + grade.score, 0);
  const max = judge.grades.length * JUDGE_SCALE_MAX;
  const coverage = rubricSize > 0
    ? ` (${judge.grades.length} of ${rubricSize} rubric item${rubricSize === 1 ? '' : 's'} kept)`
    : ` (${judge.grades.length} kept)`;
  return `${sum}/${max}${coverage}`;
}

/** Does this cell's own model also sit in the judge's chair?
 *
 *  WHY the report computes this itself instead of relying on judge.ts's
 *  warning: the warning only exists when a judge call was actually made, and
 *  self-grading is exactly as true (and exactly as worth flagging) on a row
 *  whose judge call failed. The base-model fold matches judge.ts's — everything
 *  after the first `:` is an OpenRouter serving-tier suffix, so `x/y` grading
 *  `x/y:beta` is the same weights grading their own output. */
function isSelfGraded(judgeModelId: string | null | undefined, run: CaseRun | null | undefined): boolean {
  if (!judgeModelId || !run?.modelId) return false;
  const base = (id: string) => id.trim().toLowerCase().split(':')[0];
  return base(judgeModelId) === base(run.modelId);
}

/** The key a result is filed under in the grid: one square of tasks x arms x
 *  models. Builds and repeats land in the SAME square (they are extra runs of
 *  the same combination), and are labelled individually inside it. */
function squareKey(caseId: string, instructionsId: string, model: string): string {
  return JSON.stringify([caseId, instructionsId, model]);
}

/** How one run inside a square is labelled when the square holds more than
 *  one — otherwise the label is noise on every row. */
function runLabel(cell: Cell): string {
  return `${cell.buildId}#${cell.repeat}`;
}

// --- the grid ----------------------------------------------------------------

/** What a single square says. This is the five-second answer, so it carries
 *  the three states of the checks and the grade total, and nothing else. */
function squareSummary(result: CellResult, rubricSize: number): string {
  if (!result.run) {
    // A cell that produced no run at all. The REAL error, truncated only here;
    // the detail block below prints it whole.
    const why = result.timedOut ? 'timed out' : 'failed to run';
    const detail = (result.error ?? '').replace(/\s+/g, ' ').trim();
    const excerpt = detail.length > GRID_ERROR_CHARS ? `${detail.slice(0, GRID_ERROR_CHARS)}…` : detail;
    return `❗ ${why}${excerpt ? ` — ${excerpt}` : ''}`;
  }
  // `result.checks` is passed THROUGH, not defaulted to `[]`: checkTally has to
  // see the difference between "no check results were recorded" and "this case
  // declares no checks" (fix pass 1, IMPORTANT 4).
  const parts = [checkTally(result.checks)];
  const judge = result.judge;
  if (judge && judge.grades.length > 0) {
    parts.push(`grades ${gradeTotal(judge, rubricSize)}`);
  } else {
    // NEVER an empty grade column: see the file header, item 2.
    parts.push('**not graded**');
  }
  if (judge?.warnings.length) parts.push(`⚠️ ${judge.warnings.length} judge warning${judge.warnings.length === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

function renderGrid(
  plan: EvalPlan,
  bySquare: Map<string, CellResult[]>,
  rubricSizes: Map<string, number>,
  judgeModelId: string | null | undefined,
): string[] {
  const lines: string[] = ['## At a glance', ''];
  lines.push(
    'One block per model. Rows are tasks, columns are the instruction arms — so reading ACROSS a row is the '
    + 'comparison this run was paid for.',
    '',
    '`never ran` is a check whose precondition never happened. It is **not** a pass, and it is not a failure: '
    + 'nothing was measured. `not graded` means no grade survived verification — it is **not** "no issues found". '
    + 'A square that says `did not run` is a combination that never happened at all.',
    '',
  );

  for (const model of plan.models) {
    lines.push(`### ${model}`, '');
    const selfGraded = [...(bySquare.values())]
      .flat()
      .some((r) => r.cell.model === model && isSelfGraded(judgeModelId, r.run));
    if (selfGraded) {
      lines.push(
        `> ⚠️ **Self-grading:** the judge (\`${judgeModelId}\`) is this same model. Models favour their own `
        + 'output, so weigh every grade in this block accordingly.',
        '',
      );
    }
    lines.push(
      `| task | ${plan.instructions.map((arm) => cellText(arm.id)).join(' | ')} |`,
      `|---|${plan.instructions.map(() => '---').join('|')}|`,
    );
    for (const caseId of plan.cases) {
      const cells = plan.instructions.map((arm) => {
        const results = bySquare.get(squareKey(caseId, arm.id, model)) ?? [];
        // Item 6: a combination with no result is NAMED, not omitted.
        if (!results.length) return '⬜ did not run';
        const rubricSize = rubricSizes.get(caseId) ?? 0;
        return results
          .map((r) => (results.length > 1 ? `\`${runLabel(r.cell)}\` ${squareSummary(r, rubricSize)}` : squareSummary(r, rubricSize)))
          .join('<br>');
      });
      lines.push(`| ${cellText(caseId)} | ${cells.map(cellText).join(' | ')} |`);
    }
    lines.push('');
  }
  return lines;
}

// --- one cell's detail block -------------------------------------------------

function renderCellBlock(
  index: number,
  result: CellResult,
  rubricSize: number,
  judgeModelId: string | null | undefined,
): string[] {
  const cell = result.cell;
  const lines: string[] = [];
  lines.push(`### ${index}. ${cell.caseId} · ${cell.instructionsId} · ${cell.model}`, '');
  lines.push(
    `\`${cell.id}\` · build \`${cell.buildId}\` · run ${cell.repeat + 1} · `
    // The transcript name comes from cellFilename (matrix.ts) and nowhere else:
    // the raw cell id contains '|' and spaces, so it was never a filename.
    + `transcript \`${cellFilename(cell)}.json\``,
    '',
  );

  if (!result.run) {
    lines.push(
      result.timedOut
        ? '**This cell timed out.** Nothing was produced; whatever it had already consumed is spent.'
        : '**This cell produced no run.**',
      '',
      // The orchestrator's own words. Never a guessed cause.
      result.error ? `> ${result.error}` : '> No error text was recorded for this cell.',
      '',
    );
    return lines;
  }

  if (result.facts) lines.push(renderRunFacts(result.facts), '');

  lines.push('**Checks**', '');
  const checks = result.checks;
  if (checks === undefined) {
    // Fix pass 1 (2026-08-12 review, IMPORTANT 4). This used to be `?? []`,
    // which printed "This case declares no mechanical checks." for a case that
    // declares three — a definite negative FACT about the case, invented from
    // the absence of data. Reachable whenever the grading step threw before the
    // checks were recorded (a collectRunFacts failure did exactly this). The
    // real reason, if there is one, is the grading error printed elsewhere in
    // this block; this line claims nothing beyond what is known.
    lines.push(
      '- ⚠️ **NOT RECORDED** — no check results were recorded for this cell, so nothing mechanical was measured. '
      + 'This is NOT "this case declares no checks", and it is NOT a pass.',
      '',
    );
  } else if (!checks.length) {
    lines.push('- This case declares no mechanical checks.', '');
  } else {
    for (const check of checks) {
      lines.push(`- ${CHECK_ICON[check.state]} **${CHECK_WORD[check.state]}** \`${check.id}\` — ${check.detail}`);
    }
    lines.push('');
  }

  lines.push(`**Grades**${judgeModelId ? ` — judge \`${judgeModelId}\`` : ''}`, '');
  // Item 3: warnings print ABOVE the grades, as their own block, and are never
  // folded into a score. Item 4: self-grading is one of them.
  if (isSelfGraded(judgeModelId, result.run) && !result.judge?.warnings.some((w) => /self-grad/i.test(w))) {
    lines.push(`> ⚠️ **Self-grading:** the judge (\`${judgeModelId}\`) is the model that wrote this answer.`, '');
  }
  for (const warning of result.judge?.warnings ?? []) lines.push(`> ⚠️ ${warning.replace(/^⚠️\s*/, '')}`, '');

  // Fix pass 1 (2026-08-12 review, MINOR 2): a grading error that happened AFTER
  // the judge produced grades (the .grades.json write failing is the reachable
  // one) is printed HERE, above the grades it did not invalidate — instead of
  // replacing them with NOT GRADED, which threw away work already paid for. The
  // sentence says only what is known: grading did not finish, in the words of
  // whatever failed, with no guess at which step was lost.
  if (result.gradingError && (result.judge?.grades.length ?? 0) > 0) {
    lines.push(
      '> ⚠️ **Grading did not finish**, but the judge had already returned the grades below, so they are printed. '
      + `Whatever ran after the judge failed with: ${result.gradingError}`,
      '',
    );
  }

  const ungraded = ungradedReason(result, judgeModelId);
  if (ungraded) {
    lines.push(`**NOT GRADED** — ${ungraded}`, '');
  } else {
    const judge = result.judge as JudgeResult;
    for (const grade of judge.grades) {
      lines.push(`- **${grade.id}** — ${grade.score}/${JUDGE_SCALE_MAX}`);
      // Item 5: the verbatim quote, spelled as the ANSWER spells it, so
      // Ctrl-F on this page finds it in the answer printed below.
      lines.push(`  - quote: “${grade.quote}”`);
      if (grade.reason) lines.push(`  - the judge's reason: ${grade.reason}`);
    }
    lines.push('', `Total: ${gradeTotal(judge, rubricSize)}.`, '');
  }

  const answer = result.run.review ?? '';
  lines.push('**The answer, verbatim**', '');
  if (!answer.trim()) {
    lines.push('_This run produced no written answer._', '');
  } else {
    const fence = fenceFor(answer);
    lines.push(fence, answer, fence, '');
  }
  return lines;
}

// --- the report --------------------------------------------------------------

/** Render the whole run as one markdown page. Pure: same input, byte-identical
 *  output. */
export function renderReport(plan: EvalPlan, results: CellResult[], meta: ReportMeta): string {
  const judgeModelId = plan.judge ?? null;
  const repeats = plan.repeats ?? 1;

  // File every result under its square of the grid, preserving the order the
  // orchestrator produced them in (which is expandPlan's order).
  const bySquare = new Map<string, CellResult[]>();
  for (const result of results) {
    const key = squareKey(result.cell.caseId, result.cell.instructionsId, result.cell.model);
    const bucket = bySquare.get(key);
    if (bucket) bucket.push(result); else bySquare.set(key, [result]);
  }

  // Rubric size per case, learned from the judge results themselves (the report
  // has no case registry and must not grow one — it would make this function
  // dependent on a module that reads files). `attempted` is the judge's row
  // count, which is the rubric length whenever the judge answered at all.
  const rubricSizes = new Map<string, number>();
  for (const result of results) {
    const attempted = result.judge?.attempted ?? 0;
    const known = rubricSizes.get(result.cell.caseId) ?? 0;
    if (attempted > known) rubricSizes.set(result.cell.caseId, attempted);
  }

  const ran = results.filter((r) => r.run).length;

  // The BUILD arms, which are an axis of expandPlan (matrix.ts) and were missing
  // from this count until fix pass 1 (2026-08-12 review, IMPORTANT 2): a
  // master-vs-branch plan expands to twice these cells, so two builds both
  // running printed "**2 of 1** planned cell produced a run" — an impossible
  // number on the line that tells the reader how much of what they paid for
  // actually happened.
  //
  // WHY the fallback chain: `builds` is optional in the plan FILE (the
  // orchestrator resolves and injects the current build before expanding), so a
  // plan object handed straight to this renderer may not carry it. Falling back
  // to the build ids the RESULTS actually carry keeps the keys below matching
  // real cells; with neither, there is exactly one unnamed arm.
  const buildIds: (string | null)[] = plan.builds?.length
    ? plan.builds.map((build) => build.id)
    : [...new Set(results.map((r) => r.cell.buildId))];
  if (!buildIds.length) buildIds.push(null);
  const planned = plan.cases.length * plan.instructions.length * plan.models.length * buildIds.length * repeats;

  const lines: string[] = [];
  lines.push(`# Harness eval — ${plan.name}`, '');
  lines.push(
    `**Started** ${stamp(meta.startedISO)} · **Build** \`${meta.buildSha}\` · `
    + `**Judge** ${judgeModelId ? `\`${judgeModelId}\`` : '_none — nothing in this run was graded_'} · `
    + `**${ran} of ${planned}** planned cell${planned === 1 ? '' : 's'} produced a run`,
    '',
  );

  if (meta.stopReason) {
    lines.push(
      `> ❗ **This run stopped early.** ${meta.stopReason}`,
      '',
      '> Everything below covers only the cells that finished. There is no resume — see the limits below.',
      '',
    );
  }

  // Item 7: unconditional. These print on every report, complete or not.
  lines.push('## What this report can and cannot tell you', '');
  lines.push(
    repeats === 1
      ? '- **One run per combination.** One run is noise, not evidence. If one arm scores 62 and another 58, '
        + 'that is not a finding — it is the same result twice with different dice. Only a large, repeated gap '
        + 'means anything here.'
      : `- **${repeats} runs per combination.** That is still a small sample: a few points between two arms is `
        + 'noise, not a finding. Only a large, repeated gap means anything here.',
    '- **There is no resume.** A stopped run cannot be continued — re-running this plan pays again for every cell '
      + 'that already finished. Anything already on disk (below) is the only record of what was bought.',
    '- **Grades come from another language model, not from a measurement.** Every grade prints the verbatim quote '
      + 'it was based on; a grade you have not spot-checked against its quote is not evidence.',
    '- **The contradiction warnings are heuristic.** They come from matching tool names against the judge\'s own '
      + 'prose, so they can be wrong in a way you can see. Read the quote and dismiss the warning if it is.',
    '- **A check that never ran is not a check that passed**, and an empty grade list is not "no issues found". '
      + 'Both are printed as their own state.',
    '',
  );

  lines.push(...renderGrid(plan, bySquare, rubricSizes, judgeModelId));

  // Item 6, in list form as well as in the grid: the combinations that produced
  // nothing, named one by one. A reader scanning for "what did I not get?"
  // should not have to reconstruct it from empty squares.
  //
  // Fix pass 1 (2026-08-12 review). Two things were wrong with this list:
  //   IMPORTANT 2 — the key was case x arm x model, with no BUILD in it, so a
  //     plan whose `branch` arm never ran at all had that whole arm vanish
  //     silently: "every combination produced at least one result" was printed
  //     about a comparison that only ever tested one side. Branch-vs-master is
  //     the use case this file exists for.
  //   MINOR 1 — membership was keyed on a CellResult EXISTING, not on a run
  //     existing. A matrix where every cell 402'd therefore printed "None —
  //     every combination produced at least one result" two screens under a
  //     "0 of 4" header. A result that carries an error is not a run.
  const ranCombos = new Set<string>();
  for (const result of results) {
    if (result.run) ranCombos.add(JSON.stringify([result.cell.caseId, result.cell.instructionsId, result.cell.model, result.cell.buildId]));
  }
  // Which combinations were ATTEMPTED (a result exists) but produced no run —
  // told apart below from the ones that never started, because "the provider
  // refused it" and "it never happened" are different facts about the money.
  const attemptedCombos = new Set<string>();
  for (const result of results) {
    if (!result.run) attemptedCombos.add(JSON.stringify([result.cell.caseId, result.cell.instructionsId, result.cell.model, result.cell.buildId]));
  }
  const missing: string[] = [];
  // The build id is only spelled out when there is more than one arm: on a
  // single-build plan it is the same word on every line and reads as noise.
  const showBuild = buildIds.length > 1;
  for (const caseId of plan.cases) {
    for (const arm of plan.instructions) {
      for (const model of plan.models) {
        for (const buildId of buildIds) {
          const key = JSON.stringify([caseId, arm.id, model, buildId]);
          if (ranCombos.has(key)) continue;
          const name = `${caseId} · ${arm.id} · ${model}${showBuild ? ` · build ${buildId}` : ''}`;
          missing.push(attemptedCombos.has(key)
            ? `${name} — attempted, but produced no run (its block below carries the error)`
            : `${name} — never started`);
        }
      }
    }
  }
  lines.push('## Combinations that did not run', '');
  if (!missing.length) {
    lines.push('None — every combination in this plan produced at least one run.', '');
    // Repeats are the only axis not in the key above, so when every combination
    // ran and cells are still missing, repeats is what they are. Printed because
    // the header's "N of M" would otherwise contradict this line with no
    // explanation anywhere on the page.
    if (ran < planned) {
      lines.push(
        `${planned - ran} of the ${planned} planned cells still produced no run: this plan asks for ${repeats} runs `
        + 'per combination, and the missing ones are repeats of combinations that did run at least once.',
        '',
      );
    }
  } else {
    lines.push(
      `${missing.length} combination${missing.length === 1 ? '' : 's'} in this plan produced no run at all. `
      + 'They are blank because nothing was measured, not because they were fine:',
      '',
    );
    for (const name of missing) lines.push(`- ${name}`);
    lines.push('');
  }

  lines.push('## The answers', '');
  if (!results.length) {
    lines.push('No cell in this run produced a result.', '');
  }
  results.forEach((result, i) => {
    lines.push(...renderCellBlock(i + 1, result, rubricSizes.get(result.cell.caseId) ?? 0, judgeModelId));
  });

  lines.push('## The raw conversations', '');
  lines.push(
    'Every cell that ran wrote its FULL conversation — every tool call, every result, every message — to a JSON '
    + 'file beside this report, named in each block above. Those files are written before anything is graded, so '
    + 'they exist even for a run that stopped or could not be graded. They are deliberately not committed to git; '
    + 'this report is.',
    '',
  );

  // WHY no blank-line collapsing pass here: an earlier draft ran
  // `.replace(/\n{3,}/g, '\n\n')` over the finished page to tidy the seams —
  // which would also have rewritten any model answer containing a run of blank
  // lines. The answers are printed VERBATIM because the judge's quotes are
  // checked against them; a cosmetic pass over the whole document is a pass
  // over the evidence too.
  return `${lines.join('\n').trimEnd()}\n`;
}
