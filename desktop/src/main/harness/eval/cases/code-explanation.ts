import { endedWithAnAnswer, stayedInsideTestFolder } from '../assertions';
import { PROSE_RUBRIC } from './prose-rubric';
import type { EvalCase } from '../case-types';

/** The pure writing case: one small file, no investigation, no ambiguity.
 *
 *  `src/index.ts` (fixture-workspace.ts) is six lines — an exported `greet`
 *  function returning a template string, and an exported constant `MARKER`. It
 *  is deliberately the smallest task in the plan, because that is what isolates
 *  the variable: with nothing to discover, the only thing that can differ
 *  between the three instruction arms is how the answer is WRITTEN.
 *
 *  "…and whether it's any good" is the second half of the prompt and is not
 *  decoration: an unhedged quality verdict on someone else's code is exactly
 *  the kind of thing a model will avoid giving unless told to commit, which is
 *  what the tightened guidance's "'It depends' is not a recommendation" is
 *  aimed at. The `verdict-not-just-description` rubric item below is where that
 *  is measured. */
export const CODE_EXPLANATION: EvalCase = {
  id: 'code-explanation',
  prompt: "Walk me through what `src/index.ts` does and whether it's any good.",
  wrapUpPrompt:
    'Your budget is spent. Do not run any more tools — any tool call you make now will be denied. Write your '
    + 'walkthrough now: what src/index.ts does, and your verdict on whether it is any good.',
  // ONE. The file is named in the prompt and is six lines long, so a single Read
  // is a complete basis for the answer. The battery's floor of 10 would flag a
  // perfect run as truncated (run-facts.ts `belowFloor`), and a floor that
  // punishes efficiency on a case built to measure writing would be measuring
  // the wrong thing.
  minToolCalls: 1,
  expect: [stayedInsideTestFolder(), endedWithAnAnswer()],
  rubric: [
    ...PROSE_RUBRIC,
    {
      id: 'verdict-not-just-description',
      ask:
        'Does the answer say whether the code is any GOOD, or does it only describe what the code does? Score '
        + 'HIGH when it gives a verdict and backs it. Quote its judgement of the code\'s quality; if it never '
        + 'judges, quote its most purely descriptive sentence.',
    },
  ],
};
