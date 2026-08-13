import type { AskRequest, AskDecision } from '../permission-broker';
import type { HarnessSessionOpts } from '../harness-session';

/**
 * Auto-answers every ask a child session raises. Children have no user;
 * every ask must resolve immediately with a deterministic, finalize-clean answer.
 *
 * WHY this policy denies all asks:
 * - max_steps (line 1424): a deny causes the turn to end with stopReason 'max_steps',
 *   a clean turn-final state.
 * - doom_loop (line 1800): a deny causes the loop to return corrective retry text
 *   ("try a different approach") to the model.
 * - external-directory forced ask (lines 1837–1846): a deny keeps the child inside
 *   its work_dir (the `external: 'deny'` verdict for step 1a).
 * - interactive AskUserQuestion (line 1817): belt-and-suspenders — AskUserQuestion
 *   is never in allowedTools for a child, so this ask never surfaces; a deny here
 *   prevents any hypothetical interactive tool from hanging a child.
 *
 * Plan 1b's timeout-redirect will replace this policy for the asks worth routing to
 * the parent (max_steps, doom_loop) — specialist children will timeout on budget
 * asks and resume in the parent with accumulated history. Interactive and forced asks
 * still deny here: neither should reach a specialist.
 */
export function childAskPolicy(): NonNullable<HarnessSessionOpts['askUser']> {
  return async (_req: AskRequest): Promise<AskDecision> => {
    return { behavior: 'deny' };
  };
}
