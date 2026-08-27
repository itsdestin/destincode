// Drawer host for a previewed past conversation. Reads bounded slices through
// chatsearch:read and pages backwards on demand — there is deliberately no
// "load everything" (a 42 MB transcript would cross IPC and be markdown-
// rendered bubble by bubble, inside a 480px pane, on a phone).
import { useCallback, useEffect, useRef, useState } from 'react';
import ConversationTranscript from './project-view/ConversationTranscript';
import { ErrorState } from './ui/states';
import { COPY, READ_TAIL_DEFAULT, type TranscriptMessage, type ChatsearchProvider } from '../../shared/chatsearch-refs';
// SessionDrawer already resolves this same id for its own header (title,
// Resume eligibility, tags — spec A1/A2/A4), but that title never reaches
// this component as a prop (SessionDrawer.tsx is owned by that in-flight
// work and is intentionally left untouched here). Resolving it again here
// keeps the "Ask about this" scaffold (A3) able to name the conversation
// without depending on that other file's wiring — same hook, same IPC call,
// its own doc comment names exactly this kind of caller.
import { useResolvedConversations } from '../hooks/useResolvedConversations';

type Phase = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string };

export default function SessionPreviewPane({ provider, id }: { provider: ChatsearchProvider; id: string }) {
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [loadingOlder, setLoadingOlder] = useState(false);
  // Fix 2: a failed "Load older" reports its error HERE, near the paging
  // control, instead of through `phase` — `phase` stays 'ready' so the
  // messages already on screen are never replaced by a full-pane error.
  const [olderError, setOlderError] = useState<string | null>(null);
  const [scrollKey, setScrollKey] = useState(0);

  // Fix 1: generation token guarding every in-flight read. Bumped by every
  // loadNewest() call (mount, prop swap, or Retry); a response is applied
  // only if the token it captured is still current. WHY: this pane can be
  // reused for a NEW conversation without unmounting (the drawer swaps
  // provider/id in place when the user previews a second conversation before
  // the first finishes loading) — without this guard, the first request's
  // late response would land after the second's and overwrite the correct
  // conversation with the wrong one. Same pattern as ConversationPreview.tsx's
  // `cancelled` flag, generalized to a counter so loadOlder can share it.
  const genRef = useRef(0);

  // Best-effort conversation title for the right-click scaffold (A3) only —
  // nothing here is rendered while this is loading/unresolved, so a slow or
  // failed resolve just means the scaffold falls back to COPY.untitled
  // (build-menu.ts's askPreviewContext), never a broken pane.
  const titleResolved = useResolvedConversations([id]);
  const titleRow = titleResolved.results.find((r) => (r.status === 'ok' ? r.id === id : r.query === id)) ?? null;
  const conversationTitle = titleRow && titleRow.status === 'ok' ? titleRow.title : '';

  const load = useCallback(async (before?: number) => {
    const req = before === undefined ? { provider, id, tail: READ_TAIL_DEFAULT } : { provider, id, tail: READ_TAIL_DEFAULT, before };
    const res = await (window.claude as any).chatsearch.read(req);
    if (!res?.ok) throw new Error(res?.error || 'Unknown error reading the transcript');
    return res as { messages: TranscriptMessage[]; hasMore: boolean };
  }, [provider, id]);

  const loadNewest = useCallback(() => {
    const myGen = ++genRef.current;
    setPhase({ kind: 'loading' }); setMessages([]); setOlderError(null); setLoadingOlder(false);
    return load().then((r) => {
      if (genRef.current !== myGen) return; // superseded — see genRef comment above
      setMessages(r.messages); setHasMore(r.hasMore); setPhase({ kind: 'ready' }); setScrollKey((k) => k + 1);
    }).catch((e) => {
      if (genRef.current !== myGen) return;
      setPhase({ kind: 'error', message: e?.message || String(e) });
    });
  }, [load]);

  useEffect(() => { void loadNewest(); }, [loadNewest]);

  const loadOlder = async () => {
    if (!messages.length) return;
    const beforeSeq = messages[0].seq;
    const myGen = genRef.current; // captured, not bumped: a swap bumps it via loadNewest, which invalidates this response too
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const r = await load(beforeSeq);
      if (genRef.current !== myGen) return;
      setMessages((m) => [...r.messages, ...m]); setHasMore(r.hasMore);
    } catch (e: any) {
      if (genRef.current !== myGen) return;
      // Fix 2: keep the already-loaded messages on screen and report the
      // failure next to "Load older" instead of blowing away the pane. Retry
      // re-runs loadOlder() with the SAME beforeSeq (messages[0] didn't
      // change on failure), so it retries this backwards page, not the
      // newest slice.
      setOlderError(e?.message || String(e));
    } finally {
      if (genRef.current === myGen) setLoadingOlder(false);
    }
  };

  return (
    // bg-canvas: the drawer's <aside> is bg-inset (SessionDrawer.tsx), and so is
    // the assistant bubble ConversationTranscript renders (bg-inset — same
    // token as its own background is exactly the invisible-bubble bug this
    // pane shipped with). The real chat never has this collision because its
    // bubbles sit on the app-shell's bg-canvas, not on another bg-inset
    // surface (ChatView's .chat-pane paints no background of its own — see
    // the comment on that rule in globals.css — so bg-canvas is what's
    // actually behind a real assistant bubble). Painting THIS pane bg-canvas
    // reproduces that same canvas-under-bubble relationship instead of
    // recoloring the shared bubble, so ConversationPreview (which already
    // sits on a contrasting bg-panel via ProjectDetailOverlay's OverlayPanel)
    // doesn't need to change. Precedent for a bg-canvas "well" nested inside
    // this same bg-inset aside: the rename input a few dozen lines up.
    <div className="flex h-full min-h-0 w-full min-w-0 flex-col bg-canvas">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {/* WHY: this pane deliberately has NO header/close of its own — the
            drawer's top bar (SessionDrawer.tsx) already supplies the title
            and the single close button, the same way it does for an open
            file. This pane used to draw a second title/close row here, which
            was the "two X's" bug Destin flagged; don't reintroduce one. The
            read-only/lane info that row used to carry still matters, so it
            gets a quiet caption line instead — no close control, no size
            change to the drawer's own bar. */}
        <div className="mb-2 text-xs text-fg-muted">{COPY.paneSubtitle(provider)}</div>
        {phase.kind === 'loading' && <p className="text-sm text-fg-muted">{COPY.loading}</p>}
        {/* First load has nothing to show behind it, so a full-pane error is correct here. */}
        {phase.kind === 'error' && <ErrorState mode="recoverable" message={`${COPY.errReadPrefix}${phase.message}`} onRetry={() => void loadNewest()} />}
        {phase.kind === 'ready' && (
          <ConversationTranscript messages={messages} scrollToEndKey={scrollKey}
            conversationId={id} conversationTitle={conversationTitle}
            olderHint={hasMore
              ? (
                <div className="py-2 text-center">
                  {olderError ? (
                    <ErrorState mode="recoverable" variant="inline" message={`${COPY.errReadPrefix}${olderError}`} onRetry={() => void loadOlder()} />
                  ) : (
                    <button type="button" className="rounded-md border border-edge bg-well px-3 py-1 text-xs text-fg hover:bg-inset disabled:opacity-50" disabled={loadingOlder} onClick={loadOlder}>{COPY.loadOlder}</button>
                  )}
                </div>
              )
              : <div className="py-2 text-center text-[11.5px] text-fg-muted">— {COPY.startOfConversation} —</div>} />
        )}
      </div>
    </div>
  );
}
