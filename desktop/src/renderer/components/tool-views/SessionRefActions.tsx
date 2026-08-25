// The Preview / Resume pair, shared by the find rows, the show card, and the
// drawer's Referenced list, so no surface can word a disabled state differently.
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

export default function SessionRefActions({ conversation, size = 'sm' }: { conversation: Ok; size?: 'sm' | 'md' }) {
  const blocked = resumeBlockedReason(conversation);
  const native = conversation.provider === 'native';
  const pad = size === 'md' ? 'px-3 py-1.5 text-sm' : 'px-2 py-1 text-xs';
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <button type="button" className={`rounded-md border border-edge bg-well text-fg hover:bg-inset disabled:opacity-50 disabled:cursor-not-allowed ${pad}`}
        disabled={conversation.tombstone} title={conversation.tombstone ? COPY.previewTombstone : COPY.previewHint} onClick={() => requestPreview(conversation)}>
        {COPY.preview}
      </button>
      <button type="button" className={`rounded-md bg-accent text-on-accent hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed ${pad}`}
        disabled={!!blocked} title={blocked ?? (native ? COPY.resumeNativeHint : COPY.resumeHint)} onClick={() => requestResume(conversation)}>
        {native ? COPY.resumeNative : COPY.resume}
      </button>
    </div>
  );
}
