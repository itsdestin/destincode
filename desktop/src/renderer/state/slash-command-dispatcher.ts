// Central router for slash commands typed into chat or selected from the
// command drawer. Both entry points (InputBar.sendMessage and the drawer's
// onSelect) route through here so command behavior stays consistent and
// we don't need to duplicate interception logic.
//
// Return shape:
//   { handled: false }                           — not a recognized slash command; caller sends to PTY as normal
//   { handled: true }                            — fully intercepted; caller does nothing further
//   { handled: true, alsoSendToPty: string }     — intercepted, but caller should still forward the given text to PTY
//                                                  (used by /clear and /compact where Claude Code's own state must also change)
//
// Escape hatch: leading backslash (e.g. "\/clear") strips the backslash and
// returns { handled: false } so power users can bypass native handling.

// WHY: `CopyPickerOption` dropped from this import — the dispatcher routes
// commands but never inspects picker options (CopyPicker.tsx and
// extract-copy-blocks.ts still use the type). Found in the 2026-08-06 sweep.
import type { ChatAction, TimelineEntry, UsageSnapshot, SessionChatState } from './chat-types';
import { buildCopyPayload } from '../utils/extract-copy-blocks';

export type ViewMode = 'chat' | 'terminal';

export interface DispatcherCallbacks {
  /** Open the ResumeBrowser modal (handles /resume). */
  onResumeCommand?: () => void;
  /**
   * Snapshot current session stats for /cost and /usage. App.tsx wires this
   * from statusData (sessionStatsMap + usage + contextMap) since the dispatcher
   * is called from InputBar and doesn't own that state.
   * Returns null if no data yet (e.g., status line hook hasn't fired).
   */
  getUsageSnapshot?: (sessionId: string) => UsageSnapshot | null;
  /** Open Preferences popup (/config in chat view). */
  onOpenPreferences?: () => void;
  /** Show a transient toast (e.g. "Attachments ignored with /clear"). */
  onToast?: (message: string) => void;
  /** Read-access to a session's full chat state — used by /copy to walk assistant turns. */
  getSessionState?: (sessionId: string) => SessionChatState | undefined;
  /** Open the ModelPickerPopup — used by bare /model, /fast, /effort. */
  onOpenModelPicker?: () => void;
}

export interface DispatcherInput {
  raw: string;                       // The pristine message text (pre-attachment merge)
  sessionId: string | null;
  view: ViewMode;
  files: { path: string; name: string; isImage: boolean }[];
  dispatch: React.Dispatch<ChatAction>;
  timeline: TimelineEntry[];         // Current session timeline, for commands that need history
  callbacks: DispatcherCallbacks;
  /** Caller-supplied: this session's UI effects are driven by the RUNTIME, not
   *  optimistically here. Set for native sessions, whose /clear is a durable
   *  context barrier — the harness echoes a `context-clear` event that clears the
   *  timeline once the barrier actually lands.
   *
   *  WHY it matters: CLEAR_TIMELINE is irreversible in practice. `seenUuids`
   *  survives it, so a transcript replay after a clear is deduped away to
   *  nothing — there is no restoring a timeline cleared in error. Clearing
   *  optimistically and then having the runtime REFUSE (a turn is in flight)
   *  would leave an empty-looking conversation the model still fully remembers.
   *  This is data the caller knows, not a provider branch inside the dispatcher. */
  deferUiEffectsToRuntime?: boolean;
}

/** A command that has a REAL native-runtime implementation, named so callers can
 *  route it to the harness instead of a PTY that doesn't exist. The dispatcher
 *  stays provider-agnostic on purpose — it names the intent, and the caller (who
 *  is the one that knows the session's provider) picks the transport. */
export type NativeSlashAction =
  | { kind: 'compact' }
  | { kind: 'clear' }
  /** M3 item 1. `skill` is the command word; `args` is whatever followed it, so a
   *  skill can act on what the user typed rather than only on its own body. */
  | { kind: 'invoke-skill'; skill: string; args?: string };

/** `nativeAction` rides BOTH branches on purpose.
 *
 *  A recognized command (/compact, /clear) is handled:true and names its action.
 *  An UNRECOGNIZED slash command is handled:false — so a Claude Code session
 *  forwards it to the PTY exactly as before — while still naming an invoke-skill
 *  intent for a native session, whose harness owns the skill catalog and can
 *  resolve it. That keeps the dispatcher provider-agnostic (it names intent; the
 *  caller, who knows the provider, picks the transport) and avoids plumbing the
 *  installed-skill list into two renderer components that have no other use for it. */
