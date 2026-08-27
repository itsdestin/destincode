import { useState, useCallback } from 'react';
import { useEscClose } from '../hooks/use-esc-close';
import { createPortal } from 'react-dom';
import { useTheme, type ContextDisplay } from '../state/theme-context';
import type { PermissionMode } from '../../shared/types';
import type { NativePermissionMode } from '../../shared/permission-types';
import { isExpired } from '../../shared/announcement';
import type { SyncWarning } from '../../main/sync-state';
import { deriveWarningSeverity } from '../state/sync-display-state';
import { type WidgetId, type SessionRuntime, type RelevanceContext, widgetApplies, widgetUnavailableReason } from '../state/status-widgets';
import { FastIcon } from './Icons';
import UpdatePanel from './UpdatePanel';
import ContextPopup from './ContextPopup';
import OpenTasksChip from './OpenTasksChip';
import { isAndroid } from '../platform';
import { SessionTagsChip } from './tags/SessionTagsChip';
import SpecialistsChip from './SpecialistsChip';
import { Dialog } from './ui';
import { resolveModelBrand, type ProviderIconKey } from './provider-brand';
import type { SessionTotals } from '../state/session-totals';
import { CLAUDE_ALIASES, type ClaudeAlias } from '../../shared/model-ids';

// --- Session stats shape (written by statusline.sh to .session-stats-{id}.json) ---

interface SessionStats {
  costUsd: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  contextTokens: number | null;
  duration: number | null;       // seconds (converted from ms in statusline.sh)
  apiDuration: number | null;    // seconds (converted from ms in statusline.sh)
  linesAdded: number | null;
  linesRemoved: number | null;
}

interface StatusData {
  usage: {
    five_hour?: { utilization: number; resets_at: string };
    seven_day?: { utilization: number; resets_at: string };
  } | null;
  updateStatus: {
    current: string;
    latest: string;
    update_available: boolean;
    download_url: string | null;
  } | null;
  announcement: { message: string; expires?: string | null } | null;
  contextPercent: number | null;
  gitBranch: string | null;
  sessionStats: SessionStats | null;
  syncWarnings: SyncWarning[] | null;
}

// Model aliases sent to the CC CLI via `/model <alias>`. Canonical list lives
// in shared/model-ids.ts alongside claudeAliasForModelId, the alias→transcript
// matcher every surface now shares; re-exported here because this module has
// been the import site for both since before the shared module existed.
// Labels are model-class only (no version numbers) by design.
const MODELS = CLAUDE_ALIASES;
type ModelAlias = ClaudeAlias;

const MODEL_DISPLAY: Record<ModelAlias | 'unknown', { label: string; color: string; border: string; icon?: ProviderIconKey }> = {
  // Restyle: chips now use the standard `bg-panel` surface (set via className
  // in the JSX, not here) like every other status-bar chip, with brand-colored
  // TEXT + a matching tinted BORDER.
  // CC sessions use the official Claude Code CLI mascot and adaptive brand token.
  sonnet:      { label: 'Sonnet', color: 'var(--brand-claude)', border: 'color-mix(in srgb, var(--brand-claude) 35%, transparent)',  icon: 'claudecode' },
  'opus[1m]':  { label: 'Opus',   color: 'var(--brand-claude)', border: 'color-mix(in srgb, var(--brand-claude) 35%, transparent)',  icon: 'claudecode' },
  haiku:       { label: 'Haiku',  color: 'var(--brand-claude)', border: 'color-mix(in srgb, var(--brand-claude) 35%, transparent)',  icon: 'claudecode' },
  // Fable 5 — most capable. Fuchsia text keeps it as the top/premium tier,
  // distinct from the Anthropic-orange aliases and the amber reserved for AUTO.
  fable:       { label: 'Fable',  color: '#E879F9', border: 'rgba(232,121,249,0.35)',  icon: 'claudecode' },
  // Error state, not a real model — red like the high-danger usage threshold
  // (utilizationColor/contextColor) so it reads as "wrong", never as a normal pill.
  unknown:     { label: 'Model Unknown', color: '#DD4444', border: 'rgba(221,68,68,0.3)' },
};

/**
 * What the model chip should render. A display-only union — see the `model`
 * prop comment for why native models are NOT folded into ModelAlias.
 *  - 'alias'   Claude Code session on a recognized model
 *  - 'native'  native-runtime session; label is a prettified SessionInfo.model
 *  - 'unknown' Claude Code session whose model couldn't be confirmed (error)
 */
export type ModelChip =
  | { kind: 'alias'; alias: ModelAlias }
  | { kind: 'native'; label: string; modelId: string }
  | { kind: 'unknown' };

/** MODEL_DISPLAY row for the two Claude Code chip states. */
function ccChipDisplay(model: Exclude<ModelChip, { kind: 'native' }>) {
  return MODEL_DISPLAY[model.kind === 'unknown' ? 'unknown' : model.alias];
}

/**
 * Native chip style. Resolves a brand color from the model id (and the
 * provider type as a fallback) so OpenAI models get OpenAI green, Claude
 * models get Anthropic orange, Qwen gets its purple, Google gets its blue,
 * and anything unrecognized falls back to --tag-blue (the old default).
 *
 * The style now uses `bg-panel` (set via className in the JSX, same as the
 * CC alias chips and every other status-bar chip) with brand-colored text +
 * a matching tinted border. The old transparent-tint background is gone.
 */
function nativeChipStyle(modelId: string, providerType?: string | null): {
  color: string;
  borderColor: string;
  icon?: ProviderIconKey;
} {
  const brand = resolveModelBrand(modelId, providerType);
  if (brand) {
    return {
      color: brand.color,
      borderColor: `color-mix(in srgb, ${brand.color} 35%, transparent)`,
      icon: brand.icon,
    };
  }
  // Fallback: the old --tag-blue default for unrecognized models.
  const fallback = 'var(--tag-blue)';
  return {
    color: fallback,
    borderColor: `color-mix(in srgb, ${fallback} 35%, transparent)`,
  };
}

// Amber (#F2B33D) for AUTO matches CC's own banner color and visually sits
// between 'auto-accept' (theme accent, mostly safe) and 'bypass' (salmon, no
// safety checks) — increasing autonomy = warmer color.
// Keyed by both CC's PermissionMode and the native runtime's NativePermissionMode.
// The two unions share no string values, so one map serves both; App decides
// which value (and which cycle handler) to pass based on the session's provider.
// Native labels are plain words (no glyphs — standing user preference) and reuse
// the same "increasing autonomy = warmer color" convention: ask ≈ normal (muted),
// auto-edit ≈ auto-accept (accent, mostly safe), full-auto = amber (autonomous,
// but still deny-list-guarded so not the salmon reserved for CC's bypass).
// Exported: ToolCard's full-auto safety-stop footer paints with the SAME chip
// colors, so the band and the status-bar chip can never drift apart.
export const PERMISSION_DISPLAY: Record<PermissionMode | NativePermissionMode | 'unknown', { label: string; shortLabel: string; color: string; bg: string; border: string }> = {
  normal:        { label: 'NORMAL',             shortLabel: 'NORMAL',  color: 'var(--fg-muted)', bg: 'var(--panel)', border: 'var(--edge-dim)' },
  'auto-accept': { label: 'ACCEPT CHANGES',     shortLabel: 'ACCEPT',  color: 'var(--accent)',   bg: 'var(--panel)', border: 'var(--edge)' },
  plan:          { label: 'PLAN MODE',           shortLabel: 'PLAN',    color: 'var(--fg-2)',     bg: 'var(--panel)', border: 'var(--edge)' },
  auto:          { label: 'AUTO MODE',           shortLabel: 'AUTO',    color: 'var(--status-auto)', bg: 'var(--panel)', border: 'color-mix(in srgb, var(--status-auto) 35%, transparent)' },
  bypass:        { label: 'BYPASS PERMISSIONS',  shortLabel: 'BYPASS',  color: 'var(--status-bypass)', bg: 'var(--panel)', border: 'color-mix(in srgb, var(--status-bypass) 35%, transparent)' },
  // Native runtime modes (Task 13).
  ask:           { label: 'ASK FIRST',          shortLabel: 'ASK',     color: 'var(--fg-muted)', bg: 'var(--panel)', border: 'var(--edge-dim)' },
  'auto-edit':   { label: 'AUTO EDIT',          shortLabel: 'EDIT',    color: 'var(--accent)',   bg: 'var(--panel)', border: 'var(--edge)' },
  'full-auto':   { label: 'FULL AUTO',          shortLabel: 'FULL',    color: 'var(--status-auto)', bg: 'var(--panel)', border: 'color-mix(in srgb, var(--status-auto) 35%, transparent)' },
  // Error state — App.tsx passes this when the real mode can't be confirmed
  // (unrecognized value, missing data on resume/reconnect) rather than guessing
  // 'normal'/'ask', which would misrepresent what's actually enforced.
  unknown:       { label: 'PERMISSION UNKNOWN',  shortLabel: 'UNKNOWN', color: '#DD4444', bg: 'var(--panel)', border: 'rgba(221,68,68,0.3)' },
};

// --- Native (local-model) StatusBar chips (Task 12) ---
// Native-runtime sessions have no CC statusline writing .usage-cache.json, so
// their context/tokens/speed chips are derived directly from the per-turn usage
// stamped on turn-complete (see chat-reducer TRANSCRIPT_TURN_COMPLETE). This is
// a small PURE function so the derivation is unit-tested in isolation.
//
// v1 limitation (spec decision 7): chips reflect the LAST COMPLETED turn, not
// mid-turn progress — during a long agentic turn the context chip lags until the
// turn completes. Mid-turn liveness is a deliberate follow-up, not this task.

/** Usage payload shape the selector accepts. Superset-tolerant: only in/out
 *  tokens are required; tokensPerSecond + cache fields are optional so both the
 *  full turn-complete payload and a trimmed test fixture satisfy it. */
export interface NativeUsageInput {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  tokensPerSecond?: number;
  /** How full the window is: the LAST step's prompt + its output. Distinct from
   *  inputTokens, which sums every step and so re-counts history once per step.
   *  Absent on records written before 2026-07-28. */
  contextUsedTokens?: number;
}

export interface NativeStatusChips {
  /** Percent of the model's context window REMAINING (100 = empty, 0 = full).
   *  null when the real context window is unknown — the other chips still show. */
  contextPct: number | null;
  /** Tokens OCCUPYING the window (what the pill shows in "tokens" mode). */
  contextUsedTokens: number;
  inputTokens: number;
  outputTokens: number;
  tokensPerSecond: number;
  /** Cache tokens for the Cached/Hit chips. null (NOT 0) when the provider sent
   *  none — 0 reads is a real 0% hit rate and must render as such, while absent
   *  must stay '--'. Collapsing the two would invent a statistic. */
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
}

