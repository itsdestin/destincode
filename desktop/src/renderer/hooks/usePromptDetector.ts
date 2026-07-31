import { useEffect, useRef } from 'react';
import { parseInkSelect, menuToButtons } from '../parser/ink-select-parser';
import { useChatDispatch, useChatStore } from '../state/chat-context';
import { getVisibleScreenText, onBufferReady } from './terminal-registry';
import { expiredToolIds, nextAbsentCount } from '../state/expired-card-resolver';

// How long to wait before showing a parser-detected prompt, giving the hook
// system time to deliver a PermissionRequest via the named pipe relay.
// Hook events typically arrive 100-200ms after the Ink menu renders.
const PROMPT_DEBOUNCE_MS = 350;

// Only show parser-detected PromptCards for these known setup prompts.
// Permission prompts (Yes/No/Always Allow) are handled exclusively by the
// hook system via ToolCard. Showing them here too causes duplication.
// This also prevents false positives from numbered lists in Claude's output
// that the Ink parser misidentifies as menus.
const SETUP_PROMPT_TITLES = new Set([
  'Trust This Folder?',
  'Choose a Theme',
  'Select Login Method',
  'Skip Permissions Warning',
  'Resume Session', // Stale session resume — lets user choose summary vs full resume
  'Usage Limit Reached', // /rate-limit-options menu — Upgrade / Stop and wait
  'Enable auto mode?', // CC v2.1.83+ first-run opt-in: 4-option auto-mode confirmation
  'Message Flagged', // Fable 5 model-safeguard fallback — Switch model / Edit prompt and retry
  // Startup dialog when CLAUDE.md imports files outside the cwd. Previously it
  // was mislabeled 'Trust This Folder?' by the stale trust anchor and hijacked
  // TrustGate's full-screen takeover; now it gets its own card (2026-07-26).
  'Allow External Imports?',
]);

// After a permission response (PERMISSION_RESPONDED/EXPIRED clears
// awaiting-approval), suppress parser detection for this window. Prevents
// Race 3: PTY redraws the Ink menu briefly while Claude processes the
// response, parser re-detects it as "new" since the guard is cleared.
const POST_PERMISSION_COOLDOWN_MS = 800;

// How long a menu must be absent before we clear lastMenuRef. Prevents
// brief PTY screen flicker (clear → redraw) from resetting the parser's
// duplicate detection, which would cause re-detection of the same menu.
const DISMISS_DEBOUNCE_MS = 600;

/**
 * Monitors xterm.js write completions (via terminal-registry) to detect
 * Ink select menus in the screen buffer.
 *
 * To avoid showing duplicate prompts (parser PromptCard + hook-based ToolCard),
 * new menu detections are debounced. If the hook system delivers a
 * PERMISSION_REQUEST during the debounce window, the pending prompt is
 * cancelled — the ToolCard handles it instead.  If the debounce expires
 * without a hook event (e.g., trust folder prompt, or hooks are down),
 * the PromptCard is shown as a fallback.
 */