export type DispatcherResult =
  | { handled: false; rewritten?: string; nativeAction?: NativeSlashAction }
  | { handled: true; alsoSendToPty?: string; nativeAction?: NativeSlashAction };

/**
 * Route a slash command through the central dispatcher.
 *
 * Commands implemented in Day 1: /resume (migrated from InputBar's inline check).
 * Additional commands (/clear, /compact, /config, /copy, /cost, /fast, /effort)
 * land in subsequent days.
 */
export function dispatchSlashCommand(input: DispatcherInput): DispatcherResult {
  const trimmed = input.raw.trim();

  // Escape hatch: leading backslash on a slash command strips the backslash
  // and passes through untouched. e.g. "\/clear" becomes "/clear" sent raw to PTY.
  if (trimmed.startsWith('\\/')) {
    return { handled: false, rewritten: trimmed.slice(1) };
  }

  // Not a slash command — fast path.
  if (!trimmed.startsWith('/')) {
    return { handled: false };
  }

  // Split into command + args. Normalize command to lowercase; args preserve casing.
  const spaceIdx = trimmed.indexOf(' ');
  const cmd = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1);

  switch (cmd) {
    case '/compact': {
      // Claude Code handles the actual API-powered summarization. Our job is
      // to make it visible: show a spinner card the moment the user types it,
      // and a "Compacted · freed X tokens" marker when done. Completion is
      // detected via transcript-shrink watcher in App.tsx.
      if (!input.sessionId) return { handled: false };
      if (input.files.length > 0 && input.callbacks.onToast) {
        input.callbacks.onToast('Attachments ignored with /compact');
      }
      // Snapshot current context tokens so COMPACTION_COMPLETE can show a diff.
      // null is fine — marker falls back to "Conversation compacted" with no number.
      const snapshot = input.callbacks.getUsageSnapshot?.(input.sessionId) ?? null;
      input.dispatch({
        type: 'COMPACTION_PENDING',
        sessionId: input.sessionId,
        cardId: `compact-${Date.now()}`,
        beforeContextTokens: snapshot?.contextTokens ?? null,
      });
      // Forward original command (with any optional focus args) to PTY.
      // Claude Code parses /compact [instructions] itself. A native session has
      // no PTY — `nativeAction` tells the caller to drive the harness's own
      // two-stage compaction instead. Both are returned; the caller picks by
      // provider, so this stays a pure function of the input text.
      return { handled: true, alsoSendToPty: `/compact${args ? ' ' + args : ''}\r`, nativeAction: { kind: 'compact' } };
    }

    case '/clear':
    case '/reset':
    case '/new': {
      // Clears visible timeline immediately AND forwards /clear to PTY so Claude
      // Code's own context resets. The two paths are independent — if the PTY
      // write fails, the UI is still cleared (matches user intent).
      //
      // Attachments are incompatible with /clear (contradictory intent) — we
      // warn the user but proceed with the clear since that's the dominant intent.
      if (!input.sessionId) return { handled: false };
      if (input.files.length > 0 && input.callbacks.onToast) {
        input.callbacks.onToast('Attachments ignored with /clear');
      }
      // See deferUiEffectsToRuntime: for a runtime-driven session the clear is
      // applied when the durable barrier echoes back, not before.
      if (!input.deferUiEffectsToRuntime) {
        input.dispatch({
          type: 'CLEAR_TIMELINE',
          sessionId: input.sessionId,
          markerId: `clear-${Date.now()}`,
          timestamp: Date.now(),
        });
      }
      // Native sessions have no PTY. `clear` drives the harness's context
      // BARRIER instead: the append-only log keeps every line, but the model
      // stops seeing anything before the marker.
      return { handled: true, alsoSendToPty: '/clear\r', nativeAction: { kind: 'clear' } };
    }

    case '/model':
    case '/fast':
    case '/effort': {
      // Bare commands (no args) open the unified ModelPickerPopup. With args,
      // pass through to Claude Code's own handler — e.g. `/model sonnet`,
      // `/fast on`, `/effort high` all still work because Claude Code parses them.
      // We also opportunistically persist known args for /fast and /effort so
      // the status bar chips stay in sync.
      if (!args) {
        if (input.callbacks.onOpenModelPicker) {
          input.callbacks.onOpenModelPicker();
          return { handled: true };
        }
        return { handled: false };
      }
      // Persist fast/effort local state (fire-and-forget) so chips update.
      const modesApi = (window as any).claude?.modes;
      if (cmd === '/fast' && modesApi) {
        const on = /^on|true|1$/i.test(args.trim());
        modesApi.set({ fast: on }).catch(() => {});
      } else if (cmd === '/effort' && modesApi) {
        const lvl = args.trim().toLowerCase();
        if (['low', 'medium', 'high', 'max', 'auto'].includes(lvl)) {
          modesApi.set({ effort: lvl }).catch(() => {});
        }
      }
      // Let the command pass through to PTY — Claude Code applies it.
      return { handled: false };
    }

    case '/copy': {
      // Claude Code's own /copy goes through shell clipboard commands which
      // are unreliable (especially Android). We do it ourselves via
      // navigator.clipboard for cross-platform consistency.
      if (!input.sessionId || !input.callbacks.getSessionState) return { handled: false };
      if (input.files.length > 0 && input.callbacks.onToast) {
        input.callbacks.onToast('Attachments ignored with /copy');
      }
      // Parse optional N (default 1 = most recent)
      const n = args ? Math.max(1, parseInt(args.trim(), 10) || 1) : 1;
      const session = input.callbacks.getSessionState(input.sessionId);
      const payload = buildCopyPayload(session, n);

      if (payload.mode === 'empty') {
        input.callbacks.onToast?.('No response to copy');
        return { handled: true };
      }
      if (payload.mode === 'single') {
        // Single block — direct copy, no picker. Browser clipboard API works
        // even when focus is on a textarea, unlike execCommand.
        void navigator.clipboard.writeText(payload.content).catch(() => {});
        input.callbacks.onToast?.('Copied to clipboard');
        return { handled: true };
      }
      // Multi-block — show picker inline
      input.dispatch({
        type: 'SHOW_COPY_PICKER',
        sessionId: input.sessionId,
        id: `copy-${Date.now()}`,
        options: payload.options,
      });
      return { handled: true };
    }

    case '/resume':
      // Opens ResumeBrowser modal. Does NOT forward to PTY — Claude Code's own
      // /resume is interactive and we replace it with our native browser.
      if (input.callbacks.onResumeCommand) {
        input.callbacks.onResumeCommand();
        return { handled: true };
      }
      return { handled: false };

    case '/config':
    case '/settings': {
      // View-aware: in chat view, open the native Preferences popup. In
      // terminal view, pass through so Claude Code's own /config TUI renders
      // in the terminal (power-user escape hatch).
      if (input.view === 'terminal') return { handled: false };
      if (input.callbacks.onOpenPreferences) {
        input.callbacks.onOpenPreferences();
        return { handled: true };
      }
      return { handled: false };
    }

    case '/cost':
    case '/usage': {
      // Render a snapshot UsageCard inline in chat. Does NOT forward to PTY —
      // we have richer data (rate limits, cache hit rate) than Claude Code's
      // own /cost prints, and we avoid the raw-text PTY output cluttering the
      // terminal view.
      if (!input.sessionId || !input.callbacks.getUsageSnapshot) return { handled: false };
      const snapshot = input.callbacks.getUsageSnapshot(input.sessionId);
      if (!snapshot) {
        // No stats yet — status line hook hasn't fired. Fall through so the
        // user sees Claude Code's native output instead of nothing happening.
        return { handled: false };
      }
      input.dispatch({ type: 'SHOW_USAGE_CARD', sessionId: input.sessionId, snapshot });
      return { handled: true };
    }

    default: {
      // Unrecognized slash command. For Claude Code this is unchanged — handled:
      // false, forwarded to the PTY. For a native session it is the /skill-name
      // path (M3 item 1): the harness owns the catalog, so it decides whether
      // `cmd` names an installed skill, and reports honestly when it does not.
      //
      // Resolving LAST means an installed skill can never shadow a built-in — a
      // marketplace skill called `clear` cannot take over the /clear barrier,
      // because that case returned several branches above.
      //
      // `/` alone carries no command word and is left alone.
      const skill = cmd.slice(1);
      if (!skill) return { handled: false };
      return { handled: false, nativeAction: { kind: 'invoke-skill', skill, ...(args ? { args } : {}) } };
    }
  }
}