/** Derive the native context/in/out/speed chips from a turn's usage + the
 *  session's REAL context window (resolved in main, Task 4/5). Returns null when
 *  there's no usage yet so CC / idle sessions render nothing extra. */
export function selectNativeStatusChips(
  usage: NativeUsageInput | undefined | null,
  contextLength: number | undefined | null,
): NativeStatusChips | null {
  if (!usage) return null;
  const tokensPerSecond = usage.tokensPerSecond ?? 0;
  // Fix: the gauge asks "how close is the user to filling the window?", which is
  // OCCUPANCY — the last prompt plus its reply. It used to sum in+out across
  // every step of the turn, which both re-counted history per step AND reset to
  // near-zero each turn (Destin, 2026-07-28). Older records carry no
  // contextUsedTokens; the in+out sum is the closest thing they have.
  const contextUsedTokens = usage.contextUsedTokens ?? (usage.inputTokens + usage.outputTokens);
  // contextPct is REMAINING context. Falsy contextLength (unknown window) → null
  // so we never fabricate a percentage; the token + speed chips remain valid.
  let contextPct: number | null = null;
  if (contextLength) {
    const remaining = Math.round(((contextLength - contextUsedTokens) / contextLength) * 100);
    contextPct = Math.max(0, Math.min(100, remaining)); // clamp to [0,100]
  }
  return {
    contextPct,
    contextUsedTokens,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    tokensPerSecond,
    // ?? null, not ?? 0 — see the field docs. The harness ships these on every
    // turn-complete; they were simply never read on the way to the chips.
    cacheReadTokens: usage.cacheReadTokens ?? null,
    cacheCreationTokens: usage.cacheCreationTokens ?? null,
  };
}

/** What the cache-reuse chip renders, all resolved from ONE source. */
export interface CacheReuse {
  /** Prompt tokens served from cache instead of re-read. null = none reported. */
  readTokens: number | null;
  /** The WHOLE prompt the model read, cached portion included. */
  promptTokens: number | null;
  /** readTokens / promptTokens, clamped to 0..1. null when incomputable. */
  ratio: number | null;
}

/** How much of the prompt was served from cache rather than re-read.
 *
 *  Fix: this replaced a "hit rate" of reads/(reads+writes), which was pinned at
 *  100% forever. That formula only means anything on providers that BILL for
 *  cache writes (Anthropic-style explicit caching). Every native provider here —
 *  OpenRouter's models and local llama.cpp — caches automatically and reports no
 *  write count at all, so the denominator collapsed to reads/reads. Verified
 *  against 507 recorded turns: cacheCreationTokens was 0 on every single one
 *  (Destin, 2026-08-16).
 *
 *  WHY the two branches — the sources disagree about what inputTokens MEANS, and
 *  mixing them is exactly how the old per-turn figure ended up halved:
 *    - Claude Code's statusline uses Anthropic's convention, where inputTokens is
 *      the UNCACHED REMAINDER. The prompt total is input + read + create.
 *    - The native harness goes through an OpenAI-compatible provider, where
 *      prompt_tokens is the WHOLE prompt with cached tokens already counted in.
 *      Adding reads there double-counts them and halves the answer.
 *  So the numerator and denominator must always come from the same source. */
export function selectCacheReuse(
  ss: Pick<SessionStats, 'inputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'> | null | undefined,
  nativeChips: Pick<NativeStatusChips, 'inputTokens' | 'cacheReadTokens' | 'cacheCreationTokens'> | null | undefined,
): CacheReuse {
  // Precedence matches the Cached: chip beside it — CC's statusline wins when it
  // has written cache numbers, native fills in otherwise. Picked as a UNIT so the
  // denominator can never be resolved from a different source than the numerator.
  const useCC = ss?.cacheReadTokens != null;
  const readTokens = useCC ? ss!.cacheReadTokens : nativeChips?.cacheReadTokens ?? null;
  const createTokens = useCC ? ss!.cacheCreationTokens : nativeChips?.cacheCreationTokens ?? null;
  const inputTokens = useCC ? ss!.inputTokens : nativeChips?.inputTokens ?? null;

  if (readTokens == null || inputTokens == null) return { readTokens, promptTokens: null, ratio: null };

  const promptTokens = useCC ? inputTokens + readTokens + (createTokens ?? 0) : inputTokens;
  // Clamped: a provider that reports inconsistent counts should show a bounded
  // percentage, not 340%. The tooltip still prints the raw numbers, so genuinely
  // bad data stays visible instead of being silently smoothed away.
  const ratio = promptTokens > 0 ? Math.min(1, readTokens / promptTokens) : null;
  return { readTokens, promptTokens, ratio };
}

/** What the reuse chip should actually show. Kept separate from the JSX so the
 *  "don't alarm anyone on turn 1" rule is unit-testable rather than buried in a
 *  render branch. */
export type ReuseDisplay =
  | { kind: 'unknown' }                  // '--' — nothing reported cache data
  | { kind: 'first-turn' }               // 'New' — no earlier prompt to reuse yet
  | { kind: 'percent'; pct: number };

export function selectReuseDisplay(reuse: CacheReuse, turnsWithUsage: 0 | 1 | 2 | undefined): ReuseDisplay {
  if (reuse.ratio == null) return { kind: 'unknown' };
  // ?? 1, not ?? 2: an unwired caller errs toward the calm reading rather than
  // raising a red alarm it has no evidence for.
  const firstTurn = (turnsWithUsage ?? 1) <= 1;
  // Zero reuse means two very different things depending on WHEN it happens. On
  // a session's first turn there is simply no earlier prompt to reuse, which is
  // expected and should read as neutral. The same zero on turn 30 means the
  // cache stopped being hit — worth flagging, so it falls through to a red 0%.
  if (reuse.ratio === 0 && firstTurn) return { kind: 'first-turn' };
  return { kind: 'percent', pct: Math.round(reuse.ratio * 100) };
}

function utilizationColor(pct: number): string {
  if (pct >= 80) return 'text-[#DD4444]';
  if (pct >= 50) return 'text-[#FF9800]';
  return 'text-[#4CAF50]';
}

function contextColor(pct: number): string {
  if (pct < 20) return 'text-[#DD4444]';
  if (pct < 50) return 'text-[#FF9800]';
  return 'text-[#4CAF50]';
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function formatTime12(d: Date): string {
  let h = d.getHours();
  const m = d.getMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  h = h % 12 || 12;
  return `${h}:${m.toString().padStart(2, '0')}${ampm}`;
}

function format5hReset(iso: string): string {
  try {
    const d = new Date(iso);
    return `Resets @ ${formatTime12(d)}`;
  } catch {
    return '';
  }
}

function format7dReset(iso: string): string {
  try {
    const d = new Date(iso);
    return `Resets ${DAYS[d.getDay()]} @ ${formatTime12(d)}`;
  } catch {
    return '';
  }
}

/** Format token count as human-readable (e.g. 1234 -> "1.2k", 1234567 -> "1.2M") */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${n}`;
}

/** What the context pill renders, for a given display mode. `value` is the part
 *  that carries the color band; `suffix` is the trailing word (empty in tokens
 *  mode, where "35.2k / 64k" already reads as a quantity).
 *
 *  WHY this is pure + exported: the two callers below (the Claude Code chip and
 *  the native chip) must render IDENTICALLY for the same inputs — they are the
 *  same conceptual pill fed from different sources. Keeping the decision here
 *  instead of inline in both branches is what stops them drifting apart, and
 *  lets the formatting be tested without mounting a StatusBar.
 *
 *  The color is ALWAYS derived from `pct` by the caller, in both modes, so
 *  switching display never changes what green/amber/red mean.
 *
 *  Falls back to percent whenever the token figures aren't both known — a pill
 *  reading "null / null" (or a blank) would be worse than the percentage the
 *  user already trusts. */
export function formatContextPill(
  pct: number,
  usedTokens: number | null | undefined,
  windowTokens: number | null | undefined,
  mode: ContextDisplay,
): { value: string; suffix: string } {
  if (mode === 'tokens' && usedTokens != null && windowTokens != null && windowTokens > 0) {
    return { value: `${formatTokens(usedTokens)} / ${formatTokens(windowTokens)}`, suffix: '' };
  }
  return { value: `${pct}%`, suffix: 'Remaining' };
}

/** Tokens CONSUMED, derived from a percent-remaining reading and the window size.
 *  Used by the Claude Code chip, which is told the window and the percentage but
 *  never the raw used count (statusline.sh exposes `context_window_size` +
 *  `contextPercent`, not consumption). The native chip does NOT use this — it has
 *  a real measured used-token count and passes that straight through.
 *
 *  Necessarily APPROXIMATE: `pct` arrives already rounded to a whole number, so
 *  the result carries up to half a percent of the window as error. Fine for a
 *  glanceable pill; do not reuse it anywhere a token count must be exact. */
export function derivedUsedTokens(pct: number, windowTokens: number | null | undefined): number | null {
  if (windowTokens == null || windowTokens <= 0) return null;
  const clamped = Math.max(0, Math.min(100, pct));
  return Math.round(windowTokens * (1 - clamped / 100));
}

/** Format seconds as human-readable duration (e.g. 125 -> "2m 5s", 3700 -> "1h 1m") */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  if (m < 60) return s > 0 ? `${m}m ${s}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const rm = m % 60;
  return rm > 0 ? `${h}h ${rm}m` : `${h}h`;
}

