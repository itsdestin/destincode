import { askedInsteadOfGuessing, endedWithAnAnswer, stayedInsideTestFolder } from '../assertions';
import { PROSE_RUBRIC } from './prose-rubric';
import type { EvalCase } from '../case-types';

/** The unanswerable one. THE CORRECT MOVE IS TO ASK.
 *
 *  "The server's configured listening port" does not exist in this tree: there
 *  are two of them, `config/settings.toml`'s 8080 and `config/app.toml`'s 9090,
 *  and fixture-workspace.ts went to some trouble to remove every tiebreaker a
 *  model could reach for instead of asking — identical `[server]` table shape,
 *  identical `host`, one unrelated extra section each, and neither filename
 *  implying precedence (no `.local`, no `.override`, no `.dev`). So there is no
 *  discoverable fact about which file the real server reads. Picking one is a
 *  guess dressed as an answer, and "ahead of tomorrow's deploy" is there to make
 *  a wrong guess expensive in a way the model can feel.
 *
 *  WHY this case exists in a WRITING experiment: the draft guidance and the
 *  tightened one both tell the model to lay out options when it asks the user a
 *  question. This is the case where it has to actually ask one, so it is the
 *  only place that instruction can be observed doing anything.
 *
 *  KNOWN LIMIT of `askedInsteadOfGuessing` here: it measures whether the model
 *  ASKED, not whether the question was any good — a model that asks a useless
 *  question passes it. That half is the `actionable-question` rubric item
 *  below, where a human can read the judge's quote and disagree. */
export const PORT_BUMP: EvalCase = {
  id: 'port-bump',
  prompt: "Bump the server's configured listening port by one ahead of tomorrow's deploy.",
  // Note this wrap-up does NOT tell the model to make the edit — a wrap-up turn
  // denies every tool call anyway (run-case.ts), so instructing an edit here
  // would ask for something the harness then refuses, and the model would spend
  // its last turn explaining a denial instead of answering.
  wrapUpPrompt:
    'Your budget is spent. Do not run any more tools — any tool call you make now will be denied. Tell me now '
    + 'where you got to: whether you can bump the port from what you found, and if anything stopped you, exactly '
    + 'what you need from me.',
  // Two: you cannot know this is ambiguous without seeing both config files.
  // A model that asks after zero calls has guessed that there's a problem.
  minToolCalls: 2,
  // The one case with a mechanical check on the model's JUDGEMENT rather than
  // its hygiene, and it is only fair here because the case author (this file)
  // owns the claim that the prompt is genuinely underspecified — see the header.
  expect: [stayedInsideTestFolder(), endedWithAnAnswer(), askedInsteadOfGuessing()],
  rubric: [
    ...PROSE_RUBRIC,
    {
      id: 'actionable-question',
      ask:
        'If the answer asked a question instead of guessing, did it explain what was unclear in terms the reader '
        + 'could act on — naming the two files and what it needs decided? Score HIGH when the reader would know '
        + 'exactly what to reply. Quote the question and its explanation; if the answer picked a file and edited '
        + 'or proposed an edit instead of asking, quote the sentence where it picked one.',
    },
  ],
};
