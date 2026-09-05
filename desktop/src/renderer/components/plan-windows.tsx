// The two rolling windows a subscription is metered on (5-hour, 7-day), drawn
// the one way the app draws them. Extracted from UsageCard.tsx on 2026-09-05
// (Sign in with ChatGPT review, P-2): the Model Providers rows now show the
// same bars for the Claude plan and the ChatGPT plan, and one recipe in one
// file is how those three places stay identical.
import React from 'react';
import { ProgressBar } from './ui';

export interface PlanWindow { utilization: number; resets_at: string }
/** A window that is neither 5 hours nor 7 days long, tagged with its length. */
export interface OtherPlanWindow extends PlanWindow { minutes: number }
export interface PlanUsage {
  five_hour?: PlanWindow | null;
  seven_day?: PlanWindow | null;
  /** Words deck W-2 = a (2026-09-05): OpenAI's free plan reports ONE 30-day
   *  window and no 5-hour or 7-day one, so drawing only the two keys above
   *  showed two empty bars on Destin's own account. Anything of another
   *  length lands here and is drawn AFTER the two approved bars, labelled by
   *  its real length. A Plus plan never fills this, so its screens are
   *  unchanged. */
  other?: OtherPlanWindow[] | null;
}

/** The short name of a window by its length — "30d" for a month, "5h" for
 *  five hours. Whole days round to days, anything shorter to hours. Used for
 *  the status-bar chip label; the bar label below is the long form of it. */
export function windowLengthLabel(minutes: number): string {
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}d`;
  return `${Math.round(minutes / 60)}h`;
}

/** "30-day limit" — the bar's label for an odd-length window, in the same
 *  shape as the approved "5-hour limit" / "7-day limit". */
export function windowBarLabel(minutes: number): string {
  if (minutes >= 1440) return `${Math.round(minutes / 1440)}-day limit`;
  return `${Math.round(minutes / 60)}-hour limit`;
}

/** "resets in 2h 9m" / "resets in 4d" / "resetting". Empty for no date. */
export function formatResetsAt(iso: string | null | undefined): string {
  if (!iso) return '';
  try {
    const diff = new Date(iso).getTime() - Date.now();
    if (diff <= 0) return 'resetting';
    const hours = Math.floor(diff / 3_600_000);
    const mins = Math.floor((diff % 3_600_000) / 60_000);
    if (hours === 0) return `resets in ${mins}m`;
    if (hours < 24) return `resets in ${hours}h ${mins}m`;
    return `resets in ${Math.floor(hours / 24)}d`;
  } catch {
    return '';
  }
}

/** Status colours stay theme-independent (CLAUDE.md): green under 50% used,
 *  amber to 80%, red above. */
export function utilizationColor(pct: number | null | undefined): string {
  if (pct == null) return 'var(--fg-muted)';
  if (pct >= 80) return '#ef4444';
  if (pct >= 50) return '#f59e0b';
  return '#10b981';
}

function WindowRow({ label, win }: { label: string; win: PlanWindow }) {
  const color = utilizationColor(win.utilization);
  return (
    <div>
      <div className="flex justify-between text-xs mb-1">
        <span className="text-fg-muted">{label} · {formatResetsAt(win.resets_at)}</span>
        <span className="tabular-nums" style={{ color }}>{Math.round(win.utilization)}%</span>
      </div>
      <ProgressBar percent={win.utilization} color={color} className="w-full" aria-label={label} />
    </div>
  );
}

/** Every window the plan has, or nothing at all when none is known — a caller
 *  never has to check before rendering. Order: 5-hour, 7-day, then the odd
 *  lengths as reported. A plan with no windows draws no empty bars. */
export function PlanWindows({ usage, className = '' }: { usage: PlanUsage | null | undefined; className?: string }) {
  const other = usage?.other?.filter((w) => w && typeof w.minutes === 'number') ?? [];
  if (!usage?.five_hour && !usage?.seven_day && other.length === 0) return null;
  return (
    <div className={`space-y-2 ${className}`}>
      {usage!.five_hour && <WindowRow label="5-hour limit" win={usage!.five_hour} />}
      {usage!.seven_day && <WindowRow label="7-day limit" win={usage!.seven_day} />}
      {other.map((w, i) => <WindowRow key={`${w.minutes}-${i}`} label={windowBarLabel(w.minutes)} win={w} />)}
    </div>
  );
}