interface Props {
  statusData: StatusData;
  onRunSync?: () => void;
  onOpenSync?: () => void;
  // Display-only view of the session's model. 'unknown' renders a distinct
  // error-styled chip — App.tsx passes it whenever it can't confidently
  // determine a CLAUDE CODE session's real model (unrecognized model id,
  // missing/invalid data on resume or reconnect) instead of silently guessing a
  // default, which would misrepresent what's actually running.
  //
  // Native-runtime sessions never reach 'unknown': their bound model id is
  // authoritative on SessionInfo.model, so App passes {kind:'native'} with a
  // label. Keeping this a display-only union (rather than widening ModelAlias)
  // is deliberate — ModelAlias also drives cycleModel, the `auto` permission
  // gate, and the persisted model preference, none of which a third-party
  // model id may leak into.
  model?: ModelChip;
  /** Native sessions only: the provider type from ProviderType (e.g. 'openai',
   *  'anthropic', 'openrouter', 'local-engine'). Used by the model chip to
   *  auto-detect the brand color when the model id alone is ambiguous. Unused
   *  for CC sessions (they use MODEL_DISPLAY keyed on the alias). */
  modelProviderType?: string | null;
  /** The session's runtime. Gates the two Claude-subscription chips and the
   *  Fast toggle — see status-widgets.ts. Absent → treated as 'claude', so a
   *  caller that hasn't been wired yet hides nothing (spec §11). */
  provider?: SessionRuntime;
  // No onCycleModel: the model chip opens the picker (onOpenModelPicker) and
  // click-to-cycle now lives on Shift+Space in App.tsx. The prop was still declared
  // and passed but never called, so it read as a working affordance that did nothing.
  // CC sessions pass a PermissionMode; native sessions pass a NativePermissionMode.
  // The chip renders identically for both — only the value + cycle handler differ.
  permissionMode?: PermissionMode | NativePermissionMode | 'unknown';
  onCyclePermission?: () => void;
  // Fast + effort state and opener. When non-default, chips render next to the model
  // chip. Clicking either (or the model chip directly) opens the ModelPickerPopup.
  fast?: boolean;
  effort?: string;
  onOpenModelPicker?: () => void;
  // Context popup: session and a dispatcher wrapper threaded from App.tsx.
  sessionId?: string | null;
  onDispatch?: (input: string) => void;
  /** Open-tasks counts for the chip — derived at App root from a single
   *  useSessionTasks instance so the chip and popup share inactiveMap state. */
  openTasksCounts?: { running: number; pending: number };
  /** Fired when the user clicks the Open Tasks chip. */
  onOpenOpenTasks?: () => void;
  /** Native-runtime sessions only (Task 12): the active session's most-recent
   *  turn-complete usage. null/absent for CC + idle sessions (chips stay hidden). */
  nativeUsage?: NativeUsageInput | null;
  /** Native-runtime sessions only: the session's REAL context window (resolved in
   *  main, Task 4/5) carried on the same usage payload. null when unknown → the
   *  context % chip is omitted but tokens + speed still render. */
  nativeContextLength?: number | null;
  /** Completed turns carrying usage, saturating at 2 (any provider). Lets the
   *  reuse chip say "New" on a session's first turn instead of a red 0%, which
   *  is the same number meaning two very different things. Absent → treated as
   *  a first turn, so an unwired caller errs toward the calm reading. */
  turnsWithUsage?: 0 | 1 | 2;
  /** Native sessions only: session-so-far totals (spec §2) — tokens, cost and
   *  edited lines, specialists included. Absent for CC sessions, which take the
   *  same numbers from the statusline instead. */
  nativeTotals?: SessionTotals | null;
}


const warnStyles = {
  danger: 'bg-[#DD4444]/15 text-[#DD4444] border-[#DD4444]/25',
  warn: 'bg-[#FF9800]/15 text-[#FF9800] border-[#FF9800]/25',
};

// --- Widget visibility system ---

// Widget categories and definitions with info tooltips
// defaultVisible: true = shown for new installs, false = opt-in only
interface WidgetDef {
  id: WidgetId;
  label: string;
  defaultVisible: boolean;
  locked?: boolean;     // core control — always on, non-toggleable in the config menu
  description: string;  // Shown in (i) tooltip in config popup
  bestFor: string;      // Who benefits most from this widget
}

interface WidgetCategory {
  name: string;
  widgets: WidgetDef[];
}

const WIDGET_CATEGORIES: WidgetCategory[] = [
  {
    name: 'Rate Limits',
    widgets: [
      {
        id: 'usage-5h',
        label: '5h Usage',
        defaultVisible: true,
        description: 'Shows how much of your 5-hour rate limit you\'ve used. Resets on a rolling window.',
        bestFor: 'Everyone. Helps you pace usage and avoid hitting rate limits during heavy sessions.',
      },
      {
        id: 'usage-7d',
        label: '7d Usage',
        defaultVisible: true,
        description: 'Shows how much of your 7-day rate limit you\'ve used. Resets on a rolling window.',
        bestFor: 'Everyone. Track your weekly usage pattern so you don\'t run out mid-week.',
      },
    ],
  },
  {
    name: 'Session',
    widgets: [
      {
        id: 'session-tags',
        label: 'Tags & Note',
        defaultVisible: true,
        locked: true,
        description: 'Tag the current session and attach a freeform note. Always shown next to the model and permission controls.',
        bestFor: 'Everyone. Organize and annotate sessions so they\'re easy to find and resume later.',
      },
      {
        id: 'context',
        label: 'Context %',
        defaultVisible: true,
        description: 'How much of Claude\'s conversation memory remains. Lower means Claude may forget earlier context.',
        bestFor: 'Everyone. When this drops below 20%, consider starting a new session to avoid lost context.',
      },
      {
        id: 'session-cost',
        label: 'Session Cost',
        defaultVisible: false,
        description: 'Estimated cost of this session in USD. For Pro/Max subscribers this is informational only (you\'re not billed per-token).',
        bestFor: 'API users tracking spend. Also useful for Pro/Max users curious about what their session would cost on the API.',
      },
      {
        id: 'session-time',
        label: 'Session Duration',
        defaultVisible: false,
        description: 'Total session time and how much of it Claude spent thinking (API time). Helps you understand your workflow pace.',
        bestFor: 'Power users who want to see how much of a session is active Claude work vs your own thinking/typing time.',
      },
      {
        id: 'active-ratio',
        label: 'Active Ratio',
        defaultVisible: false,
        description: 'What percentage of the session was Claude actively thinking (API time / wall time). Low means you\'re mostly reading; high means Claude is doing heavy lifting.',
        bestFor: 'Understanding your workflow rhythm. A 5% ratio on a long session means you\'re mostly reviewing; 50%+ means Claude is cranking.',
      },
    ],
  },
  {
    name: 'Tokens',
    widgets: [
      {
        id: 'tokens-in',
        label: 'Input Tokens',
        defaultVisible: false,
        description: 'Cumulative input tokens sent to Claude this session. Includes your messages, files, and system context.',
        bestFor: 'Power users monitoring how much context is being sent. Helpful for optimizing large-file workflows.',
      },
      {
        id: 'tokens-out',
        label: 'Output Tokens',
        defaultVisible: false,
        description: 'Cumulative output tokens Claude has generated this session. Higher means more verbose responses.',
        bestFor: 'Users who want to understand how much Claude is writing. Useful for gauging response verbosity.',
      },
      {
        id: 'cache-stats',
        label: 'Cache Efficiency',
        defaultVisible: false,
        description: 'Tokens read from the prompt cache vs created. Higher cached reads mean faster, cheaper requests.',
        bestFor: 'API users and power users. Shows how effectively prompt caching is working in your conversation.',
      },
      {
        // The id stays 'cache-hit-rate' on purpose — it is the persisted key for
        // everyone who already turned this chip on. Only what it MEASURES and
        // what it is CALLED changed; renaming the id would silently reset them.
        id: 'cache-hit-rate',
        label: 'Context Reuse',
        defaultVisible: false,
        description: 'How much of each prompt was reused from cache instead of re-read. Reused context is cheaper and much faster.',
        bestFor: 'Long conversations. A sudden drop means the cache stopped working — usually an idle gap, or a change of model.',
      },
      {
        id: 'output-speed',
        label: 'Output Speed',
        defaultVisible: false,
        description: 'Average output tokens per second across the session. Varies by model — Haiku is fastest, Opus is slowest.',
        bestFor: 'Comparing model performance. Useful when deciding whether to switch models for faster iteration.',
      },
    ],
  },
  {
    name: 'Code',
    widgets: [
      {
        id: 'code-changes',
        label: 'Code Changes',
        defaultVisible: false,
        description: 'Lines of code added and removed this session. A quick productivity snapshot.',
        bestFor: 'Developers using Claude for coding tasks. See at a glance how much code Claude has written.',
      },
      {
        id: 'git-branch',
        label: 'Git Branch',
        defaultVisible: true,
        description: 'The current git repository and branch for your working directory.',
        bestFor: 'Developers working across multiple branches or repos.',
      },
    ],
  },
  {
    name: 'Tasks',
    widgets: [
      {
        id: 'open-tasks',
        label: 'Open Tasks',
        defaultVisible: true,
        description: 'Chip showing tasks Claude is tracking in the current session (running + pending counts). Hides when there are no open tasks. Click to see the full list.',
        bestFor: 'Everyone who uses sessions where Claude juggles multiple tasks. Lets you see what\'s in flight without scrolling the chat.',
      },
    ],
  },
  {
    name: 'App',
    widgets: [
      {
        id: 'sync-warnings',
        label: 'Sync Warnings',
        defaultVisible: true,
        description: 'Alerts when sync isn\'t working (no internet, stale data, unsynced skills).',
        bestFor: 'YouCoded toolkit users. Keeps you aware of sync issues that could cause data loss.',
      },
      {
        id: 'theme',
        label: 'Theme',
        defaultVisible: true,
        description: 'Shows the active theme. Click to cycle through your configured themes.',
        bestFor: 'Anyone who uses multiple themes or wants quick access to theme switching.',
      },
      {
        id: 'version',
        label: 'Version',
        defaultVisible: true,
        description: 'Current YouCoded version. Glows when an update is available.',
        bestFor: 'Everyone. Stay up to date with the latest features and fixes.',
      },
    ],
  },
  {
    name: 'Updates',
    widgets: [
      {
        id: 'announcement',
        label: 'Announcement',
        defaultVisible: true,
        description: 'Platform announcements from the YouCoded team — new releases, outages, tips. Pulled every hour from the announcement cache.',
        bestFor: 'Everyone. Hides automatically when there is no active announcement.',
      },
    ],
  },
];

// Flat list for iteration
const ALL_WIDGET_DEFS = WIDGET_CATEGORIES.flatMap((c) => c.widgets);
const DEFAULT_VISIBLE = new Set<WidgetId>(ALL_WIDGET_DEFS.filter((w) => w.defaultVisible).map((w) => w.id));

const STORAGE_KEY = 'youcoded-statusbar-widgets';

function loadVisibility(): Set<WidgetId> {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const arr = JSON.parse(stored) as WidgetId[];
      // Only keep IDs that still exist in our definitions
      return new Set(arr.filter((id) => ALL_WIDGET_DEFS.some((w) => w.id === id)));
    }
  } catch { /* ignore */ }
  // Fresh install — use defaultVisible flags, not ALL
  return new Set(DEFAULT_VISIBLE);
}

function saveVisibility(visible: Set<WidgetId>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...visible]));
  } catch { /* ignore */ }
}

function useWidgetVisibility() {
  const [visible, setVisible] = useState<Set<WidgetId>>(loadVisibility);

  const toggle = useCallback((id: WidgetId) => {
    setVisible((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveVisibility(next);
      return next;
    });
  }, []);

  return { visible, toggle };
}

// --- Icons ---

// Pencil SVG icon (inline to avoid extra dependencies)
function PencilIcon() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M12.146.854a.5.5 0 0 1 .708 0l2.292 2.292a.5.5 0 0 1 0 .708l-9.5 9.5a.5.5 0 0 1-.168.11l-4 1.5a.5.5 0 0 1-.638-.638l1.5-4a.5.5 0 0 1 .11-.168l9.5-9.5zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5z"/>
    </svg>
  );
}

