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
import type { GrantScope } from '../../shared/bash-grant-shapes';

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
  /** The session's permission mode at ask time. Full-auto + denyListed is the
   *  renderer's cue to swap the generic row for the safety-stop footer
   *  (spec 2026-08-12, M5 2b). Optional: CC-path asks never carry it. */
  permissionMode?: 'ask' | 'auto-edit' | 'full-auto';
}
export interface AskDecision {
  behavior: 'allow' | 'deny' | 'canceled';
  /** True when the user chose "Always allow" — caller persists the remembered rule. */
  always?: boolean;
  /** AskUserQuestion answers ride the SAME channel inside decision.updatedInput
   *  (ToolCard's AskUserQuestionCard shape) — dropped for ordinary permission
   *  asks, load-bearing for interactive tools. */
  updatedInput?: Record<string, unknown>;
  /** Which grant width the user picked, when they picked "Always allow".
   *  A SELECTOR, never a pattern: the renderer must not be able to name the rule
   *  it is granting itself — remembered rules are the top precedence layer, above
   *  the destructive deny-list. Always populated on a resolved ask; defaults to
   *  the narrow option. */
  grantScope?: GrantScope;
}

export class PermissionBroker extends EventEmitter {
  private pending = new Map<string, { sessionId: string; resolve: (d: AskDecision) => void }>();

  ask(req: AskRequest): Promise<AskDecision> {
    const requestId = `native-${randomUUID()}`;
    return new Promise<AskDecision>((resolve) => {
      this.pending.set(requestId, { sessionId: req.sessionId, resolve });
      // Payload field names MUST match what hook-dispatcher extracts
      // (src/renderer/state/hook-dispatcher.ts): tool_name, tool_input,
      // _requestId. denyListed rides along for the Task 13 warning, and
      // `external` the same way so ToolCard can hide Always-allow.
      this.emit('hook-event', {
        sessionId: req.sessionId,
        type: 'PermissionRequest',
        payload: {
          _requestId: requestId,
          tool_name: req.toolName,
          tool_input: req.toolInput,
          denyListed: req.denyListed,
          external: req.external === true,
          // Spread-omitted (not `undefined`-valued) so the CC-path payload
          // shape is byte-identical to before this field existed.
          ...(req.permissionMode ? { permissionMode: req.permissionMode } : {}),
        },
        timestamp: Date.now(),
      });
    });
  }

  /** Returns false when the id isn't ours — caller falls through to hookRelay. */
  respond(requestId: string, decision: Record<string, unknown>): boolean {
    const entry = this.pending.get(requestId);
    if (!entry) return false;
    this.pending.delete(requestId);
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
    // Validate to the two literals and FAIL NARROW on anything else. This value
    // is PERSISTED (unlike permissionMode, which is display-only), so it is
    // checked here AND re-derived at the session rather than trusted.
    const grantScope: GrantScope = decision.grantScope === 'wide' ? 'wide' : 'exact';
    entry.resolve({ behavior, always, grantScope, ...(updatedInput ? { updatedInput } : {}) });
    return true;
  }

  cancelSession(sessionId: string): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.sessionId !== sessionId) continue;
      this.cancelOne(id, entry);
    }
  }

  /** Cancel EVERY pending ask (app-shutdown / destroyAll). */
  cancelAll(): void {
    for (const [id, entry] of [...this.pending]) {
      this.cancelOne(id, entry);
    }
  }

  private cancelOne(id: string, entry: { sessionId: string; resolve: (d: AskDecision) => void }): void {
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
