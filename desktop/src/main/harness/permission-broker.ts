// PermissionBroker (Phase 2 Plan A, Task 8) — owns pending native permission
// asks. Emits 'hook-event' with the SAME shape hook-relay produces (type +
// sessionId + payload + timestamp; payload uses CC's snake_case field names
// tool_name / tool_input / _requestId) so hook-dispatcher → ToolCard render a
// native ask UNCHANGED. Request ids are 'native-' prefixed so the shared
// permission:respond channel routes by id: ipc-handlers tries the broker first,
// and a non-native id falls through to hookRelay. An interrupt → cancelSession
// resolves every pending ask for that session as 'canceled' (spec pending-ask
// ruling — a paused loop can then unwind) and emits PermissionExpired so the
// renderer clears the approval card.
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { log } from '../logger';

export interface AskRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Winning rule came from the destructive deny-list → renderer shows the
   *  consequence warning on Always-allow (Task 13 consumes this). */
  denyListed: boolean;
  /** The ask was FORCED by a path outside the session cwd, which also skips the
   *  permission rules on every future call — so a remembered rule could never
   *  fire. Renderer hides "Always allow" rather than promising a grant the
   *  engine will not honor. Optional (unlike denyListed) because it only means
   *  anything for path-subject tool asks; budget gates never set it.
   *  See spec 2026-08-11 (permissions management UI), finding 3. */
  external?: boolean;
  /** Plan 1b Task 8: set by childAskRouter when this ask is being ROUTED from a
   *  specialist child rather than raised directly by `sessionId`'s own turn.
   *  `sessionId` above is already the PARENT's id by the time this reaches
   *  `ask()` (the router rewrites it before calling in — the renderer only
   *  ever looks a card up by sessionId, and no window owns the child's raw
   *  id) — `raisedBy` keeps the CHILD's real id alongside it so
   *  `cancelSession(childId)` (a child destroy/teardown) can still find and
   *  cancel an ask it raised, and so a late answer can be routed back to the
   *  right child (or reported against the right child if it has since ended). */
  raisedBy?: string;
  /** Rides the hook-event payload so the permission card can label which
   *  specialist raised the ask. Consuming this on the renderer side is a
   *  follow-up task — this one only threads the data through structurally. */
  specialist?: { childId: string; agentType: string; title: string };
  /** Task 11: the exact permission-engine SUBJECT this ask is about (e.g. a
   *  Bash command string) — harness-session.ts already computes this via
   *  tool.permissionSubject(args) before calling askUser, but only THREADS it
   *  through here for the ONE call site that gates on decide() (never for the
   *  max_steps/doom_loop budget asks, which have no such concept). Not
   *  forwarded to the renderer via the emitted hook-event payload — it is
   *  read directly off this object by child-ask-router.ts, which needs the
   *  exact pattern to persist a specialist-keyed "Always allow" as the right
   *  rule rather than an overbroad one. */
  subject?: string;
}
export interface AskDecision {
  behavior: 'allow' | 'deny' | 'canceled';
  /** True when the user chose "Always allow" — caller persists the remembered rule. */
  always?: boolean;
  /** AskUserQuestion answers ride the SAME channel inside decision.updatedInput
   *  (ToolCard's AskUserQuestionCard shape) — dropped for ordinary permission
   *  asks, load-bearing for interactive tools. */
  updatedInput?: Record<string, unknown>;
  /** Task 8: model-facing copy carried through a deny. A REAL user decline
   *  leaves this unset — harness-session.ts falls back to its own generic
   *  "the user declined" copy, which is accurate for that case. A specialist
   *  ask that TIMED OUT sets this to ASK_REDIRECT_MESSAGE (child-ask-router.ts)
   *  so the model reads the true reason (still pending, not refused) instead
   *  of a sentence that blames a user who never actually answered. */
  message?: string;
}

/** Task 8: the shape handed to a late-response handler — everything about the
 *  original ask EXCEPT the resolver (already spent) and the timer (already
 *  cleared). */