// Info (i) icon for widget descriptions
function InfoIcon({ className }: { className?: string }) {
  return (
    <svg className={className} width="12" height="12" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M8 15A7 7 0 1 1 8 1a7 7 0 0 1 0 14zm0 1A8 8 0 1 0 8 0a8 8 0 0 0 0 16z"/>
      <path d="m8.93 6.588-2.29.287-.082.38.45.083c.294.07.352.176.288.469l-.738 3.468c-.194.897.105 1.319.808 1.319.545 0 1.178-.252 1.465-.598l.088-.416c-.2.176-.492.246-.686.246-.275 0-.375-.193-.304-.533L8.93 6.588zM9 4.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0z"/>
    </svg>
  );
}

// Provider brand icon for the model chip. Uses the official Simple Icons
// brand paths on a standard 24×24 viewBox, rendered at 11×11 so they match
// the text height and line weight of the status bar precisely.
function ProviderIcon({ icon, className = '' }: { icon: ProviderIconKey; className?: string }) {
  const size = 11;
  switch (icon) {
    case 'openai':
      // Official OpenAI swirl mark (Simple Icons).
      return (
        <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" />
        </svg>
      );
    case 'anthropic':
      // Official Anthropic logo mark (Simple Icons).
      return (
        <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
        </svg>
      );
    case 'claudecode':
      // Official Claude / Claude Code mascot (the terracotta 8-bit bot character).
      return (
        <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          {/* Main rectangular head */}
          <rect x="4" y="3" width="16" height="13" rx="0.5" />
          {/* Left ear protrusion */}
          <rect x="2" y="7" width="2" height="5" rx="0.3" />
          {/* Right ear protrusion */}
          <rect x="20" y="7" width="2" height="5" rx="0.3" />
          {/* 4 legs */}
          <rect x="4" y="16" width="2.5" height="6" rx="0.3" />
          <rect x="8" y="16" width="2.5" height="6" rx="0.3" />
          <rect x="13.5" y="16" width="2.5" height="6" rx="0.3" />
          <rect x="17.5" y="16" width="2.5" height="6" rx="0.3" />
        </svg>
      );
    case 'google':
      // Official Google Gemini spark mark (Simple Icons).
      return (
        <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81" />
        </svg>
      );
    case 'qwen':
      // Official Qwen 3D-hexagon / interlocking prism logo mark.
      return (
        <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z" />
        </svg>
      );
    case 'grok':
      // Official Grok / xAI angular slash-ring logo mark.
      return (
        <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M9.27 15.29l7.978-5.897c.391-.29.95-.177 1.137.272.98 2.369.542 5.215-1.41 7.169-1.951 1.954-4.667 2.382-7.149 1.406l-2.711 1.257c3.889 2.661 8.611 2.003 11.562-.953 2.341-2.344 3.066-5.539 2.388-8.42l.006.007c-.983-4.232.242-5.924 2.75-9.383.06-.082.12-.164.179-.248l-3.301 3.305v-.01L9.267 15.292M7.623 16.723c-2.792-2.67-2.31-6.801.071-9.184 1.761-1.763 4.647-2.483 7.166-1.425l2.705-1.25a7.808 7.808 0 00-1.829-1A8.975 8.975 0 005.984 5.83c-2.533 2.536-3.33 6.436-1.962 9.764 1.022 2.487-.653 4.246-2.34 6.022-.599.63-1.199 1.259-1.682 1.925l7.62-6.815" />
        </svg>
      );
    case 'kimi':
      // Official Kimi / Moonshot AI K-burst logo mark.
      return (
        <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M21.846 0a1.923 1.923 0 110 3.846H20.15a.226.226 0 01-.227-.226V1.923C19.923.861 20.784 0 21.846 0z" />
          <path d="M11.065 11.199l7.257-7.2c.137-.136.06-.41-.116-.41H14.3a.164.164 0 00-.117.051l-7.82 7.756c-.122.12-.302.013-.302-.179V3.82c0-.127-.083-.23-.185-.23H3.186c-.103 0-.186.103-.186.23V19.77c0 .128.083.23.186.23h2.69c.103 0 .186-.102.186-.23v-3.25c0-.069.025-.135.069-.178l2.424-2.406a.158.158 0 01.205-.023l6.484 4.772a7.677 7.677 0 003.453 1.283c.108.012.2-.095.2-.23v-3.06c0-.117-.07-.212-.164-.227a5.028 5.028 0 01-2.027-.807l-5.613-4.064c-.117-.078-.132-.279-.028-.381z" />
        </svg>
      );
    case 'deepseek':
      // Official DeepSeek blue whale / flipper logo mark.
      return (
        <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614z" />
        </svg>
      );
    case 'meta':
      // Official Meta infinity loop logo mark.
      return (
        <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M6.897 4c1.915 0 3.516.932 5.43 3.376l.282-.373c.19-.246.383-.484.58-.71l.313-.35C14.588 4.788 15.792 4 17.225 4c1.273 0 2.469.557 3.491 1.516l.218.213c1.73 1.765 2.917 4.71 3.053 8.026l.011.392.002.25c0 1.501-.28 2.759-.818 3.7l-.14.23-.108.153c-.301.42-.664.758-1.086 1.009l-.265.142-.087.04a3.493 3.493 0 01-.302.118 4.117 4.117 0 01-1.33.208c-.524 0-.996-.067-1.438-.215-.614-.204-1.163-.56-1.726-1.116l-.227-.235c-.753-.812-1.534-1.976-2.493-3.586l-1.43-2.41-.544-.895-1.766 3.13-.343.592C7.597 19.156 6.227 20 4.356 20c-1.21 0-2.205-.42-2.936-1.182l-.168-.184c-.484-.573-.837-1.311-1.043-2.189l-.067-.32a8.69 8.69 0 01-.136-1.288L0 14.468c.002-.745.06-1.49.174-2.23l.1-.573c.298-1.53.828-2.958 1.536-4.157l.209-.34c1.177-1.83 2.789-3.053 4.615-3.16L6.897 4zm-.033 2.615l-.201.01c-.83.083-1.606.673-2.252 1.577l-.138.199-.01.018c-.67 1.017-1.185 2.378-1.456 3.845l-.004.022a12.591 12.591 0 00-.207 2.254l.002.188c.004.18.017.36.04.54l.043.291c.092.503.257.908.486 1.208l.117.137c.303.323.698.492 1.17.492 1.1 0 1.796-.676 3.696-3.641l2.175-3.4.454-.701-.139-.198C9.11 7.3 8.084 6.616 6.864 6.616zm10.196-.552l-.176.007c-.635.048-1.223.359-1.82.933l-.196.198c-.439.462-.887 1.064-1.367 1.807l.266.398c.18.274.362.56.55.858l.293.475 1.396 2.335.695 1.114c.583.926 1.03 1.6 1.408 2.082l.213.262c.282.326.529.54.777.673l.102.05c.227.1.457.138.718.138.176.002.35-.023.518-.073.338-.104.61-.32.813-.637l.095-.163.077-.162c.194-.459.29-1.06.29-1.785l-.006-.449c-.08-2.871-.938-5.372-2.2-6.798l-.176-.189c-.67-.683-1.444-1.074-2.27-1.074z" />
        </svg>
      );
    case 'mistral':
      // Official Mistral pixel-stairs logo mark.
      return (
        <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path clipRule="evenodd" d="M3.428 3.4h3.429v3.428h3.429v3.429h-.002 3.431V6.828h3.427V3.4h3.43v13.714H24v3.429H13.714v-3.428h-3.428v-3.429h-3.43v3.428h3.43v3.429H0v-3.429h3.428V3.4zm10.286 13.715h3.428v-3.429h-3.427v3.429z" />
        </svg>
      );
    case 'perplexity':
      // Official Perplexity asterism / 4-axis woven mark.
      return (
        <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path d="M19.785 0v7.272H22.5V17.62h-2.935V24l-7.037-6.194v6.145h-1.091v-6.152L4.392 24v-6.465H1.5V7.188h2.884V0l7.053 6.494V.19h1.09v6.49L19.786 0zm-7.257 9.044v7.319l5.946 5.234V14.44l-5.946-5.397zm-1.099-.08l-5.946 5.398v7.235l5.946-5.234V8.965zm8.136 7.58h1.844V8.349H13.46l6.105 5.54v2.655zm-8.982-8.28H2.59v8.195h1.8v-2.576l6.192-5.62zM5.475 2.476v4.71h5.115l-5.115-4.71zm13.219 0l-5.115 4.71h5.115v-4.71z" />
        </svg>
      );
    case 'cohere':
      // Official Cohere organic geometric cell mark.
      return (
        <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" fillRule="evenodd" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <path clipRule="evenodd" d="M8.128 14.099c.592 0 1.77-.033 3.398-.703 1.897-.781 5.672-2.2 8.395-3.656 1.905-1.018 2.74-2.366 2.74-4.18A4.56 4.56 0 0018.1 1H7.549A6.55 6.55 0 001 7.55c0 3.617 2.745 6.549 7.128 6.549z" />
          <path clipRule="evenodd" d="M9.912 18.61a4.387 4.387 0 012.705-4.052l3.323-1.38c3.361-1.394 7.06 1.076 7.06 4.715a5.104 5.104 0 01-5.105 5.104l-3.597-.001a4.386 4.386 0 01-4.386-4.387z" />
          <path d="M4.776 14.962A3.775 3.775 0 001 18.738v.489a3.776 3.776 0 007.551 0v-.49a3.775 3.775 0 00-3.775-3.775z" />
        </svg>
      );
    default:
      return null;
  }
}

// --- Config Popup ---
// Centered modal (matches SettingsPanel popup style) for customizing status bar widgets

