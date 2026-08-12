import { BATTERY_PROMPT } from '../battery';
import { WRAP_UP_PROMPT } from '../run-case';
import { MIN_TOOL_CALLS } from '../run-facts';
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
  // Stubbed empty: `calledTool`/`stayedInsideTestFolder`/`endedWithAnAnswer`
  // come from assertions.ts, which Task 9 builds. Filled in by that task's
  // commit — see docs/active/plans/2026-08-12-harness-evaluator.md Task 5.
  expect: [],
  rubric: [],
};