export type LateResponseEntry = {
  sessionId: string;
  toolName: string;
  raisedBy?: string;
  specialist?: AskRequest['specialist'];
  /** Task 11 fix pass (Finding 2): the original ask's permission-engine
   *  SUBJECT, carried through so a LATE "Always allow" can persist the same
   *  rule the in-time path (child-ask-router.ts) would have written. Before
   *  this field existed, `onLateResponse` had no way to name what was being
   *  approved — it could only steer or notify, never remember. */
  subject?: string;
};
export type LateResponseHandler = (entry: LateResponseEntry, decision: AskDecision) => void;

interface PendingAsk {
  sessionId: string;
  toolName: string;
  raisedBy?: string;
  specialist?: AskRequest['specialist'];
  /** Task 11 fix pass (Finding 2): carried from AskRequest.subject through to
   *  a late response — see LateResponseEntry.subject's own WHY. */
  subject?: string;
  resolve: (d: AskDecision) => void;
  timer?: ReturnType<typeof setTimeout>;
  /** Task 8: true once the hold timeout has fired and already resolved the
   *  ask's promise with onTimeout()'s decision. The entry is DELIBERATELY
   *  left in `pending` after that — "the ask stays answerable" means a real
   *  user decision can still arrive later. `respond()` reads this flag to
   *  route a late decision to `lateResponseHandler` instead of calling
   *  `resolve` again (which would silently no-op on an already-settled
   *  promise and lose the real answer). */
  timedOut: boolean;
}

export class PermissionBroker extends EventEmitter {
  private pending = new Map<string, PendingAsk>();
  private lateResponseHandler?: LateResponseHandler;

  /** Task 8: the ONE handler invoked when a real response arrives for an ask
   *  that already timed out. A setter rather than a constructor arg because
   *  NativeSessionHost wires this after constructing both itself and the
   *  broker (the handler closes over the host's live-session map). */
  setLateResponseHandler(handler: LateResponseHandler): void {
    this.lateResponseHandler = handler;
  }

  /** `opts` (Task 8) lets a caller hold this ask open only up to `timeoutMs`
   *  before deciding it FOR the model via `onTimeout()` — the entry stays in
   *  `pending` afterward (see PendingAsk.timedOut) so a real answer is never
   *  lost, only redirected once the deadline has passed. */
  ask(req: AskRequest, opts?: { timeoutMs?: number; onTimeout?: () => AskDecision }): Promise<AskDecision> {
    const requestId = `native-${randomUUID()}`;
    return new Promise<AskDecision>((resolve) => {
      const entry: PendingAsk = {
        sessionId: req.sessionId,
        toolName: req.toolName,
        raisedBy: req.raisedBy,
        specialist: req.specialist,
        subject: req.subject,
        resolve,
        timedOut: false,
      };
      this.pending.set(requestId, entry);
      if (opts?.timeoutMs !== undefined && opts.onTimeout) {
        const onTimeout = opts.onTimeout;
        entry.timer = setTimeout(() => {
          entry.timer = undefined;
          entry.timedOut = true;
          resolve(onTimeout());
          // NOT deleted from `pending` — see PendingAsk.timedOut's own WHY.
        }, opts.timeoutMs);
      }
      // Payload field names MUST match what hook-dispatcher extracts
      // (src/renderer/state/hook-dispatcher.ts): tool_name, tool_input,
      // _requestId. denyListed rides along for the Task 13 warning, `external`
      // the same way so ToolCard can hide Always-allow, and `specialist`
      // (Task 8) so a future card revision can label which child raised it.
      this.emit('hook-event', {
        sessionId: req.sessionId,
        type: 'PermissionRequest',
        payload: {
          _requestId: requestId,
          tool_name: req.toolName,
          tool_input: req.toolInput,
          denyListed: req.denyListed,
          external: req.external === true,
          ...(req.specialist ? { specialist: req.specialist } : {}),
        },
        timestamp: Date.now(),
      });
    });
  }

