import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useChatState, useChatDispatch } from '../state/chat-context';
import UserMessage from './UserMessage';
import AssistantTurnBubble from './AssistantTurnBubble';
import ToolCard from './ToolCard';
import PromptCard from './PromptCard';
import UsageCard from './UsageCard';
import SystemMarker from './SystemMarker';
import CompactingCard from './CompactingCard';
import CopyPicker from './CopyPicker';
import ThinkingIndicator from './ThinkingIndicator';
import AttentionBanner from './AttentionBanner';
import { useAttentionClassifier } from '../hooks/useAttentionClassifier';
import { useTheme } from '../state/theme-context';
import { useArtifact } from '../state/ArtifactContext';
import { SessionDrawer } from './SessionDrawer';
import { ContentFindBar } from './ContentFindBar';

interface Props {
  sessionId: string;
  visible: boolean;
  resumeInfo?: Map<string, { claudeSessionId: string; projectSlug: string }>;
  /** Working directory of the session — used to resolve the active project for the artifact drawer. */
  cwd?: string;
  /** Game pane content, when the multiplayer panel is open. Rendered in the
   *  framed-shell's right slot (same chrome as the artifact drawer). Only the
   *  active session's ChatView receives this — App passes null otherwise. When
   *  present it takes precedence over the artifact drawer in the right slot. */
  gamePane?: React.ReactNode;
}

function HistoryExpandButton({ sessionId, resumeInfo }: {
  sessionId: string;
  resumeInfo?: Map<string, { claudeSessionId: string; projectSlug: string }>;
}) {
  const dispatch = useChatDispatch();
  const [loading, setLoading] = useState(false);

  const handleExpand = async () => {
    const info = resumeInfo?.get(sessionId);
    if (!info) return;
    setLoading(true);
    try {
      const allMessages = await (window as any).claude.session.loadHistory(
        info.claudeSessionId, info.projectSlug, 0, true
      );
      if (allMessages.length > 0) {
        dispatch({
          type: 'HISTORY_LOADED',
          sessionId,
          messages: allMessages,
          hasMore: false,
        });
      }
    } catch {
      // Ignore
    }
    setLoading(false);
  };

  return (
    <div className="flex justify-center py-3">
      <button
        onClick={handleExpand}
        disabled={loading}
        className="text-xs text-fg-muted hover:text-fg-2 transition-colors disabled:opacity-50"
      >
        {loading ? 'Loading...' : '\u2191 See previous messages'}
      </button>
    </div>
  );
}

