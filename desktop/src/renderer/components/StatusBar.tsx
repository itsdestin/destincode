import { useState, useCallback } from 'react';
import { useEscClose } from '../hooks/use-esc-close';
import { createPortal } from 'react-dom';
import { useTheme, type ContextDisplay } from '../state/theme-context';
import type { PermissionMode } from '../../shared/types';
import type { NativePermissionMode } from '../../shared/permission-types';
import { isExpired } from '../../shared/announcement';
import type { SyncWarning } from '../../main/sync-state';
import { deriveWarningSeverity } from '../state/sync-display-state';
import { FastIcon } from './Icons';
import UpdatePanel from './UpdatePanel';
import ContextPopup from './ContextPopup';
import OpenTasksChip from './OpenTasksChip';
import { isAndroid } from '../platform';
import { SessionTagsChip } from './tags/SessionTagsChip';
import { Dialog } from './ui';

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

// Model aliases sent to the CC CLI via `/model <alias>`. `opus[1m]` keeps the
// bracket form so CC selects Opus's 1M-context variant; the alias→transcript
// matcher (App.tsx) strips the `[...]` before substring-matching the raw model
// id (`'claude-fable-5'.includes('fable')`), so a bare `fable` alias slots in
// with no collision. Labels are model-class only (no version numbers) by design.
const MODELS = ['haiku', 'sonnet', 'opus[1m]', 'fable'] as const;
type ModelAlias = typeof MODELS[number];

