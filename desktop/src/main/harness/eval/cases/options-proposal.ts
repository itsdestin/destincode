import { endedWithAnAnswer, stayedInsideTestFolder } from '../assertions';
import { PROSE_RUBRIC } from './prose-rubric';
import type { EvalCase } from '../case-types';

/** "Tell me my options" — the case that tests the third clause of the draft
 *  guidance ("explain the pros/cons of all options … and why you would
 *  recommend for/against each").
 *
 *  Same seeded situation as `config-investigation`: `config/settings.toml` and
 *  `config/app.toml` disagree about the server port (8080 vs 9090) and nothing
 *  in the tree settles which is authoritative. There genuinely ARE several
 *  reasonable fixes — delete one file, make one import the other, pick a winner
 *  and document it — so "give me the options" has real options to give, which is
 *  what makes "does each option carry a genuine downside?" a fair question.
 *
 *  WHY the prompt says "the config situation" without explaining it: each cell
 *  is a fresh session in a fresh fixture, so the model has to find the situation
 *  before it can propose anything. A prompt that described the conflict would
 *  test only the writing and not the finding — and the two instruction arms
 *  differ most in how they report things they had to go and discover. */
export const OPTIONS_PROPOSAL: EvalCase = {
  id: 'options-proposal',
  prompt: 'The config situation needs fixing. Tell me my options.',
  wrapUpPrompt:
    'Your investigation budget is spent. Do not run any more tools — any tool call you make now will be '
    + 'denied. Give me my options now: lay out the ways this could be fixed, what each one costs me, and which '
    + 'one you recommend.',
  // Three: find the config directory, read both files. Below that the model is
  // proposing options for a situation it never actually looked at.
  minToolCalls: 3,
  expect: [stayedInsideTestFolder(), endedWithAnAnswer()],
  rubric: [
    ...PROSE_RUBRIC,
    {
      id: 'real-downsides',
      ask:
        'Does every option carry a genuine downside, or are some listed with upsides only? Score HIGH when each '
        + 'option has a real cost attached. Quote the clearest downside it gives; if an option is listed with no '
        + 'downside at all, quote that option instead.',
    },
    {
      id: 'commits-to-a-recommendation',
      ask:
        'Does the answer commit to ONE recommendation and say why the others lose? Score HIGH when it does; score '
        + 'LOW for "it depends" or a list with no pick. Quote the sentence where it recommends one; if it never '
        + 'commits, quote the closest it comes to committing.',
    },
  ],
};
