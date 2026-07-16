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

export interface AskRequest {
  sessionId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  /** Winning rule came from the destructive deny-list → renderer shows the
   *  consequence warning on Always-allow (Task 13 consumes this). */
  denyListed: boolean;
}
export interface AskDecision {
  behavior: 'allow' | 'deny' | 'canceled';
  /** True when the user chose "Always allow" — caller persists the remembered rule. */
  always?: boolean;
}

export class PermissionBroker extends EventEmitter {
  private pending = new Map<string, { sessionId: string; resolve: (d: AskDecision) => void }>();

  ask(req: AskRequest): Promise<AskDecision> {
    const requestId = `native-${randomUUID()}`;
    return new Promise<AskDecision>((resolve) => {
      this.pending.set(requestId, { sessionId: req.sessionId, resolve });
      // Payload field names MUST match what hook-dispatcher extracts
      // (src/renderer/state/hook-dispatcher.ts): tool_name, tool_input,
      // _requestId. denyListed rides along for the Task 13 warning.
      this.emit('hook-event', {
        sessionId: req.sessionId,
        type: 'PermissionRequest',
        payload: {
          _requestId: requestId,
          tool_name: req.toolName,
          tool_input: req.toolInput,
          denyListed: req.denyListed,
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
    entry.resolve({ behavior, always });
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