const MODEL_DISPLAY: Record<ModelAlias | 'unknown', { label: string; color: string; bg: string; border: string }> = {
  sonnet:      { label: 'Sonnet', color: '#9CA3AF', bg: 'rgba(156,163,175,0.15)', border: 'rgba(156,163,175,0.25)' },
  'opus[1m]':  { label: 'Opus',   color: '#818CF8', bg: 'rgba(129,140,248,0.15)', border: 'rgba(129,140,248,0.25)' },
  haiku:       { label: 'Haiku',  color: '#2DD4BF', bg: 'rgba(45,212,191,0.15)',  border: 'rgba(45,212,191,0.25)' },
  // Fable 5 — most capable. Fuchsia pill reads as the top/premium tier, distinct
  // from Opus's indigo and the amber reserved for AUTO permission mode.
  fable:       { label: 'Fable',  color: '#E879F9', bg: 'rgba(232,121,249,0.15)', border: 'rgba(232,121,249,0.25)' },
  // Error state, not a real model — red like the high-danger usage threshold
  // (utilizationColor/contextColor) so it reads as "wrong", never as a normal pill.
  unknown:     { label: 'Model Unknown', color: '#DD4444', bg: 'rgba(221,68,68,0.15)', border: 'rgba(221,68,68,0.3)' },
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

/**
 * Native chip color. `--tag-blue` is the one slot in the tag palette that
 * collides with nothing else in this bar: gray/indigo/teal/fuchsia are the four
 * CC aliases (teal is Haiku), red is both Unknown chips, and --accent/amber/
 * salmon are permission modes. Themeable per the tag system rather than a fifth
 * hardcoded hex; the fill/border formula is TagChip.tsx's, so native model chips
 * and session tags read as one family.
 */
/** MODEL_DISPLAY row for the two Claude Code chip states. */
function ccChipDisplay(model: Exclude<ModelChip, { kind: 'native' }>) {
  return MODEL_DISPLAY[model.kind === 'unknown' ? 'unknown' : model.alias];
}

const NATIVE_CHIP = 'var(--tag-blue)';
const nativeChipStyle = {
  color: NATIVE_CHIP,
  backgroundColor: `color-mix(in srgb, ${NATIVE_CHIP} 16%, transparent)`,
  borderColor: `color-mix(in srgb, ${NATIVE_CHIP} 35%, transparent)`,
};

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
const PERMISSION_DISPLAY: Record<PermissionMode | NativePermissionMode | 'unknown', { label: string; shortLabel: string; color: string; bg: string; border: string }> = {
  normal:        { label: 'NORMAL',             shortLabel: 'NORMAL',  color: 'var(--fg-muted)', bg: 'var(--inset)',  border: 'var(--edge-dim)' },
  'auto-accept': { label: 'ACCEPT CHANGES',     shortLabel: 'ACCEPT',  color: 'var(--accent)',   bg: 'var(--well)',   border: 'var(--edge)' },
  plan:          { label: 'PLAN MODE',           shortLabel: 'PLAN',    color: 'var(--fg-2)',     bg: 'var(--inset)',  border: 'var(--edge)' },
  auto:          { label: 'AUTO MODE',           shortLabel: 'AUTO',    color: '#F2B33D', bg: 'rgba(242,179,61,0.15)',  border: 'rgba(242,179,61,0.25)' },
  bypass:        { label: 'BYPASS PERMISSIONS',  shortLabel: 'BYPASS',  color: '#FA8072', bg: 'rgba(250,128,114,0.15)', border: 'rgba(250,128,114,0.25)' },
  // Native runtime modes (Task 13).
  ask:           { label: 'ASK FIRST',          shortLabel: 'ASK',     color: 'var(--fg-muted)', bg: 'var(--inset)',  border: 'var(--edge-dim)' },
  'auto-edit':   { label: 'AUTO EDIT',          shortLabel: 'EDIT',    color: 'var(--accent)',   bg: 'var(--well)',   border: 'var(--edge)' },
  'full-auto':   { label: 'FULL AUTO',          shortLabel: 'FULL',    color: '#F2B33D', bg: 'rgba(242,179,61,0.15)',  border: 'rgba(242,179,61,0.25)' },
  // Error state — App.tsx passes this when the real mode can't be confirmed
  // (unrecognized value, missing data on resume/reconnect) rather than guessing
  // 'normal'/'ask', which would misrepresent what's actually enforced.
  unknown:       { label: 'PERMISSION UNKNOWN',  shortLabel: 'UNKNOWN', color: '#DD4444', bg: 'rgba(221,68,68,0.15)', border: 'rgba(221,68,68,0.3)' },
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
}


const warnStyles = {
  danger: 'bg-[#DD4444]/15 text-[#DD4444] border-[#DD4444]/25',
  warn: 'bg-[#FF9800]/15 text-[#FF9800] border-[#FF9800]/25',
};

// --- Widget visibility system ---

type WidgetId =
  | 'usage-5h' | 'usage-7d' | 'context' | 'git-branch' | 'sync-warnings' | 'theme' | 'version'
  | 'session-cost' | 'tokens-in' | 'tokens-out' | 'cache-stats' | 'code-changes' | 'session-time'
  | 'cache-hit-rate' | 'active-ratio' | 'output-speed'
  | 'announcement'
  | 'open-tasks'
  | 'session-tags';

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
        id: 'cache-hit-rate',
        label: 'Cache Hit Rate',
        defaultVisible: false,
        description: 'Percentage of cached tokens that were reads (hits) vs new creations. 90%+ means the cache is warm and working well.',
        bestFor: 'Power users optimizing cost. Low hit rates mean your prompts are changing too much for the cache to help.',
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

// --- Config Popup ---
// Centered modal (matches SettingsPanel popup style) for customizing status bar widgets

function WidgetConfigPopup({ open, onClose, visible, toggle }: {
  open: boolean;
  onClose: () => void;
  visible: Set<WidgetId>;
  toggle: (id: WidgetId) => void;
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
                    return (
                      <div key={w.id}>
                        <div className="flex items-center gap-2 px-2 py-1.5 rounded-md hover:bg-inset transition-colors">
                          {/* Toggle checkbox — locked widgets (fixed controls)
                              render always-checked and non-interactive. */}
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

                          {/* Pencil — Theme widget only. Opens the cycle editor
                              (which themes the pill rotates through). Moved here
                              from per-card checkmarks in the Appearance popup. */}
                          {isThemeRow && (
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

                          {/* (i) info toggle */}
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

export default function StatusBar({
  statusData, onRunSync, onOpenSync, model,
  permissionMode, onCyclePermission, fast, effort, onOpenModelPicker,
  sessionId, onDispatch,
  openTasksCounts, onOpenOpenTasks,
  nativeUsage, nativeContextLength,
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

  const show = (id: WidgetId) => visible.has(id);
  const ss = sessionStats; // shorthand

  // Native-runtime chips (Task 12). Non-null only for native sessions that have
  // completed at least one turn; CC/idle sessions get null and render nothing
  // extra. Fed the session's real context window (resolved in main) so the
  // context % is accurate for the local model, not a hardcoded guess.
  const nativeChips = selectNativeStatusChips(nativeUsage, nativeContextLength);

  // In/Out come from the CC statusline for CC sessions and from turn-complete
  // usage for native ones. Native used to render its OWN "Tokens" chip (just
  // in+out summed) while these two sat at "--" forever, because sessionStats is
  // only ever written by CC — two dead chips beside a redundant third
  // (Destin, 2026-07-28). One concept, one chip, whichever runtime feeds it.
  const inTokens = ss?.inputTokens ?? nativeChips?.inputTokens ?? null;
  const outTokens = ss?.outputTokens ?? nativeChips?.outputTokens ?? null;
  // Speed had the identical problem: a CC chip stuck at "--" for native sessions
  // beside a native chip that duplicated it AND ignored show('output-speed'), so
  // hiding Speed in settings didn't hide it. CC derives it from the statusline's
  // apiDuration; native's provider already reports tokens/sec on turn-complete.
  const speedTokPerSec = ss?.outputTokens != null && ss?.apiDuration != null && ss.apiDuration > 0
    ? Math.round(ss.outputTokens / ss.apiDuration)
    : nativeChips?.tokensPerSecond ?? null;

  return (
    <div className="status-bar flex flex-wrap items-center gap-x-2 gap-y-1 px-2 sm:px-3 py-1 text-3xs text-fg-muted">
      {/* Combined model + effort pill — clicking opens the full picker (same as /effort).
         Shift+Space still cycles models via the keyboard shortcut in App.tsx. */}
      {model && (model.kind === 'native' ? (
        // Native runtime: the bound model id IS the truth, so this chip never
        // shows an error state. The full id goes in the title because the label
        // is a best-effort prettification (and CSS-truncated when long).
        <button
          onClick={onOpenModelPicker}
          className="flex items-center px-1.5 py-0.5 rounded-sm border cursor-pointer hover:brightness-125 transition-colors max-w-[14rem] truncate"
          style={nativeChipStyle}
          title={`${model.modelId} — click to change model`}
        >
          {/* No effort segment: /effort and MAX_EFFORT_MODELS are Claude Code
              concepts the native harness doesn't implement.
              min-w-0 is load-bearing: a flex child defaults to min-width:auto
              and won't shrink below its content, so `truncate` alone would let
              a long GGUF name blow past the button's max-w instead of eliding. */}
          <span className="truncate min-w-0">{model.label}</span>
        </button>
      ) : (
        <button
          onClick={onOpenModelPicker}
          className="flex items-center gap-1.5 px-1.5 py-0.5 rounded-sm border cursor-pointer hover:brightness-125 transition-colors"
          style={{
            backgroundColor: ccChipDisplay(model).bg,
            color: ccChipDisplay(model).color,
            borderColor: ccChipDisplay(model).border,
          }}
          title={model.kind === 'unknown'
            ? "YouCoded couldn't confirm which model this session is using — click to set one explicitly"
            : 'Click to change model and effort (Shift+Space cycles model)'}
        >
          <span>{ccChipDisplay(model).label}</span>
          {model.kind !== 'unknown' && (
            <>
              <span className="opacity-40">|</span>
              <span className="capitalize">{effort || 'auto'} Effort</span>
            </>
          )}
        </button>
      ))}

      {/* Fast mode chip — only rendered when on. Click opens the ModelPickerPopup. */}
      {fast && (
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

      {/* Session cost — estimated USD cost for this session */}
      {show('session-cost') && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          title="Estimated session cost (informational for Pro/Max subscribers)"
        >
          <span>Cost:</span>
          <span className="text-fg-2">
            {ss?.costUsd != null ? `$${ss.costUsd < 0.01 ? '<0.01' : ss.costUsd.toFixed(2)}` : '--'}
          </span>
        </span>
      )}

      {/* Session duration — wall time and API thinking time */}
      {show('session-time') && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          title={ss?.duration != null && ss?.apiDuration != null ? `Wall: ${formatDuration(ss.duration)} | API: ${formatDuration(ss.apiDuration)}` : 'Session duration'}
        >
          <span>{ss?.duration != null ? formatDuration(ss.duration) : '--'}</span>
          {ss?.duration != null && ss?.apiDuration != null && (
            <span className="text-fg-muted hidden sm:inline">({formatDuration(ss.apiDuration)} API)</span>
          )}
        </span>
      )}

      {/* Input tokens */}
      {show('tokens-in') && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          title={inTokens != null ? `Input tokens: ${inTokens.toLocaleString()}` : 'Input tokens'}
        >
          <span className="text-fg-muted">In:</span>
          <span className="text-fg-2">{inTokens != null ? formatTokens(inTokens) : '--'}</span>
        </span>
      )}

      {/* Output tokens */}
      {show('tokens-out') && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          title={outTokens != null ? `Output tokens: ${outTokens.toLocaleString()}` : 'Output tokens'}
        >
          <span className="text-fg-muted">Out:</span>
          <span className="text-fg-2">{outTokens != null ? formatTokens(outTokens) : '--'}</span>
        </span>
      )}

      {/* Cache efficiency. WHY the ?? nativeChips fallback: sessionStats is written
          by Claude Code's statusline, which native sessions never run — so these two
          chips sat at '--' forever while the harness shipped the numbers on every
          turn-complete. Same fix the In/Out and Speed chips got on 2026-07-28.
          cr/cc are resolved ONCE so the title, the value and the hit-rate math can
          never disagree about which source they came from. */}
      {show('cache-stats') && (() => {
        const cr = ss?.cacheReadTokens ?? nativeChips?.cacheReadTokens ?? null;
        const cc = ss?.cacheCreationTokens ?? nativeChips?.cacheCreationTokens ?? null;
        return (
          <span
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
            title={cr != null ? `Cache read: ${cr.toLocaleString()} | Cache created: ${(cc ?? 0).toLocaleString()}` : 'Cache efficiency'}
          >
            <span className="text-fg-muted">Cached:</span>
            <span className="text-[#4CAF50]">{cr != null ? formatTokens(cr) : '--'}</span>
          </span>
        );
      })()}

      {/* Cache hit rate — derived: cacheRead / (cacheRead + cacheCreation) */}
      {show('cache-hit-rate') && (() => {
        const cr = ss?.cacheReadTokens ?? nativeChips?.cacheReadTokens ?? null;
        const cc = ss?.cacheCreationTokens ?? nativeChips?.cacheCreationTokens ?? null;
        const total = (cr ?? 0) + (cc ?? 0);
        return (
          <span
            className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
            title={cr != null ? `${cr.toLocaleString()} reads / ${total.toLocaleString()} total cached tokens` : 'Cache hit rate'}
          >
            <span className="text-fg-muted">Hit:</span>
            {(() => {
              if (cr == null) return <span className="text-fg-2">--</span>;
              if (total === 0) return <span className="text-fg-muted">N/A</span>;
              const pct = Math.round((cr / total) * 100);
              const color = pct >= 80 ? 'text-[#4CAF50]' : pct >= 50 ? 'text-[#FF9800]' : 'text-[#DD4444]';
              return <span className={color}>{pct}%</span>;
            })()}
          </span>
        );
      })()}

      {/* Active ratio — derived: apiDuration / duration */}
      {show('active-ratio') && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          title={ss?.duration != null && ss?.apiDuration != null ? `Claude thinking: ${formatDuration(ss.apiDuration)} of ${formatDuration(ss.duration)} total` : 'Active ratio'}
        >
          <span className="text-fg-muted">Active:</span>
          <span className="text-fg-2">
            {ss?.duration != null && ss?.apiDuration != null && ss.duration > 0
              ? `${Math.round((ss.apiDuration / ss.duration) * 100)}%`
              : '--'}
          </span>
        </span>
      )}

      {/* Output speed — derived: outputTokens / apiDuration */}
      {show('output-speed') && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          title={ss?.outputTokens != null && ss?.apiDuration != null ? `${ss.outputTokens.toLocaleString()} tokens in ${formatDuration(ss.apiDuration)}` : 'Output tokens per second on the last turn'}
        >
          <span className="text-fg-muted">Speed:</span>
          <span className="text-fg-2">
            {speedTokPerSec != null ? `${speedTokPerSec} tok/s` : '--'}
          </span>
        </span>
      )}

      {/* Code changes — lines added/removed */}
      {show('code-changes') && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm bg-panel border border-edge-dim"
          title={ss?.linesAdded != null ? `Lines added: ${ss.linesAdded} | Lines removed: ${ss.linesRemoved ?? 0}` : 'Code changes'}
        >
          {ss?.linesAdded != null || ss?.linesRemoved != null ? (
            <>
              <span className="text-[#4CAF50]">+{ss?.linesAdded ?? 0}</span>
              <span className="text-[#DD4444]">-{ss?.linesRemoved ?? 0}</span>
              <span className="text-fg-muted hidden sm:inline">lines</span>
            </>
          ) : (
            <span className="text-fg-muted">No changes</span>
          )}
        </span>
      )}

      {/* Git branch — reads from statusline.sh's .gitbranch-{sessionId} file */}
      {show('git-branch') && gitBranch && (
        <span
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm border"
          style={{ backgroundColor: 'rgba(45,212,191,0.10)', color: '#2DD4BF', borderColor: 'rgba(45,212,191,0.25)' }}
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
          className="flex items-center gap-1 px-1.5 py-0.5 rounded-sm border truncate max-w-[280px]"
          style={{
            backgroundColor: 'rgba(255,152,0,0.15)',
            color: '#FF9800',
            borderColor: 'rgba(255,152,0,0.25)',
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