export function usePromptDetector() {
  const dispatch = useChatDispatch();
  const store = useChatStore();
  const lastMenuRef = useRef<Map<string, string>>(new Map());
  const pendingTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const dismissTimerRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  // The menu id whose SHOW_PROMPT actually fired, per session. Gates the
  // on-id-change dismissal below: false-positive "menus" (numbered lists in
  // streaming output) churn through ids up to ~60/s, and dispatching a no-op
  // DISMISS_PROMPT for each would run the reducer per buffer flush.
  const shownPromptRef = useRef<Map<string, string>>(new Map());

  // Track when awaiting-approval was last cleared per session, so the parser
  // can suppress re-detection during the post-permission cooldown window.
  const lastPermissionClearedRef = useRef<Map<string, number>>(new Map());
  const prevAwaitingRef = useRef<Map<string, boolean>>(new Map());

  // §2 standing rule: per-session count of consecutive buffer flushes with no
  // Ink menu while an expired card is retained. At 2, resolve the card(s).
  const expiredAbsentRef = useRef<Map<string, number>>(new Map());

  // Perf: detect awaiting-approval transitions in an effect (off the render
  // path) and iterate activeTurnToolIds (current-turn only, per chat-reducer
  // rule #2) rather than the session-lifetime toolCalls Map. With many
  // concurrent sessions accumulating hundreds of tool entries over time, the
  // old render-body loop was O(sessions × toolCalls) on every dispatch.
  // Perf (tranche 1): direct store subscription instead of a [chatState]
  // effect — this hook no longer re-renders its host (AppInner) on every
  // dispatch. Body is unchanged from the previous effect.
  useEffect(() => {
    const check = () => {
      for (const [sid, session] of store.getState()) {
        let hasAwaiting = false;
        for (const toolId of session.activeTurnToolIds) {
          const tool = session.toolCalls.get(toolId);
          if (tool && tool.status === 'awaiting-approval') { hasAwaiting = true; break; }
        }
        const wasAwaiting = prevAwaitingRef.current.get(sid) ?? false;
        if (wasAwaiting && !hasAwaiting) {
          lastPermissionClearedRef.current.set(sid, Date.now());
        }
        prevAwaitingRef.current.set(sid, hasAwaiting);
      }
    };
    check();
    return store.subscribeAll(check);
  }, [store]);

  useEffect(() => {
    const unsub = onBufferReady((sid: string) => {
      // Skip prompt detection when a PermissionRequest approval is active
      // (the hook-based UI is handling the permission flow)
      const sessionState = store.getState().get(sid);
      if (sessionState) {
        // §2 resolver runs BEFORE the awaiting-approval bail below — and that
        // bail must ignore expired cards, or retention switches this whole
        // detector off for the session, taking the resolver itself, the
        // digit-rebind feature, and every unrelated setup PromptCard (trust
        // gate, usage limit, resume) down with it (spec §2b). A retained card
        // stays awaiting-approval indefinitely, so without this exemption the
        // bail below would never fire again for this session.
        const expired = expiredToolIds(sessionState);
        if (expired.length > 0) {
          // Menu-absence standing rule (spec §2): resolve only after the Ink
          // menu has been absent for two consecutive buffer flushes — see
          // expired-card-resolver.ts for why a one-shot check races both ways.
          const expiredScreen = getVisibleScreenText(sid);
          const menuPresent = !!(expiredScreen && parseInkSelect(expiredScreen));
          const prev = expiredAbsentRef.current.get(sid) ?? 0;
          const { count, resolve } = nextAbsentCount(menuPresent, prev);
          expiredAbsentRef.current.set(sid, count);
          if (resolve) {
            expiredAbsentRef.current.delete(sid);
            for (const toolUseId of expired) {
              const action = { type: 'PERMISSION_CARD_RESOLVED' as const, sessionId: sid, toolUseId };
              dispatch(action);
              (window as any).claude?.remote?.broadcastAction?.(action);
            }
          }
        } else {
          // Nothing expired for this session — drop any stale counter so a
          // FUTURE expiry starts its own count from zero instead of leaking
          // state across unrelated permission asks.
          expiredAbsentRef.current.delete(sid);
        }
        for (const [, tool] of sessionState.toolCalls) {
          // Live asks silence the parser below — the hook-based ToolCard
          // owns that menu and a PromptCard must not double-render it.
          // EXPIRED asks must NOT silence it — their menu has no live socket
          // behind it, and the resolver above needs this function to keep
          // running every flush to ever see two consecutive absences.
          if (tool.status === 'awaiting-approval' && !tool.expired) return;
        }
      }

      // Skip prompt detection during post-permission cooldown — the Ink menu
      // may still be on screen while Claude processes the approval response.
      const lastCleared = lastPermissionClearedRef.current.get(sid);
      if (lastCleared && Date.now() - lastCleared < POST_PERMISSION_COOLDOWN_MS) {
        return;
      }

      // Visible screen only — Ink menus render at the bottom; serializing the
      // full scrollback here (per buffer flush, up to ~60/s while streaming)
      // was the top renderer CPU cost. See terminal-registry.getScreenText.
      const screen = getVisibleScreenText(sid);
      if (!screen) return;

      const menu = parseInkSelect(screen);
      const lastMenuId = lastMenuRef.current.get(sid) || null;

      if (menu) {
        // Cancel any pending dismiss — menu is (still) present
        const existingDismiss = dismissTimerRef.current.get(sid);
        if (existingDismiss) {
          clearTimeout(existingDismiss);
          dismissTimerRef.current.delete(sid);
        }

        if (menu.id !== lastMenuId) {
          // A DIFFERENT menu replaced the previous one. Retire the old prompt
          // BEFORE the recognized-title gate below can bail out: cancel its
          // pending show timer and dismiss any already-shown prompt. Without
          // this, a recognized prompt followed by an unrecognized menu
          // orphaned the old timeline entry at completed:false forever —
          // hasPendingInteraction() then blocked all chat sends with a stale
          // "answer the prompt first" toast (seen on crash-resumed sessions,
          // 2026-07-16). The dispatch is gated on shownPromptRef so id churn
          // from false-positive menus (streaming numbered lists) doesn't run
          // the reducer on every buffer flush.
          const existingTimer = pendingTimerRef.current.get(sid);
          if (existingTimer) {
            clearTimeout(existingTimer);
            pendingTimerRef.current.delete(sid);
          }
          if (lastMenuId && shownPromptRef.current.get(sid) === lastMenuId) {
            shownPromptRef.current.delete(sid);
            dispatch({ type: 'DISMISS_PROMPT', sessionId: sid, promptId: lastMenuId });
          }
          lastMenuRef.current.set(sid, menu.id);

          // Only show PromptCards for known setup prompts. Permission prompts
          // and false positives (numbered lists) are skipped — hooks handle
          // permissions, and numbered lists aren't real menus.
          if (!SETUP_PROMPT_TITLES.has(menu.title)) return;

          // Debounce: wait before showing, giving hook system time to arrive
          const timer = setTimeout(() => {
            pendingTimerRef.current.delete(sid);

            // Re-check: if a PermissionRequest arrived during the debounce,
            // a tool will be in awaiting-approval — don't show the prompt.
            // Same expired exemption as the top-of-flush bail above: an
            // expired card must not block this setup-prompt PromptCard from
            // showing (spec §2b).
            const currentSession = store.getState().get(sid);
            if (currentSession) {
              for (const [, tool] of currentSession.toolCalls) {
                if (tool.status === 'awaiting-approval' && !tool.expired) return;
              }
            }

            // Re-check cooldown (permission may have been responded during debounce)
            const cleared = lastPermissionClearedRef.current.get(sid);
            if (cleared && Date.now() - cleared < POST_PERMISSION_COOLDOWN_MS) {
              return;
            }

            // Re-check the menu is STILL on screen. `menu` was captured when the
            // timer was scheduled; the PTY may have advanced past it during the
            // debounce. Showing a card for a menu that's already gone strands a
            // completed:false prompt entry whose ONLY clearer is a LATER buffer
            // flush (the disappear branch below) — and an idle terminal produces
            // none, so hasPendingInteraction() would then block every send with
            // nothing live on screen. Re-parse now; bail if the menu left.
            // (fix 2026-07-17 — the "SHOW fired for a vanished menu" race.)
            const nowScreen = getVisibleScreenText(sid);
            const nowMenu = nowScreen ? parseInkSelect(nowScreen) : null;
            if (!nowMenu || nowMenu.id !== menu.id) return;

            const buttons = menuToButtons(menu);
            shownPromptRef.current.set(sid, menu.id);
            dispatch({
              type: 'SHOW_PROMPT',
              sessionId: sid,
              promptId: menu.id,
              title: menu.title,
              description: menu.description,
              buttons: buttons.map((b) => ({
                label: b.label,
                input: b.input,
                submitInput: b.submitInput,
              })),
            });
          }, PROMPT_DEBOUNCE_MS);

          pendingTimerRef.current.set(sid, timer);
        }
      } else if (lastMenuId) {
        // Menu disappeared — debounce the dismissal to avoid clearing
        // lastMenuRef during brief PTY screen redraws (clear → redraw).
        if (!dismissTimerRef.current.has(sid)) {
          // Cancel any pending show timer immediately
          const existingTimer = pendingTimerRef.current.get(sid);
          if (existingTimer) {
            clearTimeout(existingTimer);
            pendingTimerRef.current.delete(sid);
          }

          const timer = setTimeout(() => {
            dismissTimerRef.current.delete(sid);
            // Menu has been gone long enough — truly dismiss
            if (shownPromptRef.current.get(sid) === lastMenuId) {
              shownPromptRef.current.delete(sid);
            }
            dispatch({
              type: 'DISMISS_PROMPT',
              sessionId: sid,
              promptId: lastMenuId,
            });
            lastMenuRef.current.delete(sid);
          }, DISMISS_DEBOUNCE_MS);

          dismissTimerRef.current.set(sid, timer);
        }
      }
    });

    return () => {
      unsub();
      // Clean up any pending timers
      for (const timer of pendingTimerRef.current.values()) {
        clearTimeout(timer);
      }
      pendingTimerRef.current.clear();
      for (const timer of dismissTimerRef.current.values()) {
        clearTimeout(timer);
      }
      dismissTimerRef.current.clear();
    };
  }, [dispatch]);
}
