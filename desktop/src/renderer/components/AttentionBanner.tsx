import type { AttentionState } from '../state/chat-types';
import BrailleSpinner from './BrailleSpinner';
import { Button } from './ui';

// Banner shown in place of ThinkingIndicator when the classifier (or a
// process-exit event) concludes chat view is out of sync with what the user
// would see in Terminal view. Copy is keyed off AttentionState — keep it
// short and point the user at Terminal view when the state is ambiguous.

interface Props {
  state: Exclude<AttentionState, 'ok'>;
  /** Anthropic API request ID for the last assistant turn, if any.
   *  Rendered only when state is 'error' or 'session-died' for support correlation. */
  anthropicRequestId?: string | null;
  /** Provider error text (native runtime). When state==='error' this takes
   *  precedence over the generic COPY line. */
  errorMessage?: string | null;
  /** Retry affordance shown only when state==='error'. Wired to re-send the
   *  last user message via the native send path (Task 12). */
  onRetry?: () => void;
  /** Opens Settings → Model Providers. When the provider error is a
   *  configuration problem (missing/disabled key), the bubble shows an
   *  "Open Settings" button that calls this so the user can fix it in one hop. */
  onOpenProviderSettings?: () => void;
}

// Provider-CONFIGURATION errors (missing API key, disabled provider, no endpoint)
// all originate in main/providers/provider-registry.ts and deterministically end
// with "Settings → Providers." — the one place that phrase is emitted. We match
// that phrase rather than threading a structured `action` field through the event
// data → NATIVE_SESSION_ERROR → SessionChatState → serialization → here (~8 files),
// because the message has a single origin and is stable. Runtime/stream failures
// ("502…", "The model request failed.") don't contain it, so they won't match.
function isProviderConfigError(message: string | null | undefined): boolean {
  return !!message && /Settings → Providers/.test(message);
}

const COPY: Record<Props['state'], string> = {
  'stuck': 'Still waiting on Claude — check Terminal view if this persists.',
  'session-died': 'Session ended unexpectedly.',
  // 'error' is native-runtime only (dispatcher: NATIVE_SESSION_ERROR, added in
  // Phase 1 Plan A). The detailed provider message rides the 'session-error'
  // transcript event; this banner copy stays generic.
  'error': 'The model provider returned an error — this turn has ended.',
  // Deliberately non-committal: a hung upstream and a dead socket are
  // indistinguishable from inside the app and always will be, so the copy
  // states the observation and pairs it with actions rather than guessing a
  // cause (docs/error-message-standards.md). A later task appends the live
  // elapsed time and the Retry / Stop buttons; this line is the final wording.
  'stalled': 'Provider may have stalled',
};

// Destructive states pick up the L3 destructive ring tokens so they read as
// "something went wrong" rather than just a nudge. Other states reuse the
// neutral bubble styling to stay consistent with ThinkingIndicator.
const DESTRUCTIVE: Props['state'][] = ['session-died', 'error'];

export default function AttentionBanner({ state, anthropicRequestId, errorMessage, onRetry, onOpenProviderSettings }: Props) {
  const destructive = DESTRUCTIVE.includes(state);
  const bubbleBase = 'flex items-center gap-2 bg-inset rounded-2xl rounded-bl-sm px-4 py-2.5';
  const bubbleClasses = destructive
    ? `${bubbleBase} ring-1 ring-[var(--destructive)]`
    : bubbleBase;
  const textClasses = destructive
    ? 'text-sm text-fg-2'
    : 'text-sm text-fg-muted italic';
  // Show the spinner only while Claude might still be working ('stuck').
  // session-died and error both mean the turn is over — a spinning indicator
  // would be misleading.
  const showSpinner = state === 'stuck';
  // Surface the request ID on terminal failures only (session-died / error):
  // it's strictly a support-correlation aid, so we hide it during the benign
  // 'stuck' banner where Claude is likely still working. Matches the Props
  // doc comment above.
  const showRequestId = (state === 'session-died' || state === 'error') && !!anthropicRequestId;
  // Provider error text takes precedence over the generic 'error' COPY line.
  const line = state === 'error' && errorMessage ? errorMessage : COPY[state];
  const showRetry = state === 'error' && !!onRetry;
  // Provider-CONFIG errors get a direct "Open Settings" jump to Model Providers.
  const showOpenSettings =
    state === 'error' && !!onOpenProviderSettings && isProviderConfigError(errorMessage);

  return (
    // in-view: opts the bubble into wallpaper-driven bubble glassmorphism
    // (theme-engine targets `.in-view .bg-inset`), matching ThinkingIndicator.
    // Column layout lets the Request ID stack beneath the bubble while staying
    // inside the same banner container (consistent padding + glass treatment).
    <div className="flex flex-col items-start gap-1 px-4 py-1.5 in-view">
      <div className={bubbleClasses}>
        {showSpinner && <BrailleSpinner size="base" />}
        <span className={textClasses}>{line}</span>
        {showRetry && (
          <button
            type="button"
            onClick={onRetry}
            className="text-xs underline text-fg-dim hover:text-fg"
          >
            Try again
          </button>
        )}
        {showOpenSettings && (
          // ml-auto pushes the CTA to the right edge of the bubble, past the
          // message text. Plain-words label (no glyph) per standing preference.
          <Button
            size="sm"
            onClick={onOpenProviderSettings}
            className="ml-auto shrink-0"
          >
            Open Settings
          </Button>
        )}
      </div>
      {showRequestId && (
        <div className="text-[10.5px] text-fg-muted font-mono mt-1 select-text">
          Request ID: {anthropicRequestId}
        </div>
      )}
    </div>
  );
}
