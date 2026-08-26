// The Preview / Resume pair, shared by the find rows, the show card, and the
// drawer's Referenced list, so no surface can word a disabled state differently.
import { Button } from '../ui';
import { COPY, type ResolvedConversation } from '../../../shared/chatsearch-refs';

type Ok = Extract<ResolvedConversation, { status: 'ok' }>;

export function resumeBlockedReason(c: Ok): string | null {
  if (c.missingProject) return COPY.resumeMissingProject;
  if (c.notSyncedYet) return COPY.resumeNotSynced;
  return null;
}
export function requestPreview(c: Ok): void {
  window.dispatchEvent(new CustomEvent('youcoded:preview-session', { detail: { provider: c.provider, id: c.id, title: c.title } }));
}
export function requestResume(c: Ok): void {
  // App.tsx listens and calls handleResumeSession with exactly these four;
  // the native lane lands in the model picker because provider is threaded.
  window.dispatchEvent(new CustomEvent('youcoded:resume-session', { detail: { claudeSessionId: c.id, projectSlug: c.projectSlug, projectPath: c.projectPath, provider: c.provider } }));
}

// Task 4 (defect 1 from the compare rounds): these used to hand-roll their own
// button classes from raw utility strings. Now they go through the real
// Button primitive — same variant/size vocabulary as everything else in the
// app — with `size` threaded through as-is (Button's own sm/md map directly
// onto what this component already offered).
export default function SessionRefActions({ conversation, size = 'sm' }: { conversation: Ok; size?: 'sm' | 'md' }) {
  const blocked = resumeBlockedReason(conversation);
  const native = conversation.provider === 'native';
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <Button
        variant="secondary"
        size={size}
        disabled={conversation.tombstone}
        title={conversation.tombstone ? COPY.previewTombstone : COPY.previewHint}
        onClick={() => requestPreview(conversation)}
      >
        {COPY.preview}
      </Button>
      <Button
        variant="primary"
        size={size}
        disabled={!!blocked}
        title={blocked ?? (native ? COPY.resumeNativeHint : COPY.resumeHint)}
        onClick={() => requestResume(conversation)}
      >
        {native ? COPY.resumeNative : COPY.resume}
      </Button>
    </div>
  );
}
