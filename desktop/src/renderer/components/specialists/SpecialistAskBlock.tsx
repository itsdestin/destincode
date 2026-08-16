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
export function SpecialistAskBlock({ segment, sessionId, specialistName }: { segment: ToolSegment; sessionId?: string; specialistName?: string }) {
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
  return (
    <div data-testid="nested-ask" className="border-t border-edge/60 bg-canvas/40">
      {segment.external && (
        <p className="px-3 pt-2 text-xs text-fg-muted">
          This is outside the project folder, so {who} has to ask each time — there is no “Always allow” for it.
        </p>
      )}
      {segment.askHeld && (
        <p className="px-3 pt-2 text-xs text-amber-500" data-testid="nested-ask-held">
          Five minutes passed with no answer, so {who} was told to carry on without this.
          You can still answer — a Yes now is delivered as a follow-up.
        </p>
      )}
      <PermissionButtons
        requestId={requestId}
        denyListed={segment.denyListed}
        permissionMode={segment.permissionMode}
        command={typeof segment.input?.command === 'string' ? (segment.input.command as string) : undefined}
        folderName={sessionCwd ? sessionCwd.split(/[\\/]/).filter(Boolean).pop() : undefined}
        suppressAlwaysAllow={segment.external === true}
        onResponded={onResponded}
        onFailed={onFailed}
      />
    </div>
  );
}

