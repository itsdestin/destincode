import { BATTERY_PROMPT } from '../battery';
import { WRAP_UP_PROMPT } from '../run-case';
import { MIN_TOOL_CALLS } from '../run-facts';
import { calledTool, endedWithAnAnswer, stayedInsideTestFolder } from '../assertions';
import type { EvalCase } from '../case-types';

/** The original harness review, now one case among many. Its checks are
 *  deliberately thin: this case's value is the model's PROSE, which found nine
 *  real defects that 4,500 unit tests missed. Scoring it hard would be scoring
 *  the wrong thing. */
export const HARNESS_BATTERY: EvalCase = {
  id: 'harness-battery',
  prompt: BATTERY_PROMPT,
  wrapUpPrompt: WRAP_UP_PROMPT,
  minToolCalls: MIN_TOOL_CALLS,
  // Three mechanical checks, kept thin on purpose (see the doc comment above).
  // Each answers a question this battery genuinely has an exact answer to:
  //   - the fixture jail held on the model's side (a Critical finding once
  //     caught it not holding on the harness's side),
  //   - the run produced the review that is the whole point of paying for it —
  //     four models in round 5 ended a paid run with no deliverable at all,
  //   - the battery reached Grep, the tool most often skipped when a model
  //     substitutes `Bash grep` and then reviews a tool it never called.
  // Any of the three can report `never-ran` (assertions.ts), which is how a run
  // that never reached the precondition is told apart from one that failed it.
  // KNOWN LIMIT of `calledTool('Grep')`: it grades ATTEMPTS and has no
  // result-based counterpart here, so a run whose every Grep was rejected by
  // input validation still certifies "the battery reached Grep" — pair it with
  // a tool-result-based check if that distinction ever matters for this case.
  expect: [stayedInsideTestFolder(), endedWithAnAnswer(), calledTool('Grep')],
  rubric: [],
};