export default function ChatView({ sessionId, visible, resumeInfo, cwd, gamePane }: Props) {
  const state = useChatState(sessionId);
  const dispatch = useChatDispatch();
  const { showTimestamps } = useTheme();
  // Artifact drawer state — read from ArtifactContext so ChatView reacts to
  // the drawer toggle without needing a prop threaded down from App.tsx.
  const { state: artifactState, dispatch: artifactDispatch } = useArtifact();
  // Drawer open/closed is per-session — read this session's flag (absent → closed).
  const drawerOpen = artifactState.drawerOpenBySession[sessionId] ?? false;
  const drawerExpanded = artifactState.drawerExpanded;
  // The game pane and artifact drawer share the framed-shell's right slot.
  // The game pane wins when both are somehow open (App also enforces mutual
  // exclusivity, so this is just a render-time safety net).
  const gameOpen = !!gamePane;
  // Either occupant means the right slot is in use → frame the chat accordingly.
  const rightPaneOpen = gameOpen || drawerOpen;

  // Resolve the active project when the artifact drawer opens. We need
  // projectRoot / projectId / projectName to pass to SessionDrawer so its
  // in-place edit `save` IPC call knows which project sidecar to write.
  // The lookup is lazy (only fires when drawerOpen && cwd is available) and
  // non-blocking — SessionDrawer renders with empty strings until it resolves.
  const [activeProject, setActiveProject] = useState<{
    id: string;
    name: string;
    path: string;
  } | null>(null);

  useEffect(() => {
    if (!drawerOpen || !cwd) {
      setActiveProject(null);
      return;
    }
    (window.claude as any).artifacts.listProjectsIndex().then((res: any) => {
      if (!res || !res.ok || !Array.isArray(res.projects)) {
        // Fallback: pass cwd as the path so the save IPC can still locate the
        // sidecar directory — the handler uses projectRoot as a filesystem path,
        // not as a registry lookup key, so this works even without an index entry.
        setActiveProject({ id: '', name: 'project', path: cwd });
        return;
      }
      // Normalize separators for comparison (Windows paths use backslashes).
      const normalizedCwd = cwd.replace(/\\/g, '/');
      const candidate = (res.projects as Array<{ id: string; name: string; path: string }>).find(
        (p) => p.path === cwd || p.path === normalizedCwd || p.path === normalizedCwd.toLowerCase(),
      );
      if (candidate) {
        setActiveProject({ id: candidate.id, name: candidate.name, path: candidate.path });
      } else {
        // cwd not in the index yet (ensureProject may not have fired) — fall
        // back to raw cwd so the drawer still has a valid root path.
        setActiveProject({ id: '', name: 'project', path: cwd });
      }
    }).catch(() => {
      // IPC failure — still provide cwd so the drawer is not completely broken.
      if (cwd) setActiveProject({ id: '', name: 'project', path: cwd });
    });
  }, [drawerOpen, cwd]);

  // Backfill this session's artifact list from the on-disk sidecar so the chat
  // artifact drawer AND inline filepath pills work immediately after an app
  // reload/restart. WHY: the live tracker (App.tsx) only APPENDS to
  // sessionArtifacts on NEW transcript Write/Edit events — without this, a reload
  // leaves the list empty until the next file write, so the drawer shows
  // "0 artifacts" and clicking an inline pill falls back to opening Project View
  // (its no-match behavior) instead of the file. listSession reads the sidecar at
  // cwd and filters by sessionId; the live tracker keeps it current afterward.
  // Not gated on drawerOpen — pills can be clicked without opening the drawer.
  useEffect(() => {
    if (!cwd || !sessionId) return;
    // Remember this session's cwd so the inline filepath pills (rendered deep in
    // markdown, without a cwd prop) can resolve a clicked path against the whole
    // project's artifacts.
    artifactDispatch({ type: 'SET_SESSION_CWD', sessionId, cwd });
    let cancelled = false;
    (window.claude as any).artifacts?.listSession?.(sessionId, cwd)
      .then((res: any) => {
        if (cancelled || !res?.ok || !Array.isArray(res.artifacts)) return;
        artifactDispatch({ type: 'SESSION_ARTIFACTS_LOADED', sessionId, artifacts: res.artifacts });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [cwd, sessionId, artifactDispatch]);

  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  // Ctrl+F find-over-chat-history. Searches the message timeline (contentRef)
  // via the same CSS-Highlight ContentFindBar the artifact viewer uses.
  const [findOpen, setFindOpen] = useState(false);

  // Single pass — compute all tool status flags, memoized to avoid re-iterating
  // the Map on every render (toolCalls is a new ref on every reducer dispatch)
  const { hasAwaitingApproval, hasRunningTools, awaitingTools } = useMemo(() => {
    let hasAwaiting = false;
    let hasRunning = false;
    const awaiting: any[] = [];
    for (const id of state.activeTurnToolIds) {
      const t = state.toolCalls.get(id);
      if (!t) continue;
      if (t.status === 'awaiting-approval') {
        hasAwaiting = true;
        awaiting.push(t);
      } else if (t.status === 'running') {
        hasRunning = true;
      }
    }
    return { hasAwaitingApproval: hasAwaiting, hasRunningTools: hasRunning, awaitingTools: awaiting };
  }, [state.toolCalls, state.activeTurnToolIds]);

  // Find the most recent assistant turn's Anthropic request ID — surfaced on
  // the AttentionBanner only for session-died / error so users can cite it
  // when reporting an issue. Walk the timeline from the end for O(1) typical cost.
  const lastTurnRequestId = useMemo(() => {
    for (let i = state.timeline.length - 1; i >= 0; i--) {
      const entry = state.timeline[i];
      if (entry.kind === 'assistant-turn') {
        return state.assistantTurns.get(entry.turnId)?.anthropicRequestId ?? null;
      }
    }
    return null;
  }, [state.timeline, state.assistantTurns]);

  // PTY-buffer classifier drives the attention banner. Replaces the old
  // 30s thinking-timeout watchdog + TERMINAL_ACTIVITY heartbeat — the hook
  // reads the xterm buffer directly and decides 'ok' vs. 'stuck'/'shell-idle'/etc.
  useAttentionClassifier(sessionId, {
    isThinking: state.isThinking,
    hasRunningTools,
    hasAwaitingApproval,
    visible,
    currentAttentionState: state.attentionState,
  });

  // Scroll container directly to scrollHeight instead of using
  // bottomRef.scrollIntoView. Why: .chat-scroll has padding-bottom equal to
  // --bottom-chrome-height so the last message clears the input bar. The sentinel
  // sits ABOVE that padding, so scrollIntoView({block:'end'}) stops short of the
  // true bottom by exactly chrome-height — leaving the last message behind the
  // input bar. scrollTop = scrollHeight always reaches the real bottom.
  const scrollToBottom = useCallback(() => {
    const c = scrollContainerRef.current;
    if (c) c.scrollTop = c.scrollHeight;
  }, []);

  // Scroll to bottom on tab switch / mount. The follow-up ResizeObserver below
  // handles the chrome-height race (input bar can differ per session).
  useEffect(() => {
    if (!visible) return;
    const raf = requestAnimationFrame(scrollToBottom);
    return () => cancelAnimationFrame(raf);
  }, [visible, scrollToBottom]);

  // Fix: input bar height can differ between sessions (drafts, multi-line),
  // so --bottom-chrome-height changes right after tab switch. App's ResizeObserver
  // updates the CSS var asynchronously, which grows .chat-scroll's padding-bottom
  // AFTER we already scrolled — leaving the last message a few px behind the bar.
  // Re-snap to bottom whenever the chrome-wrapper resizes while atBottom && visible.
  useEffect(() => {
    if (!visible) return;
    // Fix: target the BOTTOM chrome-wrapper (input bar) specifically — there are
    // two .chrome-wrapper elements in App.tsx (header + bottom), and plain
    // querySelector returns the first (header), whose height doesn't change per
    // session. The bottom bar is the one whose height varies with drafts/multi-line.
    const chrome = document.querySelector('.chrome-wrapper--bottom');
    if (!chrome) return;
    const observer = new ResizeObserver(() => {
      if (atBottomRef.current) scrollToBottom();
    });
    observer.observe(chrome);
    return () => observer.disconnect();
  }, [visible, scrollToBottom]);

  // Track whether user is scrolled to bottom
  useEffect(() => {
    const sentinel = bottomRef.current;
    if (!sentinel) return;

    const observer = new IntersectionObserver(
      ([entry]) => setAtBottom(entry.isIntersecting),
      { threshold: 0.1, rootMargin: '0px 0px 150px 0px' },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, []);

  // Auto-scroll when new content arrives and user is at bottom.
  // Uses lastActivityAt (a timestamp that updates on content-producing actions)
  // instead of Map references which changed on every reducer dispatch.
  useEffect(() => {
    if (atBottom) scrollToBottom();
  }, [state.timeline.length, state.lastActivityAt, state.isThinking, atBottom, scrollToBottom]);

  // Fix: when a tool/permission card expands at the bottom of the chat, its new
  // content grows below the input bar and the user has to manually scroll. The
  // reducer-based effect above doesn't fire because expansion is local ToolCard
  // state, invisible to ChatView. Watch the content wrapper's size instead and
  // re-stick to bottom on any growth while atBottom is true.
  const contentRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(atBottom);
  useEffect(() => {
    atBottomRef.current = atBottom;
  }, [atBottom]);
  useEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    let lastHeight = node.scrollHeight;
    const observer = new ResizeObserver(() => {
      const next = node.scrollHeight;
      if (next > lastHeight && atBottomRef.current) {
        scrollToBottom();
      }
      lastHeight = next;
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [scrollToBottom]);

  const jumpToBottom = useCallback(() => {
    const c = scrollContainerRef.current;
    if (c) c.scrollTo({ top: c.scrollHeight, behavior: 'smooth' });
  }, []);

  // IntersectionObserver for backdrop-filter optimization: only apply blur
  // to visible bubbles on wallpaper themes (reduces GPU compositing cost)
  const bubbleObserverRef = useRef<IntersectionObserver | null>(null);
  useEffect(() => {
    bubbleObserverRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          entry.target.classList.toggle('in-view', entry.isIntersecting);
        }
      },
      { rootMargin: '200px 0px' },
    );
    return () => bubbleObserverRef.current?.disconnect();
  }, []);

  const observeEntry = useCallback((el: HTMLDivElement | null) => {
    if (el) bubbleObserverRef.current?.observe(el);
  }, []);

  // Arrow key scrolling with acceleration when not typing
  const scrollSpeed = useRef(0);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (document.activeElement?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;
      if (e.shiftKey || e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;

      e.preventDefault();
      const container = scrollContainerRef.current;
      if (!container) return;

      // Accelerate: start at 40px, increase by 20px per repeat, cap at 300px
      scrollSpeed.current = Math.min(scrollSpeed.current + 20, 300);
      const direction = e.key === 'ArrowUp' ? -1 : 1;
      container.scrollBy({ top: direction * scrollSpeed.current, behavior: 'auto' });
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        scrollSpeed.current = 0;
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('keyup', onKeyUp, true);
    };
  }, []);

  // Ctrl/Cmd+F opens the chat-history find bar. Only the visible ChatView
  // responds (one per session is mounted). Defers to the artifact drawer's own
  // find when the pointer is over the drawer — that handler preventDefaults in
  // its hover case, and we additionally bail on drawer-hover so the two never
  // both open regardless of which window listener runs first.
  useEffect(() => {
    if (!visible) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || (e.key !== 'f' && e.key !== 'F')) return;
      if (e.defaultPrevented) return;
      const drawer = document.querySelector('.framed-shell .drawer-pane');
      if (drawer && drawer.matches(':hover')) return; // drawer owns find when hovered
      e.preventDefault();
      setFindOpen(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [visible]);

  // Wheel scroll acceleration: rapid successive touchpad/mousewheel flicks
  // compound — the 5th flick in a row scrolls farther than the 1st. A pause
  // (~350ms) resets the multiplier so an intentional small scroll stays small.
  // Mirrors the arrow-key acceleration pattern above but for wheel input.
  //
  // Important: a single touchpad flick fires ~20-30 wheel events (initial
  // input + OS momentum tail). We only bump the multiplier at the START of a
  // new burst (gap > BURST_GAP since last bump) so one flick stays at 1x;
  // only a SECOND deliberate flick within RESET_MS compounds.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    let multiplier = 1;
    let lastWheelTime = 0;
    let lastBumpTime = 0;
    const RESET_MS = 350;
    const BURST_GAP = 120;
    const STEP = 0.25;
    const MAX = 4;

    const onWheel = (e: WheelEvent) => {
      // Let browser zoom (Ctrl+wheel) pass through untouched
      if (e.ctrlKey) return;
      if (Math.abs(e.deltaY) < 1) return;

      const now = performance.now();
      const gapSinceLastEvent = now - lastWheelTime;
      const gapSinceLastBump = now - lastBumpTime;

      if (gapSinceLastEvent > RESET_MS) {
        // Long pause — reset to baseline (next flick = 1x)
        multiplier = 1;
        lastBumpTime = now;
      } else if (gapSinceLastBump > BURST_GAP) {
        // New flick after previous flick's momentum settled — compound
        multiplier = Math.min(multiplier + STEP, MAX);
        lastBumpTime = now;
      }
      // else: mid-burst momentum events — leave multiplier alone
      lastWheelTime = now;

      e.preventDefault();
      container.scrollBy({ top: e.deltaY * multiplier, behavior: 'auto' });
    };

    // Non-passive so preventDefault() works and our delta replaces native scroll
    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  const handlePromptSelect = useCallback(
    (promptId: string, input: string, label: string, promptTitle?: string) => {
      // Resume-from-summary tie-in: clicking "Resume from summary" (or similar)
      // on the Resume Session prompt triggers Claude Code's compaction flow.
      // Dispatch COMPACTION_PENDING NOW so the spinner appears immediately —
      // otherwise the user watches a blank chat for 15-30s with no feedback.
      // Completion is detected via first-turn-complete fallback in App.tsx
      // (resume creates a new JSONL file, so transcript-shrink never fires).
      if (promptTitle === 'Resume Session' && /summar/i.test(label)) {
        dispatch({
          type: 'COMPACTION_PENDING',
          sessionId,
          cardId: `compact-resume-${Date.now()}`,
          beforeContextTokens: null, // Resume doesn't have pre-compaction stats
        });
      }
      // Send keystrokes to PTY to navigate the Ink menu
      window.claude.session.sendInput(sessionId, input);
      // Mark the prompt as completed in the UI
      dispatch({
        type: 'COMPLETE_PROMPT',
        sessionId,
        promptId,
        selection: label,
      });
    },
    [sessionId, dispatch],
  );

  return (
    <div
      // Fix: previously toggled display:none/flex, which forced a full reflow of
      // both views on every chat↔terminal toggle (the #1 cause of visual jank
      // reports). Using visibility+opacity+pointer-events keeps the layout box
      // stable across toggles — no reflow, no flash, and focus/IME survive.
      // `inert` removes hidden subtree from tab order + a11y tree.
      inert={!visible}
      aria-hidden={visible ? undefined : true}
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        display: 'flex',
        flexDirection: 'column',
        visibility: visible ? 'visible' : 'hidden',
        opacity: visible ? 1 : 0,
        pointerEvents: visible ? 'auto' : 'none',
      }}
    >
      {/* framed-shell: horizontal flex row holding the chat pane + optional
          Session Drawer. The frame-edge strips are filled with --panel so the
          chat area reads as inset inside header/status-bar chrome (Task 6.2).
          Floating themes suppress the edge fill via [data-theme-layout] on <html>.
          projectRoot/projectId/projectName are stubbed with empty strings — these
          are only needed by the drawer's artifacts.save IPC call and will be
          resolved in a later task when session metadata is threaded to ChatView. */}
      {/* drawer-open modifier collapses chat pane on narrow screens (Task 6.3) */}
      <div className={`framed-shell${rightPaneOpen ? ' drawer-open' : ''}${drawerExpanded && !gameOpen ? ' drawer-expanded' : ''}`}>
        <div className="frame-edge" />
        <div className="chat-pane">
          {/* Chat-history find bar — sibling of (not inside) the scroll/content
              container so its own text isn't matched. Anchored below the
              overlaid header chrome via the top offset. */}
          {findOpen && (
            <ContentFindBar
              containerRef={contentRef}
              scrollRef={scrollContainerRef}
              highlightName="chat-find"
              placeholder="Find in chat"
              positionClassName="right-3 top-[calc(var(--top-chrome-height,3rem)+0.5rem)]"
              resetKey={sessionId}
              onClose={() => setFindOpen(false)}
            />
          )}
          <div ref={scrollContainerRef} className="chat-scroll h-full overflow-y-auto">
           <div ref={contentRef}>
        {state.timeline.length === 0 && !state.isThinking ? (
          <div className="flex items-center justify-center h-full text-fg-muted text-sm">
            Start a conversation with Claude
          </div>
        ) : (
          <>
            {(() => {
              // Find the most recent compaction marker so we can visually fade
              // entries above it — Claude's context is just the post-compaction
              // summary, so pre-compaction messages are "archived" from its POV.
              // Fading signals this without hiding history the user may want to re-read.
              let lastCompactIdx = -1;
              for (let i = state.timeline.length - 1; i >= 0; i--) {
                const e = state.timeline[i];
                if (e.kind === 'system-marker' && e.marker.variant === 'compact') {
                  lastCompactIdx = i;
                  break;
                }
              }
              return state.timeline.map((entry, idx) => {
                const isPreCompaction = lastCompactIdx >= 0 && idx < lastCompactIdx;
              let key: string;
              let content: React.ReactNode;
              switch (entry.kind) {
                case 'user':
                  key = entry.message.id;
                  content = <UserMessage message={entry.message} showTimestamps={showTimestamps} />;
                  break;
                case 'assistant-turn': {
                  const turn = state.assistantTurns.get(entry.turnId);
                  if (!turn || turn.segments.length === 0) return null;
                  key = entry.turnId;
                  content = (
                    <AssistantTurnBubble
                      turn={turn}
                      toolGroups={state.toolGroups}
                      toolCalls={state.toolCalls}
                      sessionId={sessionId}
                      showTimestamps={showTimestamps}
                    />
                  );
                  break;
                }
                case 'prompt':
                  if (entry.prompt.promptId === '_history_expand' && !entry.prompt.completed) {
                    return (
                      <div key={entry.prompt.promptId} ref={observeEntry} className="timeline-entry">
                        <HistoryExpandButton sessionId={sessionId} resumeInfo={resumeInfo} />
                      </div>
                    );
                  }
                  key = entry.prompt.promptId;
                  content = (
                    <PromptCard
                      prompt={entry.prompt}
                      sessionId={sessionId}
                      onSelect={(input, label) => handlePromptSelect(entry.prompt.promptId, input, label, entry.prompt.title)}
                    />
                  );
                  break;
                // /cost and /usage snapshot — entryId is the stable key since the
                // same snapshot object is kept in state across re-renders.
                case 'usage-card':
                  key = entry.snapshot.entryId;
                  content = <UsageCard snapshot={entry.snapshot} />;
                  break;
                // /clear and /compact dividers
                case 'system-marker':
                  key = entry.marker.id;
                  content = <SystemMarker marker={entry.marker} />;
                  break;
                // /compact spinner (and resume-from-summary)
                case 'compacting':
                  key = entry.id;
                  content = <CompactingCard startedAt={entry.startedAt} />;
                  break;
                // /copy multi-block picker
                case 'copy-picker': {
                  key = entry.id;
                  // Capture id in closure so the callbacks work after TS narrowing.
                  const pickerId = entry.id;
                  content = (
                    <CopyPicker
                      id={pickerId}
                      options={entry.options}
                      onCopy={(text, label) => {
                        navigator.clipboard.writeText(text).catch(() => {});
                        dispatch({ type: 'DISMISS_COPY_PICKER', sessionId, id: pickerId });
                        // onToast would be nicer but ChatView doesn't have it — minimal UX for now
                        void label;
                      }}
                      onDismiss={() => dispatch({ type: 'DISMISS_COPY_PICKER', sessionId, id: pickerId })}
                    />
                  );
                  break;
                }
              }
              return (
                <div
                  key={key!}
                  ref={observeEntry}
                  className={`timeline-entry in-view${isPreCompaction ? ' opacity-60 transition-opacity' : ''}`}
                  title={isPreCompaction ? 'Archived by compaction — not in Claude\'s active context' : undefined}
                >
                  {content}
                </div>
              );
              });
            })()}
            {/* Awaiting-approval tools (incl. AskUserQuestion) pop out as standalone
                bubbles at the bottom. The `in-view` class is required: theme-engine's
                glass selector is `[data-wallpaper] .in-view .bg-inset` — without an
                `.in-view` ancestor the bubble gets the translucent color-mix but NOT
                the backdrop-filter blur, so it reads as a flat panel instead of frosted
                glass. Normal timeline bubbles get `in-view` from their wrapper; these
                pop-out bubbles aren't in that wrapper, so set it here. They're pinned
                at the bottom and always visible, so a static `in-view` is correct. */}
            {awaitingTools.map((tool) => (
                <div key={tool.toolUseId} className="in-view flex justify-start px-4 py-0.5">
                  <div className="assistant-bubble max-w-[85%] rounded-2xl rounded-bl-sm bg-inset px-5 py-3">
                    <ToolCard tool={tool} sessionId={sessionId} />
                  </div>
                </div>
              ))}
            {/* Only show thinking indicator when Claude is between tool completion
                and next text — not when tools are still running or awaiting approval.
                When the classifier flags a non-ok attention state, swap the
                spinner for an AttentionBanner tailored to the state. */}
            {state.isThinking && !hasAwaitingApproval && !hasRunningTools && (
              state.attentionState === 'ok'
                ? <ThinkingIndicator />
                : <AttentionBanner state={state.attentionState} anthropicRequestId={lastTurnRequestId} />
            )}
          </>
        )}
        <div ref={bottomRef} className="h-1" />
           </div>
          </div>
        </div>
        {/* Right frame edge / divider + Session Drawer — only shown when open.
            projectRoot/projectId/projectName are resolved from the session's
            cwd via listProjectsIndex() in the useEffect above. Until the lookup
            completes they fall back to empty strings / 'project', which is safe
            because SessionDrawer renders an empty list rather than crashing. */}
        {/* Right slot: the game pane takes precedence over the artifact drawer
            (App keeps them mutually exclusive, so normally only one is open).
            Both render as a .drawer-pane so they share the framed chrome; the
            game pane is narrower via --right-pane-width (set by App). */}
        {gameOpen ? (
          <>
            <div className="frame-divider" />
            <div className="drawer-pane game-pane">{gamePane}</div>
          </>
        ) : drawerOpen && (
          <>
            <div className="frame-divider" />
            <div className="drawer-pane">
              <SessionDrawer
                sessionId={sessionId}
                projectRoot={activeProject?.path ?? ''}
                projectId={activeProject?.id ?? ''}
                projectName={activeProject?.name ?? 'project'}
              />
            </div>
          </>
        )}
        <div className="frame-edge" />
      </div>

      {/* Jump to bottom button — .jump-to-bottom class handles glassmorphism
         offset so the button appears above the frosted input bar.
         Positioned in the outer absolute div so it floats above the full
         framed-shell (chat + drawer) without being clipped by chat-pane. */}
      {!atBottom && (
        <button
          onClick={jumpToBottom}
          className="jump-to-bottom absolute bottom-4 left-1/2 -translate-x-1/2 px-3 py-1.5 text-xs bg-inset hover:bg-edge text-fg-2 rounded-full shadow-lg transition-colors z-10"
        >
          Jump to bottom
        </button>
      )}
    </div>
  );
}