  /** Returns false when the id isn't ours — caller falls through to hookRelay. */
  respond(requestId: string, decision: Record<string, unknown>): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    // ToolCard's PermissionButtons send { decision: { behavior }, updatedPermissions? }
    // (see src/renderer/components/ToolCard.tsx). Unwrap that nested shape;
    // fall back to a flat { behavior } for direct callers/tests. "Always allow"
    // is signaled by a non-empty updatedPermissions array.
    const inner = (decision.decision as Record<string, unknown> | undefined) ?? decision;
    const behavior = inner.behavior === 'allow' ? 'allow' : 'deny';
    // "Always allow" is signaled by a non-empty updatedPermissions array — but
    // ONLY meaningful on an allow. A deny+updatedPermissions must NOT become an
    // allow-always rule (Task 12 persists on `always`), so gate on behavior.
    const always =
      behavior === 'allow' &&
      Array.isArray(decision.updatedPermissions) &&
      decision.updatedPermissions.length > 0;
    // AskUserQuestion answers ride inside decision.updatedInput (the same nested
    // shape the card sends). Thread it through UNTOUCHED — it is NOT
    // updatedPermissions and must never influence `always`.
    const updatedInput = inner.updatedInput && typeof inner.updatedInput === 'object'
      ? (inner.updatedInput as Record<string, unknown>) : undefined;
    const resolved: AskDecision = { behavior, always, ...(updatedInput ? { updatedInput } : {}) };

    if (entry.timedOut) {
      // Task 8: the entry's own promise already settled (with the redirect,
      // via onTimeout) — this respond() call IS the "later answer" the spec
      // requires never gets silently dropped. There is nothing left to
      // resolve, so route it to whoever is tracking this ask's real outcome
      // instead (NativeSessionHost.onLateResponse) rather than calling
      // `entry.resolve` again, which would just no-op.
      this.pending.delete(requestId);
      if (this.lateResponseHandler) {
        this.lateResponseHandler(
          {
            sessionId: entry.sessionId, toolName: entry.toolName, raisedBy: entry.raisedBy,
            specialist: entry.specialist, subject: entry.subject,
          },
          resolved,
        );
      } else {
        // No handler wired — real production wiring always calls
        // setLateResponseHandler once at construction (native-session-host.ts),
        // so this only fires for a broker built without that wiring (a test,
        // or a future caller that forgot). Logged rather than thrown so a
        // renderer response can never crash the main process; still visible
        // rather than a silent loss.
        log('WARN', 'PermissionBroker', 'a late response arrived for a timed-out ask with no lateResponseHandler wired — the answer was not delivered anywhere', { requestId, sessionId: entry.sessionId, toolName: entry.toolName });
      }
      return true;
    }

    if (entry.timer) clearTimeout(entry.timer); // exit path: respond() before the deadline
    this.pending.delete(requestId);
    entry.resolve(resolved);
    return true;
  }

  cancelSession(sessionId: string): void {
    for (const [id, entry] of [...this.pending]) {
      // Task 8: `sessionId` (the card's HOME session) always cancels,
      // regardless of timeout state — a parent interrupt/destroy must clear
      // a routed ask off its own screen even after the redirect already
      // fired. `raisedBy` (the CHILD that raised a routed ask) only cancels
      // while the ask is STILL WITHIN its window: once it has timed out, the
      // ask now belongs to the PARENT's screen, and tearing down the CHILD —
      // which runDelegation's finally does on EVERY run, success or failure —
      // must not also erase an ask a real user might still answer. Without
      // this guard, every specialist run's own normal teardown would cancel
      // its own already-timed-out ask the instant the child finished,
      // breaking the "a later answer is not thrown away" guarantee.
      const raisedByMatch = entry.raisedBy === sessionId && !entry.timedOut;
      if (entry.sessionId !== sessionId && !raisedByMatch) continue;
      this.cancelOne(id, entry);
    }
  }

  /** Cancel EVERY pending ask (app-shutdown / destroyAll). Unconditional —
   *  app shutdown has no "someone might still answer this" case to protect. */
  cancelAll(): void {
    for (const [id, entry] of [...this.pending]) {
      this.cancelOne(id, entry);
    }
  }

  private cancelOne(id: string, entry: PendingAsk): void {
    if (entry.timer) clearTimeout(entry.timer); // exit path: cancel
    this.pending.delete(id);
    // PermissionExpired clears the approval card; _requestId matches the field
    // hook-dispatcher reads for the expired branch.
    this.emit('hook-event', {
      sessionId: entry.sessionId,
      type: 'PermissionExpired',
      payload: { _requestId: id },
      timestamp: Date.now(),
    });
    entry.resolve({ behavior: 'canceled' });
  }
}
