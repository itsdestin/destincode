import type { AskRequest, AskDecision, PermissionBroker } from '../permission-broker';
import type { HarnessSessionOpts } from '../harness-session';
import { SPECIALIST_ASK_HOLD_MS } from './limits';

// Child ask routing (plan 1b, Task 8). Replaces child-ask-policy.ts's
// deny-everything stub: a specialist child has no user of its own, but it now
// has a PARENT that does. max_steps, doom_loop, and a decide-originated ask
// (today only the deny-listed-inside-a-granted-envelope case — see
// child-permissions.ts branch 5) re-register on the broker under the
// PARENT's sessionId, with the specialist's identity attached, so the
// existing permission card renders it exactly like any other ask. The child
// waits up to SPECIALIST_ASK_HOLD_MS; if nobody answers by then, the call
// resolves with ASK_REDIRECT_MESSAGE so the child can keep making progress
// instead of hanging silently until its own step/time budget runs out.
//
// Interactive (AskUserQuestion) and external-forced asks are the two
// exceptions that STILL deny instantly, exactly as child-ask-policy.ts always
// denied everything:
//  - AskUserQuestion is never in a specialist's allowedTools (cold-start
//    contract), so this branch is currently unreachable in production — kept
//    as belt-and-suspenders in case a future definition ever lists it, since
//    there genuinely is no user for an interactive tool to ask through a
//    specialist.
//  - An external-directory forced ask means the child tried to touch a path
//    outside its work directory — routing THAT to the parent would ask the
//    user to approve the specialist leaving its assigned sandbox, which is a
//    different (and much bigger) decision than the ones this route is for.
// Both denials carry FACTUAL, non-blaming copy (never "the user declined" —
// no user was ever consulted for either case; error-message-standards.md).
export const ASK_REDIRECT_MESSAGE =
  'This action needs the user\'s direct approval, and the user has not responded yet — '
  + 'the request is still pending on their screen. Continue any assigned work that does NOT '
  + 'depend on the blocked action. Do NOT attempt the blocked action by any other means or '
  + 'work around it. Do NOT build further work on the assumption it will be approved. '
  + 'If everything left depends on it, write up your progress so far and finish with your report.';

export interface ChildAskRouterDeps {
  /** Structural, not the concrete class — a test can inject a fake with just
   *  an `ask()` method instead of standing up a real broker. */
  broker: Pick<PermissionBroker, 'ask'>;
  parentId: string;
  childId: string;
  agentType: string;
  title: string;
  /** Overridable for tests (default SPECIALIST_ASK_HOLD_MS = 5 minutes). */
  timeoutMs?: number;
}

export function childAskRouter(deps: ChildAskRouterDeps): NonNullable<HarnessSessionOpts['askUser']> {
  return async (req: AskRequest): Promise<AskDecision> => {
    if (req.toolName === 'AskUserQuestion') {
      return {
        behavior: 'deny',
        message: 'AskUserQuestion is not available to this specialist — there is no user it can ask directly. Continue with your best judgment, or note the open question in your final report.',
      };
    }
    if (req.external) {
      return {
        behavior: 'deny',
        message: `${req.toolName} on a path outside this specialist's work directory cannot be approved — specialists cannot ask the user to approve leaving their assigned work directory. Stay within it, or note the constraint in your report.`,
      };
    }
    return deps.broker.ask(
      {
        ...req,
        sessionId: deps.parentId,
        raisedBy: deps.childId,
        specialist: { childId: deps.childId, agentType: deps.agentType, title: deps.title },
      },
      {
        timeoutMs: deps.timeoutMs ?? SPECIALIST_ASK_HOLD_MS,
        onTimeout: () => ({ behavior: 'deny', message: ASK_REDIRECT_MESSAGE }),
      },
    );
  };
}