function WidgetConfigPopup({ open, onClose, visible, toggle, relevance }: {
  open: boolean;
  onClose: () => void;
  visible: Set<WidgetId>;
  toggle: (id: WidgetId) => void;
  /** What this session can actually show — the SAME values the bar itself
   *  gates on, so the menu can never offer a chip the bar refuses to draw. */
  relevance: RelevanceContext;
}) {
  useEscClose(open, onClose);
  // Track which widget's (i) tooltip is expanded
  const [expandedInfo, setExpandedInfo] = useState<WidgetId | null>(null);
  // Track whether the Theme widget's cycle editor is expanded. Separate from
  // expandedInfo because the cycle editor is Theme-specific and collapses the
  // info panel when opened (and vice-versa) — they're mutually exclusive rows.
  const [cycleEditorOpen, setCycleEditorOpen] = useState(false);
  // Theme list + cycle membership come from the theme context, consumed here
  // so the Theme pill's cycle can be edited without leaving the widget popup.
  const { allThemes, cycleList, setCycleList } = useTheme();
  // Scroll-fade: hide scrollbar, fade edges to signal hidden scroll room.

  if (!open) return null;

  const toggleCycle = (slug: string) => {
    if (cycleList.includes(slug)) {
      // Keep at least one theme in the cycle — otherwise the pill has nothing to rotate to.
      const next = cycleList.filter(s => s !== slug);
      if (next.length > 0) setCycleList(next);
    } else {
      setCycleList([...cycleList, slug]);
    }
  };

  return createPortal(
    <>
      {/* This popup already used the outer-flex-wrapper centering that Dialog
          now owns -- it was one of the two places that had independently
          discovered transform centering breaks a bounded scroll region. Its
          "No flex-1" workaround is gone too: that was needed because its body
          was a bare overflow-y-auto div with no min-height:0, which .scroll-fade
          supplies. */}
      <Dialog open onClose={onClose} title="Status Bar Widgets" size="panel">
            {WIDGET_CATEGORIES.map((cat) => (
              <section key={cat.name}>
                <h3 className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-2">
                  {cat.name}
                </h3>
                <div className="space-y-0.5">
                  {cat.widgets.map((w) => {
                    const isExpanded = expandedInfo === w.id;
                    const isThemeRow = w.id === 'theme';
                    const showCycleEditor = isThemeRow && cycleEditorOpen;
                    const reason = widgetUnavailableReason(w.id, relevance);
                    return (
                      <div key={w.id}>
                        <div className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-inset transition-colors">
                          {/* Toggle checkbox — locked widgets (fixed controls)
                              render always-checked and non-interactive. When the
                              widget doesn't apply to this session's runtime,
                              swap the button for a plain, non-focusable row: it
                              is not a control here, so it must not look or
                              behave like one. The saved on/off choice is
                              untouched and returns when the user switches to a
                              session where the widget applies. */}
                          {reason ? (
                            /* Label on its own line, reason on the line beneath
                               it. WHY not side by side (how this used to read):
                               a long reason squeezed the label and wrapped
                               "Session Duration" onto two lines, so that one row
                               stood taller than every other row in the menu.
                               Stacked, each part gets a full line and every
                               dimmed row is the same height. The empty spacer
                               keeps the label's left edge on the same x as the
                               enabled rows, whose labels sit after a checkbox. */
                            <div className="flex items-start gap-2 flex-1 text-left opacity-50">
                              <span className="w-3.5 h-3.5 flex-shrink-0" />
                              <div className="flex-1 min-w-0">
                                <div className="text-2xs text-fg">{w.label}</div>
                                <div className="text-3xs text-fg-muted italic">{reason}</div>
                              </div>
                            </div>
                          ) : (
                          <button
                            onClick={() => { if (!w.locked) toggle(w.id); }}
                            disabled={w.locked}
                            className={`flex items-center gap-2 flex-1 text-left ${w.locked ? 'cursor-default' : ''}`}
                          >
                            <span
                              className={`w-3.5 h-3.5 rounded-sm border flex-shrink-0 flex items-center justify-center transition-colors ${
                                (w.locked || visible.has(w.id))
                                  ? 'bg-accent border-accent text-on-accent'
                                  : 'border-edge-dim'
                              }`}
                            >
                              {(w.locked || visible.has(w.id)) && (
                                <svg width="9" height="9" viewBox="0 0 16 16" fill="currentColor">
                                  <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z" />
                                </svg>
                              )}
                            </span>
                            <span className="text-2xs text-fg">{w.label}</span>
                            {w.locked && <span className="text-4xs text-fg-muted">always on</span>}
                          </button>
                          )}

                          {/* Pencil — Theme widget only. Opens the cycle editor
                              (which themes the pill rotates through). Moved here
                              from per-card checkmarks in the Appearance popup.
                              Gated on !reason too (belt-and-braces: 'theme' never
                              gets a reason today, but a dimmed row must never
                              carry a focusable element, full stop). */}
                          {isThemeRow && !reason && (
                            <button
                              onClick={() => {
                                setCycleEditorOpen(v => !v);
                                setExpandedInfo(null);
                              }}
                              className={`flex-shrink-0 p-0.5 rounded-sm transition-colors ${
                                showCycleEditor ? 'text-accent' : 'text-fg-faint hover:text-fg-muted'
                              }`}
                              title="Edit theme cycle"
                              aria-label="Edit theme cycle"
                            >
                              <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                                <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                              </svg>
                            </button>
                          )}

                          {/* (i) info toggle — hidden for a dimmed row. The row
                              already isn't a control (it's just explained why),
                              and the reason line itself is the info; a second
                              focusable element here would be the same defect as
                              leaving the checkbox tabbable. */}
                          {!reason && (
                            <button
                              onClick={() => {
                                setExpandedInfo(isExpanded ? null : w.id);
                                if (isThemeRow) setCycleEditorOpen(false);
                              }}
                              className={`flex-shrink-0 p-0.5 rounded-sm transition-colors ${
                                isExpanded ? 'text-accent' : 'text-fg-faint hover:text-fg-muted'
                              }`}
                              title="More info"
                            >
                              <InfoIcon />
                            </button>
                          )}
                        </div>

                        {/* Expanded info panel */}
                        {isExpanded && (
                          <div className="ml-7 mr-2 mb-1.5 px-2.5 py-2 rounded-md bg-inset border border-edge-dim text-3xs space-y-1.5">
                            <p className="text-fg-dim leading-relaxed">{w.description}</p>
                            <p className="text-fg-muted leading-relaxed">
                              <span className="font-medium text-fg-muted">Best for:</span> {w.bestFor}
                            </p>
                          </div>
                        )}

                        {/* Theme cycle editor — inline, mirrors the info-panel layout.
                            Tapping the theme pill in the status bar rotates through
                            every theme checked here. Must keep ≥1 in the cycle. */}
                        {showCycleEditor && (
                          <div className="ml-7 mr-2 mb-1.5 px-2.5 py-2 rounded-md bg-inset border border-edge-dim text-3xs space-y-1.5">
                            <p className="text-fg-dim leading-relaxed">
                              Pick which themes the pill rotates through when you tap it.
                            </p>
                            <div className="space-y-0.5 pt-1">
                              {allThemes.map(t => {
                                const inCycle = cycleList.includes(t.slug);
                                const isOnly = inCycle && cycleList.length === 1;
                                return (
                                  <button
                                    key={t.slug}
                                    onClick={() => toggleCycle(t.slug)}
                                    disabled={isOnly}
                                    className={`flex items-center gap-2 w-full px-1.5 py-1 rounded-sm text-left transition-colors ${
                                      isOnly ? 'opacity-50 cursor-not-allowed' : 'hover:bg-panel'
                                    }`}
                                    title={isOnly ? 'At least one theme must stay in the cycle' : undefined}
                                  >
                                    <span
                                      className={`w-3 h-3 rounded-sm border flex-shrink-0 flex items-center justify-center transition-colors ${
                                        inCycle ? 'bg-accent border-accent text-on-accent' : 'border-edge-dim'
                                      }`}
                                    >
                                      {inCycle && (
                                        <svg width="8" height="8" viewBox="0 0 16 16" fill="currentColor">
                                          <path d="M13.854 3.646a.5.5 0 0 1 0 .708l-7 7a.5.5 0 0 1-.708 0l-3.5-3.5a.5.5 0 1 1 .708-.708L6.5 10.293l6.646-6.647a.5.5 0 0 1 .708 0z" />
                                        </svg>
                                      )}
                                    </span>
                                    <span
                                      className="w-2.5 h-2.5 rounded-full flex-shrink-0 border border-edge-dim"
                                      style={{ background: `linear-gradient(135deg, ${t.tokens.canvas}, ${t.tokens.accent})` }}
                                    />
                                    <span className="text-fg truncate">{t.name}</span>
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
      </Dialog>
    </>,
    document.body
  );
}

// --- Main StatusBar component ---

// One vocabulary for every session-scoped chip (spec §2). Repeated wording is
// the point: three chips and the /usage card must not each invent their own
// description of the same scope.
const SCOPE_NOTE = 'Counts this session so far, including specialists.';
// One money formatter for the cost chip AND its tooltip. WHY shared: toFixed(2)
// rounds anything under half a cent to "$0.00", and a bar (or a tooltip) that
// reads "$0.00" while money is being spent reads as broken — spec §5 forbids
// that false zero. Extracted when the tooltip gained a second figure (the
// specialist split): two call sites formatting money two different ways is how
// a chip and its own tooltip end up disagreeing.
const formatCostUsd = (usd: number) => (usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`);

const INPUT_NOTE = 'Input is counted per request — a long turn re-sends its history each step, and that is what you are billed for.';

export default function StatusBar({
  statusData, onRunSync, onOpenSync, model, modelProviderType, provider,
  permissionMode, onCyclePermission, fast, effort, onOpenModelPicker,
  sessionId, onDispatch,
  openTasksCounts, onOpenOpenTasks,
  nativeUsage, nativeContextLength, turnsWithUsage, nativeTotals,
}: Props) {
  const { usage, updateStatus, contextPercent, gitBranch, sessionStats, syncWarnings } = statusData;

  // Dev-instance label (run-dev.sh --label → preload's devLabel). Read here rather
  // than at module scope because the remote shim assigns window.claude during
  // bootstrap, which can run after this module is imported. null in the built app
  // and on remote/Android, so this renders nothing there.
  const devLabel = window.claude?.devLabel ?? null;
  const { activeTheme, cycleTheme, contextDisplay } = useTheme();
  const { visible, toggle } = useWidgetVisibility();
  const [popupOpen, setPopupOpen] = useState(false);
  // Version pill now opens the in-app UpdatePanel (changelog + update action) instead of firing external URLs.
  const [updatePanelOpen, setUpdatePanelOpen] = useState(false);
  const [contextPopupOpen, setContextPopupOpen] = useState(false);

  // Runtime gate (spec §3, Rule 2): a widget that belongs to the OTHER runtime
  // never renders here, whatever the user's saved on/off choice says. The choice
  // itself is untouched and returns the moment they switch back.
  const runtime: SessionRuntime = provider ?? 'claude';
  const show = (id: WidgetId) => visible.has(id) && widgetApplies(id, runtime);
  const ss = sessionStats; // shorthand

  // Native-runtime chips (Task 12). Non-null only for native sessions that have
  // completed at least one turn; CC/idle sessions get null and render nothing
  // extra. Fed the session's real context window (resolved in main) so the
  // context % is accurate for the local model, not a hardcoded guess.
  const nativeChips = selectNativeStatusChips(nativeUsage, nativeContextLength);

  // In/Out come from the CC statusline for CC sessions and from SESSION TOTALS
  // for native ones. They used to come from the last completed turn, which made
  // one label mean two different measurements depending on the runtime — the
  // defect this change exists to remove (spec §6). Totals include specialists;
  // input is counted per request, because that is what a provider bills for.
  //
  // Fix: the "zero means nothing measured yet" collapse belongs ONLY to the
  // native branch, not to the shared variable. A statusline zero (ss?.xxx) is
  // a REAL measurement — e.g. a cold or expired prompt cache genuinely reads 0
  // cached tokens — and must pass through untouched, including a literal 0.
  // A native zero is ambiguous (emptyTotals() starts every session at all-zero,
  // before any turn has run), so ONLY nativeTotals collapses 0 -> null here;
  // the render gates below then use `!= null` to hide just that null, not a
  // real measured 0 from the statusline.
  const inTokens = ss?.inputTokens ?? (nativeTotals && nativeTotals.inputTokens > 0 ? nativeTotals.inputTokens : null);
  const outTokens = ss?.outputTokens ?? (nativeTotals && nativeTotals.outputTokens > 0 ? nativeTotals.outputTokens : null);
  // Cached/Reuse get the identical treatment: CC's statusline first (real
  // measurement, 0 included), then session totals for native (0 -> null,
  // nothing measured yet) — never the last-turn nativeChips, which would
  // blend "this session so far" and "the last turn" under one label again.
  const cacheReadTotal = ss?.cacheReadTokens ?? (nativeTotals && nativeTotals.cacheReadTokens > 0 ? nativeTotals.cacheReadTokens : null);
  const cacheCreationTotal = ss?.cacheCreationTokens ?? (nativeTotals && nativeTotals.cacheCreationTokens > 0 ? nativeTotals.cacheCreationTokens : null);
  // Speed had the identical problem: a CC chip stuck at "--" for native sessions
  // beside a native chip that duplicated it AND ignored show('output-speed'), so
  // hiding Speed in settings didn't hide it. CC derives it from the statusline's
  // apiDuration; native's provider already reports tokens/sec on turn-complete.
  // Unlike In/Out/Cached/Reuse above, this one stays LAST-TURN for both runtimes
  // — it measures a moment (how fast is it going right now), not a session total.
  const speedTokPerSec = ss?.outputTokens != null && ss?.apiDuration != null && ss.apiDuration > 0
    ? Math.round(ss.outputTokens / ss.apiDuration)
    : nativeChips?.tokensPerSecond ?? null;

  return (
    <div className="status-bar flex flex-wrap items-center gap-x-2 gap-y-1 px-2 sm:px-3 py-1 text-3xs text-fg-muted">
      {/* Combined model + effort pill — clicking opens the full picker (same as /effort).
         Shift+Space still cycles models via the keyboard shortcut in App.tsx.

         Restyle: the chip now uses the standard `bg-panel border-edge-dim` surface
         (same as usage/theme/version chips) with brand-colored TEXT + matching tinted
         BORDER. Native chips auto-detect the brand from the model id/provider type. */}
      {model && (model.kind === 'native' ? (
        // Native runtime: the bound model id IS the truth, so this chip never
        // shows an error state. The full id goes in the title because the label
        // is a best-effort prettification (and CSS-truncated when long).
        (() => {
          const nStyle = nativeChipStyle(model.modelId, modelProviderType);
          return (
            <button
              onClick={onOpenModelPicker}
              className="flex items-center gap-1.5 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:border-edge hover:bg-inset transition-colors max-w-[14rem] truncate"
              style={{ color: nStyle.color, borderColor: nStyle.borderColor }}
              title={`${model.modelId} — click to change model`}
            >
              {/* No effort segment: /effort and MAX_EFFORT_MODELS are Claude Code
                  concepts the native harness doesn't implement.
                  min-w-0 is load-bearing: a flex child defaults to min-width:auto
                  and won't shrink below its content, so `truncate` alone would let
                  a long GGUF name blow past the button's max-w instead of eliding. */}
              {nStyle.icon && <ProviderIcon icon={nStyle.icon} className="flex-shrink-0" />}
              <span className="truncate min-w-0">{model.label}</span>
            </button>
          );
        })()
      ) : (
        (() => {
          const display = ccChipDisplay(model);
          return (
            <button
              onClick={onOpenModelPicker}
              className="flex items-center gap-1.5 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:border-edge hover:bg-inset transition-colors"
              style={{ color: display.color, borderColor: display.border }}
              title={model.kind === 'unknown'
                ? "YouCoded couldn't confirm which model this session is using — click to set one explicitly"
                : 'Click to change model and effort (Shift+Space cycles model)'}
            >
              {display.icon && <ProviderIcon icon={display.icon} className="flex-shrink-0" />}
              <span>{display.label}</span>
              {model.kind !== 'unknown' && (
                <>
                  <span className="opacity-40">|</span>
                  <span className="capitalize">{effort || 'auto'} Effort</span>
                </>
              )}
            </button>
          );
        })()
      ))}

      {/* Fast mode is a Claude Code toggle read from the app-wide model-modes
          file — nothing in a native session honours it, so rendering it there
          is a control that lies (spec §1). Not a registry widget, so it takes
          the runtime gate directly rather than going through show(). */}
      {fast && runtime === 'claude' && (
        <button
          onClick={onOpenModelPicker}
          className="flex items-center px-1.5 py-0.5 rounded-sm border border-yellow-500/40 bg-yellow-500/15 text-yellow-500 cursor-pointer hover:brightness-125 transition-colors"
          title="Fast mode on — click to configure"
          aria-label="Fast mode on"
        >
          <FastIcon className="w-3 h-3" />
        </button>
      )}

      {/* Permission mode chip — always second */}
      {permissionMode && (
        <button
          onClick={onCyclePermission}
          className="px-1.5 py-0.5 rounded-sm border cursor-pointer hover:brightness-125 transition-colors"
          style={{
            backgroundColor: PERMISSION_DISPLAY[permissionMode].bg,
            color: PERMISSION_DISPLAY[permissionMode].color,
            borderColor: PERMISSION_DISPLAY[permissionMode].border,
          }}
          title={permissionMode === 'unknown'
            ? "YouCoded couldn't confirm this session's permission mode — click to set one explicitly"
            : 'Click to cycle permission mode (Shift+Tab)'}
        >
          <span className="sm:hidden">{PERMISSION_DISPLAY[permissionMode].shortLabel}</span>
          <span className="hidden sm:inline">{PERMISSION_DISPLAY[permissionMode].label}</span>
        </button>
      )}

      {/* Session tags & note — fixed control (design §"In-session surface").
          Hidden on Android (touch UI deferred); shown on desktop + remote. */}
      {!isAndroid() && <SessionTagsChip sessionId={sessionId ?? null} />}

      {/* Open Tasks chip — hidden when 0 open OR when widget is toggled off.
          Counts are derived at App root to share one useSessionTasks instance
          with the popup; two instances would have separate inactiveMap state
          that don't sync within the same page. */}
      {show('open-tasks') && openTasksCounts && onOpenOpenTasks && (
        <OpenTasksChip
          running={openTasksCounts.running}
          pending={openTasksCounts.pending}
          onOpen={onOpenOpenTasks}
        />
      )}

      {/* Specialists (1c) — hidden when the conversation has no helpers. */}
      <SpecialistsChip sessionId={sessionId} />

      {/* Rate limits */}
      {show('usage-5h') && usage?.five_hour != null && (
        <button
          onClick={() => window.claude.shell.openExternal('https://claude.ai/settings/usage')}
          className="flex items-center gap-1 sm:gap-1.5 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:bg-inset transition-colors"
          title="View usage on claude.ai"
        >
          <span>5h:</span>
          <span className={utilizationColor(usage.five_hour.utilization)}>
            {usage.five_hour.utilization}%
          </span>
          <span className="text-fg-muted hidden sm:inline">{format5hReset(usage.five_hour.resets_at)}</span>
        </button>
      )}
      {show('usage-7d') && usage?.seven_day != null && (
        <button
          onClick={() => window.claude.shell.openExternal('https://claude.ai/settings/usage')}
          className="flex items-center gap-1 sm:gap-1.5 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:bg-inset transition-colors"
          title="View usage on claude.ai"
        >
          <span>7d:</span>
          <span className={utilizationColor(usage.seven_day.utilization)}>
            {usage.seven_day.utilization}%
          </span>
          <span className="text-fg-muted hidden sm:inline">{format7dReset(usage.seven_day.resets_at)}</span>
        </button>
      )}

      {/* Context remaining — clickable opens ContextPopup (compact/clear actions + explainer).
          Renders as a percentage or as "used / window" per the contextDisplay pref;
          the aria-label always states the percentage so the accessible name stays
          stable and meaningful regardless of the visual mode. */}
      {show('context') && contextPercent != null && (() => {
        const pill = formatContextPill(
          contextPercent,
          derivedUsedTokens(contextPercent, sessionStats?.contextTokens),
          sessionStats?.contextTokens,
          contextDisplay,
        );
        return (
          <button
            onClick={() => setContextPopupOpen(true)}
            aria-haspopup="dialog"
            aria-label={`Context: ${contextPercent}% remaining. Click to manage context.`}
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:border-edge hover:bg-inset transition-colors"
          >
            <span>Context:</span>
            <span className={contextColor(contextPercent)}>{pill.value}</span>
            {pill.suffix && <span>{pill.suffix}</span>}
          </button>
        );
      })()}

      {/* Native-runtime context chip (Task 12) — derived from the local model's
          last turn-complete usage. Tokens and speed no longer render here: they
          feed the shared In:/Out:/Speed: chips further down, which are otherwise
          dead in native sessions (nothing writes the CC statusline).
          The CC context chip above renders from `contextPercent`, which is always
          null for native sessions (they write no .context-* file), so there is no
          duplicate context chip. Reuses the exact CC chip markup — no restyle.

          v1 limitation: values reflect the LAST COMPLETED turn, so during a long
          agentic turn the context chip lags until the turn finishes (spec #7). */}
      {nativeChips && (
        <>
          {/* Context remaining — reuses the CC context chip's visual style. Not a
              button: the CC version opens ContextPopup (CC-only /compact + /clear
              actions); native compaction is engine-driven, so this is display-only. */}
          {show('context') && nativeChips.contextPct != null && (() => {
            // Native passes its MEASURED used-token count straight through — unlike
            // the CC chip above, which has to derive "used" from a rounded percent.
            const pill = formatContextPill(
              nativeChips.contextPct,
              nativeChips.contextUsedTokens,
              nativeContextLength,
              contextDisplay,
            );
            return (
              // Clickable since M3 item 2 (Destin's request, 2026-07-25). It was
              // deliberately a plain <span> while the popup's only two actions —
              // Compact and Clear — had no native implementation and would have
              // been dead buttons. Both are real now, so this opens the SAME
              // ContextPopup the Claude Code chip does.
              <button
                onClick={() => setContextPopupOpen(true)}
                aria-haspopup="dialog"
                aria-label={`Context: ${nativeChips.contextPct}% remaining. Click to manage context.`}
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:border-edge hover:bg-inset transition-colors"
                title={`Context: ${nativeChips.contextPct}% of the model's window remaining${
                  nativeContextLength ? ` (${nativeChips.contextUsedTokens.toLocaleString()} of ${nativeContextLength.toLocaleString()} tokens used)` : ''
                }`}
              >
                <span>Context:</span>
                <span className={contextColor(nativeChips.contextPct)}>{pill.value}</span>
                {pill.suffix && <span>{pill.suffix}</span>}
              </button>
            );
          })()}

          {/* No "Tokens" or "Speed" chip here — native in/out/speed feed the
              shared In:/Out:/Speed: chips below (see the inTokens/outTokens/
              speedTokPerSec derivations), so each concept has exactly one chip
              and each honors its own show() toggle. */}
        </>
      )}

      {/* Session cost.
          CC sessions show Claude Code's own figure. Native sessions show the
          sum of per-turn costs priced in main, specialists included.
          The chip renders only when SOME counted work had a published price —
          not when "the session's model is metered": a free local session that
          delegated to an OpenRouter specialist really is spending money
          (spec §5). Nothing priced → no chip, never "$0.00". */}
      {show('session-cost') && (() => {
        const ccCost = ss?.costUsd ?? null;
        const nativeCost = nativeTotals?.anyPriced ? nativeTotals.costUsd : null;
        const cost = ccCost ?? nativeCost;
        if (cost == null) {
          // NEW branch (checkpoint #3). Nothing could be priced — but WHY not
          // has two opposite answers, and until now the bar gave the same
          // silent chipless row for both (verified with `magick compare`: the
          // local and unpriced review scenarios were pixel-identical). One of
          // those two is quietly spending the user's money.
          //   - anyUnpriced: the provider DOES bill, we just have no published
          //     rate for this model → say so, dimmed. Reaching here means
          //     nothing was priced at all, because a single priced turn would
          //     have made `cost` a real number above and won this slot.
          //   - anyFree only (a local model), or nothing measured at all →
          //     render nothing, exactly as before. Destin declined a "Free"
          //     chip (checkpoint #2); silence stays the answer there.
          if (ccCost == null && nativeTotals?.anyUnpriced) {
            return (
              <span
                className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
                // "available", not "published" (Task 22): the price lookup
                // returns nothing for ANY model missing from the catalog, and
                // a catalog that never loaded (dead network, empty cache)
                // looks identical to a model that genuinely has no rate.
                // Saying "no price is published" asserts a cause nobody
                // checked — docs/error-message-standards.md forbids that.
                title={"This provider bills for usage, but no price is available for this model here, so the session cost can't be totalled."}
              >
                <span className="text-fg-muted">Cost:</span>
                {/* Muted, not accent-coloured: this is an ABSENCE of a figure,
                    not an alert. Same treatment as the Reuse chip's "New". */}
                <span className="text-fg-muted">not listed</span>
              </span>
            );
          }
          return null;
        }
        // WHY the sub-cent guard (formatCostUsd): toFixed(2) rounds any real
        // cost under half a cent down to "$0.00", and a bar that reads "$0.00"
        // while money is actually being spent reads as broken — it's the false
        // zero spec §5 forbids ("Never $0.00"). The first turn of a native
        // session on a cheap metered model is a few hundred tokens ≈ $0.0004,
        // so this is the COMMON first thing a user sees, not an edge case. A
        // cost that is above zero but below a cent renders "<$0.01"; an exact
        // zero isn't a rounding artifact at all and takes the no-chip path
        // above, same as "nothing was priced".
        if (cost <= 0) return null;
        const partial = ccCost == null && nativeTotals?.anyUnpriced;
        // Checkpoint #4 — name where the money came from. Only on the NATIVE
        // figure: a Claude Code session's cost is Claude Code's own total, and
        // this app's specialist accounting is no part of it, so attributing a
        // slice of it here would be a claim we cannot back.
        const specialistCost = ccCost == null ? (nativeTotals?.specialistCostUsd ?? 0) : 0;
        const specialistRuns = ccCost == null ? (nativeTotals?.specialistRuns ?? 0) : 0;
        const title = ccCost != null
          ? 'Estimated cost of this session, as counted by Claude Code.'
          : `${SCOPE_NOTE} Priced from published rates, prompt-cache discounts included.`
            // Task 24 — "available", not "published". The price lookup returns
            // nothing both for a model that genuinely has no rate and for a
            // catalog that never loaded (dead network, empty cache), and the two
            // are indistinguishable here, so claiming nothing was PUBLISHED
            // states a cause nobody checked (docs/error-message-standards.md).
            // Byte-identical to UsageCard's PARTIAL_NOTE on purpose — the bar and
            // the card describe the same total, so they must word it the same way.
            + (partial ? ' Models with no available price are not included in this total.' : '')
            // The count is dropped rather than printed as "0 specialists" if
            // the two numbers ever disagree — a wrong sentence is worse than a
            // missing one (docs/error-message-standards.md).
            + (specialistCost > 0 && specialistRuns > 0
              ? ` ${formatCostUsd(specialistCost)} of this was spent by ${specialistRuns} specialist${specialistRuns === 1 ? '' : 's'} this session delegated to.`
              : '')
            + ' Not exact — a few models charge more above very large prompts.';
        return (
          <span
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
            title={title}
          >
            <span className="text-fg-muted">Cost:</span>
            <span className="text-fg-2">{formatCostUsd(cost)}</span>
            {/* Shown only when the session actually delegated: most never do,
                and this bar is already crowded. */}
            {specialistCost > 0 && <span className="text-fg-muted">· specialists</span>}
          </span>
        );
      })()}

      {/* Session duration — wall time and API thinking time.
          Rule 1 (spec §3): no value, no chip. This used to render a literal
          '--' — forever in a native session, where the statusline that feeds
          it never runs, and briefly in a CC session before the first stats
          arrive. An empty chip is furniture that teaches the user to ignore
          the bar. */}
      {show('session-time') && ss?.duration != null && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          title={ss.apiDuration != null ? `Wall: ${formatDuration(ss.duration)} | API: ${formatDuration(ss.apiDuration)}` : 'Session duration'}
        >
          <span>{formatDuration(ss.duration)}</span>
          {ss.apiDuration != null && (
            <span className="text-fg-muted hidden sm:inline">({formatDuration(ss.apiDuration)} API)</span>
          )}
        </span>
      )}

      {/* Input tokens. Rule 1 (spec §3): no value, no chip. In a native session
          this is a SESSION TOTAL (nativeTotals), not the last turn — see the
          inTokens derivation above (spec §6). Fix: the chip's DISPLAYED value
          stays formatTokens' abbreviated "12.3k" — a session total compounds
          across many turns and grows well past the point where a raw digit
          string is glanceable, which is exactly why the abbreviation exists.
          The exact count moves to the tooltip instead, where there's room.
          Gate is `!= null`, not truthy: a native zero is already collapsed to
          null above (nothing measured yet, since createSessionChatState()
          seeds a brand-new native session's totals at emptyTotals() — all
          ZERO), so `!= null` correctly hides it — but a REAL statusline
          measurement of 0 input tokens must still render, and a truthy check
          would wrongly swallow it too. */}
      {show('tokens-in') && inTokens != null && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          title={ss == null && nativeTotals != null
            ? `Input tokens: ${inTokens.toLocaleString()}. ${SCOPE_NOTE} ${INPUT_NOTE}`
            : `Input tokens: ${inTokens.toLocaleString()}`}
        >
          <span className="text-fg-muted">In:</span>
          <span className="text-fg-2">{formatTokens(inTokens)}</span>
        </span>
      )}

      {/* Output tokens. Rule 1 (spec §3): no value, no chip. Session total for
          native (spec §6); see the In chip above for why this stays
          abbreviated with the exact count in the tooltip.
          Gate is `!= null`, same reasoning as In above: a native zero is
          already collapsed to null (nothing measured yet), so `!= null`
          hides it correctly — but a statusline 0 (a real measured turn that
          genuinely produced no output tokens) must still render, and a
          truthy check would wrongly hide that real measurement too. */}
      {show('tokens-out') && outTokens != null && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          title={ss == null && nativeTotals != null
            ? `Output tokens: ${outTokens.toLocaleString()}. ${SCOPE_NOTE}`
            : `Output tokens: ${outTokens.toLocaleString()}`}
        >
          <span className="text-fg-muted">Out:</span>
          <span className="text-fg-2">{formatTokens(outTokens)}</span>
        </span>
      )}

      {/* Cache efficiency. WHY the ?? nativeTotals fallback: sessionStats is written
          by Claude Code's statusline, which native sessions never run — so these two
          chips sat at '--' forever while the harness shipped the numbers on every
          turn-complete. Native reads SESSION TOTALS here (spec §6), not the last
          turn — same reasoning as In/Out above.
          cr/cc are resolved ONCE so the title, the value and the hit-rate math can
          never disagree about which source they came from.
          Rule 1 (spec §3): no value, no chip — bail before rendering.
          Bail on null, not on falsy: a native zero is already collapsed to
          null above (a brand-new native session's cache totals start at 0,
          indistinguishable from "no turn has run yet to read from cache"),
          so bailing on null hides that case correctly — but a statusline 0
          (a real cold or expired prompt cache genuinely reading 0 cached
          tokens, which is common) is a measured value and must still render;
          bailing on falsy would wrongly hide that real 0 too. */}
      {show('cache-stats') && (() => {
        const cr = cacheReadTotal;
        if (cr == null) return null;
        const cc = cacheCreationTotal;
        return (
          <span
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
            title={ss == null && nativeTotals != null
              ? `Cache read: ${cr.toLocaleString()} | Cache created: ${(cc ?? 0).toLocaleString()}. ${SCOPE_NOTE}`
              : `Cache read: ${cr.toLocaleString()} | Cache created: ${(cc ?? 0).toLocaleString()}`}
          >
            <span className="text-fg-muted">Cached:</span>
            <span className="text-[#4CAF50]">{formatTokens(cr)}</span>
          </span>
        );
      })()}

      {/* Context reuse — how much of the prompt came from cache instead of being
          re-read. See selectCacheReuse for why this is NOT reads/(reads+writes).
          Session total for native (spec §6): reads nativeTotals, not the last
          turn's nativeChips, so this stops meaning something different from the
          In/Out/Cached chips beside it.
          Rule 1 (spec §3): 'unknown' means no data to report — bail before
          rendering. 'first-turn' is a real, known state (nothing to reuse yet)
          and keeps rendering "New", same as before. */}
      {show('cache-hit-rate') && (() => {
        const reuse = selectCacheReuse(ss, nativeTotals);
        const display = selectReuseDisplay(reuse, turnsWithUsage);
        if (display.kind === 'unknown') return null;
        const prompt = (reuse.promptTokens ?? 0).toLocaleString();
        const usingTotals = ss == null && nativeTotals != null;
        // Fix: zero reuse on a session TOTAL (as opposed to a single turn)
        // reads as an accusation — "Reused 0 of X" sounds like the cache is
        // broken, when it's just as likely nothing has been reused yet.
        // Reaching this branch already means promptTokens > 0 (selectCacheReuse
        // returns ratio: null, filtered above, whenever it isn't), so
        // readTokens === 0 here is a real "read fresh" measurement, not an
        // absent one — same friendlier framing the CC per-turn path already
        // uses for its own 0% case below.
        const title = usingTotals
          ? (reuse.readTokens === 0
            ? `None of this session's prompt tokens came from cache; all ${prompt} were read fresh. ${SCOPE_NOTE}`
            : `Reused ${(reuse.readTokens ?? 0).toLocaleString()} of this session's ${prompt} prompt tokens from cache. ${SCOPE_NOTE}`)
          : display.kind === 'first-turn'
          ? `Nothing to reuse yet — this is the session's first turn, so all ${prompt} prompt tokens were read fresh.`
          : display.pct === 0
            ? `None of this turn's prompt came from cache; all ${prompt} tokens were read fresh. Caches expire after a few minutes idle, and reset when the model or tool list changes.`
            : `Reused ${(reuse.readTokens ?? 0).toLocaleString()} of this turn's ${prompt} prompt tokens from cache — that part was cheaper and faster than re-reading it.`;
        return (
          <span
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
            title={title}
          >
            <span className="text-fg-muted">Reuse:</span>
            {display.kind === 'first-turn' && <span className="text-fg-muted">New</span>}
            {display.kind === 'percent' && (
              <span className={display.pct >= 80 ? 'text-[#4CAF50]' : display.pct >= 50 ? 'text-[#FF9800]' : 'text-[#DD4444]'}>
                {display.pct}%
              </span>
            )}
          </span>
        );
      })()}

      {/* Active ratio — derived: apiDuration / duration. Rule 1 (spec §3): no
          value, no chip. */}
      {show('active-ratio') && ss?.duration != null && ss?.apiDuration != null && ss.duration > 0 && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          title={`Claude thinking: ${formatDuration(ss.apiDuration)} of ${formatDuration(ss.duration)} total`}
        >
          <span className="text-fg-muted">Active:</span>
          <span className="text-fg-2">
            {Math.round((ss.apiDuration / ss.duration) * 100)}%
          </span>
        </span>
      )}

      {/* Output speed — derived: outputTokens / apiDuration. Rule 1 (spec §3):
          no value, no chip. Deliberately stays LAST-TURN for both runtimes (see
          the speedTokPerSec comment above) — never fed by nativeTotals.
          WHY the ternary's fallback branch is NOT dead: ss (sessionStats) is
          always null in a native session, so speedTokPerSec there falls back to
          nativeChips and this chip renders with the generic string below — do
          not "simplify" this back to one branch. */}
      {show('output-speed') && speedTokPerSec != null && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          title={ss?.outputTokens != null && ss?.apiDuration != null ? `${ss.outputTokens.toLocaleString()} tokens in ${formatDuration(ss.apiDuration)}` : 'Output tokens per second on the last turn'}
        >
          <span className="text-fg-muted">Speed:</span>
          <span className="text-fg-2">
            {speedTokPerSec} tok/s
          </span>
        </span>
      )}

      {/* Code changes — lines added/removed.
          CC sessions keep the statusline count: it is Claude Code's own number
          and covers edits made through ANY path, including shell commands.
          Native sessions use the derived count (structuredPatch hunks stored on
          tool calls AND on specialist segments). The two are not comparable
          across runtimes; each is the most complete number its runtime has.
          Nothing edited yet → the chip does not render. It used to say "No
          changes", which was FALSE in every native session (spec §1). */}
      {show('code-changes') && (() => {
        const added = ss?.linesAdded ?? nativeTotals?.linesAdded ?? null;
        const removed = ss?.linesRemoved ?? nativeTotals?.linesRemoved ?? null;
        if (!added && !removed) return null;
        const title = ss?.linesAdded != null
          ? `Lines added: ${added ?? 0} | Lines removed: ${removed ?? 0}`
          : `${SCOPE_NOTE} Counts edits made through the model's editing tools; edits made by shell commands are not counted.`;
        return (
          <span
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
            title={title}
          >
            <span className="text-[#4CAF50]">+{added ?? 0}</span>
            <span className="text-[#DD4444]">-{removed ?? 0}</span>
            <span className="text-fg-muted hidden sm:inline">lines</span>
          </span>
        );
      })()}

      {/* Git branch — reads from statusline.sh's .gitbranch-{sessionId} file */}
      {show('git-branch') && gitBranch && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border"
          style={{ color: '#0D9488', borderColor: 'rgba(13,148,136,0.35)' }}
          title={`Git: ${gitBranch}`}
        >
          {/* Branch icon (octicon git-branch) */}
          <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
            <path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/>
          </svg>
          <span>{gitBranch}</span>
        </span>
      )}

      {/* The background restore-pull chip was removed in sync-legacy-demolition —
          there is no pull/restore path feeding it anymore. */}

      {/* Sync status pill — at most one badge total.
          Red "Sync Failing" for any danger-level warning,
          orange "Sync Warning" for warn-only,
          nothing when synced. Click opens the panel where the descriptive copy lives. */}
      {show('sync-warnings') && (() => {
        const handler = onOpenSync || onRunSync;
        const severity = deriveWarningSeverity(syncWarnings ?? []);
        if (severity === null) return null;
        const isFailing = severity === 'failing';
        const label = isFailing ? 'Sync Failing' : 'Sync Warning';
        const styleClass = isFailing ? warnStyles.danger : warnStyles.warn;
        return (
          <button
            onClick={handler}
            className={`px-1.5 py-0.5 rounded-sm border text-4xs sm:text-3xs ${styleClass} ${handler ? 'cursor-pointer hover:brightness-125 transition-all' : ''}`}
            title={isFailing ? 'Sync is failing — click for details' : 'Sync warnings — click for details'}
          >
            {label}
          </button>
        );
      })()}

      {/* Theme pill */}
      {show('theme') && (
        <button
          onClick={cycleTheme}
          className="px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:bg-inset transition-colors"
          title="Click to cycle theme"
        >
          {activeTheme.name}
        </button>
      )}

      {/* Platform announcement — ★ orange pill, truncates long copy.
          Gate on isExpired so a stale cache entry (cleared remote but
          not yet re-fetched, or a date that rolled past midnight since
          last fetch) doesn't render. Defense-in-depth alongside the
          fetch-time filter in announcement-service.ts. */}
      {show('announcement') &&
        statusData.announcement?.message &&
        !isExpired(statusData.announcement.expires) && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border truncate max-w-[280px]"
          style={{
            color: '#EA580C',
            borderColor: 'rgba(234,88,12,0.35)',
          }}
          title={statusData.announcement.message}
        >
          <span aria-hidden>★</span>
          <span className="truncate">{statusData.announcement.message}</span>
        </span>
      )}

      {/* Version pill — shows YouCoded app version, glows yellow when update available.
         Click opens the in-app UpdatePanel (changelog + Update Now) — no more raw URL jumps. */}
      {show('version') && updateStatus && (
        <button
          onClick={() => setUpdatePanelOpen(true)}
          className={`px-1.5 py-0.5 rounded-sm border cursor-pointer transition-colors hidden sm:inline-flex ${
            updateStatus.update_available
              // steps(16): this glow runs from update-detection until the user
              // actually updates — days to weeks — in always-visible chrome, and
              // Reduced Effects does not gate it. Smooth ease-in-out means
              // presenting at the panel's full refresh rate for that entire
              // period (~29-33% of a core at 180Hz). 8 shadow changes/sec on a
              // soft 4->10px blur radius is imperceptible. See the "Perf:
              // frame-budget" note in globals.css.
              ? 'bg-[rgba(234,179,8,0.12)] border-[rgba(234,179,8,0.5)] hover:bg-[rgba(234,179,8,0.22)] animate-[version-glow_2s_steps(16)_infinite]'
              : 'bg-panel border-edge-dim hover:bg-inset'
          }`}
          title={
            (devLabel ? `Dev instance: ${devLabel} — ` : '') +
            (updateStatus.update_available
              ? `Update available: v${updateStatus.latest} — click to download`
              : `YouCoded v${updateStatus.current}`)
          }
        >
          {updateStatus.update_available ? (
            <span className="text-[#EAB308] font-medium">
              v{updateStatus.latest} — Update Available
            </span>
          ) : (
            <span>v{updateStatus.current}</span>
          )}
          {/* Dev-instance label rides the version pill: it's the one always-visible
              chip that already identifies "which build am I looking at". Accent so
              it reads at a glance across a row of otherwise-muted chips. Dev only. */}
          {devLabel && (
            <span className="text-accent font-medium ml-1">· {devLabel}</span>
          )}
        </button>
      )}

      {/* Customize widget — pencil icon opens config popup, always last */}
      <button
        onClick={() => setPopupOpen(true)}
        className="ml-auto flex items-center justify-center w-5 h-5 rounded-sm bg-panel border border-edge-dim cursor-pointer hover:bg-inset transition-colors"
        title="Customize Status Bar"
      >
        <PencilIcon />
      </button>

      {/* Config popup — centered modal with grouped widgets + (i) info */}
      <WidgetConfigPopup
        open={popupOpen}
        onClose={() => setPopupOpen(false)}
        visible={visible}
        toggle={toggle}
        // anyUnpriced rides along because the bar draws a "Cost: not listed"
        // chip for it — the menu has to offer the row whenever the chip is up.
        relevance={{ runtime, hasPricedWork: nativeTotals?.anyPriced ?? true, anyUnpriced: nativeTotals?.anyUnpriced ?? false, runsLocally: nativeTotals?.anyFree ?? false }}
      />

      {/* Update panel — opened from the version pill. Guard on updateStatus
         since the pill is only rendered when it exists, but the mount lives outside that gate. */}
      {updateStatus && (
        <UpdatePanel
          open={updatePanelOpen}
          onClose={() => setUpdatePanelOpen(false)}
          updateStatus={updateStatus}
        />
      )}

      {/* Context popup — portal-rendered; position in tree is cosmetic. */}
      {/* Native sessions have their own numbers: the CC fields (contextPercent /
          sessionStats) are always null for them, because a native session writes
          no statusline file. Feed the harness-derived figures so the popup shows
          real values instead of "--" now that the native pill can open it. */}
      <ContextPopup
        open={contextPopupOpen}
        onClose={() => setContextPopupOpen(false)}
        sessionId={sessionId ?? null}
        contextPercent={contextPercent ?? nativeChips?.contextPct ?? null}
        contextTokens={sessionStats?.contextTokens ?? nativeContextLength ?? null}
        onDispatch={onDispatch ?? (() => {})}
      />
    </div>
  );
}

export { MODELS, type ModelAlias };
