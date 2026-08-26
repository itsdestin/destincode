// Drawer host for a previewed past conversation. Reads bounded slices through
// chatsearch:read and pages backwards on demand — there is deliberately no
// "load everything" (a 42 MB transcript would cross IPC and be markdown-
// rendered bubble by bubble, inside a 480px pane, on a phone).
import { useCallback, useEffect, useState } from 'react';
import ConversationTranscript from './project-view/ConversationTranscript';
import { ErrorState } from './ui/states';
import { COPY, READ_TAIL_DEFAULT, type TranscriptMessage, type ChatsearchProvider } from '../../shared/chatsearch-refs';

type Phase = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

export default function SessionPreviewPane({ provider, id, title, onClose }: { provider: ChatsearchProvider; id: string; title: string; onClose: () => void }) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [scrollKey, setScrollKey] = useState(0);

  const load = useCallback(async (before?: number) => {
    const req = before === undefined ? { provider, id, tail: READ_TAIL_DEFAULT } : { provider, id, tail: READ_TAIL_DEFAULT, before };
    const res = await (window.claude as any).chatsearch.read(req);
    if (!res?.ok) throw new Error(res?.error || 'Unknown error reading the transcript');
    return res as { messages: TranscriptMessage[]; hasMore: boolean };
  }, [provider, id]);

  const loadNewest = useCallback(() => {
    setPhase({ kind: 'loading' }); setMessages([]);
    return load().then((r) => { setMessages(r.messages); setHasMore(r.hasMore); setPhase({ kind: 'ready' }); setScrollKey((k) => k + 1); })
      .catch((e) => setPhase({ kind: 'error', message: e?.message || String(e) }));
  }, [load]);

  useEffect(() => { void loadNewest(); }, [loadNewest]);

  const loadOlder = async () => {
    if (!messages.length) return;
    setLoadingOlder(true);
    try { const r = await load(messages[0].seq); setMessages((m) => [...r.messages, ...m]); setHasMore(r.hasMore); }
    catch (e: any) { setPhase({ kind: 'error', message: e?.message || String(e) }); }
    finally { setLoadingOlder(false); }
  };

  return (
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <div className="flex items-center gap-2 border-b border-edge px-4 py-2">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium text-fg">{title || COPY.untitled}</div>
          <div className="text-xs text-fg-muted">{COPY.paneSubtitle(provider)}</div>
        </div>
        <button type="button" className="rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-well" onClick={onClose} aria-label="Close preview">✕</button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {phase.kind === 'loading' && <p className="text-sm text-fg-muted">Loading…</p>}
        {phase.kind === 'error' && <ErrorState mode="recoverable" message={`${COPY.errReadPrefix}${phase.message}`} onRetry={() => void loadNewest()} />}
        {phase.kind === 'ready' && (
          <ConversationTranscript messages={messages} scrollToEndKey={scrollKey}
            olderHint={hasMore
              ? <div className="py-2 text-center"><button type="button" className="rounded-md border border-edge bg-well px-3 py-1 text-xs text-fg hover:bg-inset disabled:opacity-50" disabled={loadingOlder} onClick={loadOlder}>{COPY.loadOlder}</button></div>
              : <div className="py-2 text-center text-[11.5px] text-fg-muted">— {COPY.startOfConversation} —</div>} />
        )}
      </div>
    </div>
  );
}
