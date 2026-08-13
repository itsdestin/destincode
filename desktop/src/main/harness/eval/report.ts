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
function checkTally(checks: CheckResult[]): string {
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
function ungradedReason(result: CellResult): string | null {
  if (result.gradingError) return `grading could not be carried out: ${result.gradingError}`;
  const judge = result.judge;
  if (!judge) return 'no judge was configured for this plan, so nothing was graded';
  if (judge.unavailable) return judge.unavailable;
  if (judge.grades.length === 0 && judge.attempted > 0) {
    return `the judge returned ${judge.attempted} grade${judge.attempted === 1 ? '' : 's'} and ALL of them were `
      + 'discarded (0 kept) — see the warnings above. This is not "no issues found"; it is "nothing the judge said '
      + 'could be verified".';
  }
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
  const parts = [checkTally(result.checks ?? [])];
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
  const checks = result.checks ?? [];
  if (!checks.length) {
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

  const ungraded = ungradedReason(result);
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
  const planned = plan.cases.length * plan.instructions.length * plan.models.length * repeats;

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
  const missing: string[] = [];
  for (const caseId of plan.cases) {
    for (const arm of plan.instructions) {
      for (const model of plan.models) {
        if (!bySquare.has(squareKey(caseId, arm.id, model))) missing.push(`${caseId} · ${arm.id} · ${model}`);
      }
    }
  }
  lines.push('## Combinations that did not run', '');
  if (!missing.length) {
    lines.push('None — every combination in this plan produced at least one result.', '');
  } else {
    lines.push(
      `${missing.length} combination${missing.length === 1 ? '' : 's'} in this plan produced no result at all. `
      + 'They are blank because they never happened, not because they were fine:',
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
