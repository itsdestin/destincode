import { endedWithAnAnswer, stayedInsideTestFolder } from '../assertions';
import { PROSE_RUBRIC } from './prose-rubric';
import type { EvalCase } from '../case-types';

/** "Something is wrong here — find it and tell me."
 *
 *  THE FINDING IS SEEDED, and it is the only one in the tree:
 *  `config/settings.toml` says `port = 8080` and `config/app.toml` says
 *  `port = 9090` (fixture-workspace.ts). The two files are deliberately
 *  symmetric — same `[server]` table, same `host`, neither name implying
 *  precedence — so nothing in the tree says which one wins. A model that reads
 *  both and reports the disagreement has done the task; a model that reports
 *  one of them as "the" port has not looked at the other.
 *
 *  WHY the prompt does not say "look at the config files": this case is half of
 *  the writing experiment and half a test of whether the model finds anything
 *  at all. Naming the files would turn it into a reading-comprehension task and
 *  would make every arm's answer start from the same two files, which is the
 *  one thing that would make the three instruction arms hard to tell apart. */
export const CONFIG_INVESTIGATION: EvalCase = {
  id: 'config-investigation',
  prompt: 'Something is wrong with how this project is configured. Find out what, and report back.',
  // WHY a task-specific wrap-up and not the battery's: the battery's wrap-up
  // literally says "write your review of the harness", which on this case would
  // ask for a deliverable nobody wants and then grade the answer that came back.
  // The tool-denial sentence is kept verbatim from the battery's, because
  // run-case.ts really does deny every tool call during the wrap-up turn and
  // this sentence is the only thing that explains the denials to the model.
  wrapUpPrompt:
    'Your investigation budget is spent. Do not run any more tools — any tool call you make now will be '
    + 'denied. Report back now: say what you found to be wrong with this project\'s configuration, and what '
    + 'you saw that told you so.',
  // WHY 3 and not the battery's 10: this is one finding in a nine-file tree.
  // Finding the config directory, reading one file and reading the other is
  // three calls, and that is a complete investigation. The battery's floor
  // measures "did it walk seven areas of tool surface", which is a different
  // question — a run graded against 10 here would be flagged as truncated for
  // doing the task efficiently (run-facts.ts `belowFloor`).
  minToolCalls: 3,
  // Thin on purpose. The mechanical half can only answer questions with exact
  // answers: did the model stay in its sandbox, and did it produce an answer at
  // all. Whether it found the RIGHT thing is prose, so it is a rubric item
  // (below) where a human can check the judge's quote.
  expect: [stayedInsideTestFolder(), endedWithAnAnswer()],
  rubric: [
    ...PROSE_RUBRIC,
    {
      id: 'found-the-port-conflict',
      ask:
        'Does the answer identify that two configuration files disagree about the server port? Score HIGH when '
        + 'it does. Quote the sentence naming both files, or both port numbers; if it does not find that, quote '
        + 'what it named as the problem instead.',
    },
  ],
};
