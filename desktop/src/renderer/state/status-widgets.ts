//
// The one place that answers "can this session show this widget at all?".
// Both the status bar and its Customize popup read it, so the bar can never
// hide a chip the menu still offers, or vice versa (spec §9).
//
// WHY a separate module rather than a helper inside StatusBar.tsx: the popup is
// rendered from StatusBar but the ANSWER is also needed by tests and, later, by
// the /usage card. A shared module keeps one definition; a local helper would
// have grown a second copy the first time something else needed it.

/** Every toggleable widget in WIDGET_CATEGORIES (StatusBar.tsx). Moved here so
 *  the relevance rules and the registry can reference one union. */
export type WidgetId =
  | 'usage-5h' | 'usage-7d' | 'context' | 'git-branch' | 'sync-warnings' | 'theme' | 'version'
  | 'session-cost' | 'tokens-in' | 'tokens-out' | 'cache-stats' | 'code-changes' | 'session-time'
  | 'cache-hit-rate' | 'active-ratio' | 'output-speed'
  | 'announcement'
  | 'open-tasks'
  | 'session-tags';

/** The session's runtime — NOT its provider type. Known the instant a session
 *  exists and never absent, which is why the gate below can never flicker. */
export type SessionRuntime = 'claude' | 'native';

export interface RelevanceContext {
  runtime: SessionRuntime;
  /** Has any counted work in this session had a published price? Drives the
   *  cost chip's reason line only. */
  hasPricedWork: boolean;
}

/** Widgets that describe the Claude SUBSCRIPTION — an account a native session
 *  neither spends nor is limited by. These are the only widgets gated on the
 *  runtime; everything else is gated on whether it has a value to show. */
const CLAUDE_ONLY: ReadonlySet<WidgetId> = new Set<WidgetId>(['usage-5h', 'usage-7d']);

/** Chips a native session has no measurement for. NOT a relevance judgment —
 *  the harness simply does not report turn wall-time yet (spec §15). */
const UNMEASURED_IN_NATIVE: ReadonlySet<WidgetId> = new Set<WidgetId>(['session-time', 'active-ratio']);

export function widgetApplies(id: WidgetId, runtime: SessionRuntime): boolean {
  return runtime === 'claude' || !CLAUDE_ONLY.has(id);
}

/** One line for the Customize menu explaining why a row can't be turned on
 *  here, or null when there is nothing to explain.
 *
 *  git-branch is deliberately absent: it is missing because nothing feeds it,
 *  not because it doesn't apply, and "Claude Code sessions only" would be a
 *  false sentence — the exact defect this work removes (spec §4). */
export function widgetUnavailableReason(id: WidgetId, ctx: RelevanceContext): string | null {
  if (ctx.runtime === 'claude') return null;
  if (CLAUDE_ONLY.has(id)) return 'Claude Code sessions only — see /usage';
  if (UNMEASURED_IN_NATIVE.has(id)) return 'Not measured in this kind of session yet';
  if (id === 'session-cost' && !ctx.hasPricedWork) return 'No published price for this model';
  return null;
}
