import type React from 'react';
import type { SubagentSegment } from '../../../shared/types';
import { PermissionButtons } from '../ToolCard';
import { useChatDispatch } from '../../state/chat-context';
import { useArtifactOptional } from '../../state/ArtifactContext';

type ToolSegment = Extract<SubagentSegment, { type: 'tool' }>;

/**
 * A helper's permission ask: the SAME PermissionButtons the top-level card
 * uses (same decisions, same "Always allow" derivation, same keyboard
 * handling) — a helper's ask is not a lesser ask. Two additions over the
 * top-level row: an "external" (outside-the-folder) note, and the held-state
 * line once the 5-minute redirect has fired.
 *
 * Rendered in TWO places from one component (Destin, 1c round 1: buttons deep
 * inside a card are impossible to navigate): inside the Task card's Activity
 * row, AND in the specialists popup (SpecialistsChip), which is where asks
 * are managed centrally. Same requestId → answering in either place clears both.
 */
export function SpecialistAskBlock({ segment, sessionId, specialistName, compact = false, leading }: {
  segment: ToolSegment;
  sessionId?: string;
  specialistName?: string;
  /** Popup rows: no border/background chrome, tighter notes — the row supplies the frame. */
  compact?: boolean;
  /** Compact only: the request text, laid out on the SAME line as the buttons
   *  (buttons right-aligned; the line wraps when the request is long). */
  leading?: React.ReactNode;
}) {
  const dispatch = useChatDispatch();
  const artifacts = useArtifactOptional();
  const sessionCwd = sessionId ? artifacts?.state.sessionCwd?.[sessionId] : undefined;
  const requestId = segment.requestId!;
  const who = specialistName ?? 'The specialist';
  const onResponded = () => {
    if (!sessionId) return;
    const action = { type: 'PERMISSION_RESPONDED' as const, sessionId, requestId };
    dispatch(action);
    (window as any).claude?.remote?.broadcastAction(action);
  };
  const onFailed = () => {
    if (!sessionId) return;
    const action = { type: 'PERMISSION_EXPIRED' as const, sessionId, requestId };
    dispatch(action);
    (window as any).claude?.remote?.broadcastAction(action);
  };
  const note = compact ? 'text-2xs leading-snug' : 'px-3 pt-2 text-xs';
  const buttons = (
    <PermissionButtons
      requestId={requestId}
      denyListed={segment.denyListed}
      permissionMode={segment.permissionMode}
      command={typeof segment.input?.command === 'string' ? (segment.input.command as string) : undefined}
      folderName={sessionCwd ? sessionCwd.split(/[\\/]/).filter(Boolean).pop() : undefined}
      suppressAlwaysAllow={segment.external === true}
      onResponded={onResponded}
      onFailed={onFailed}
      bare={compact}
    />
  );
  return (
    <div data-testid="nested-ask" className={compact ? 'space-y-1' : 'border-t border-edge/60 bg-canvas/40'}>
      {compact && leading && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="min-w-0 flex-1">{leading}</div>
          <div className="shrink-0 ml-auto">{buttons}</div>
        </div>
      )}
      {segment.external && (
        <p className={`${note} text-fg-muted`}>
          Outside the project folder — {who} must ask each time; no “Always allow”.
        </p>
      )}
      {segment.askHeld && (
        <p className={`${note} text-amber-500`} data-testid="nested-ask-held">
          No answer for 5 minutes, so {who} carried on without this. Yes still works — it lands as a follow-up.
        </p>
      )}
      {!(compact && leading) && buttons}
    </div>
  );
}

