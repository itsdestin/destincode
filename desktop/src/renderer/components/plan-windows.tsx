// The two rolling windows a subscription is metered on (5-hour, 7-day), drawn
// the one way the app draws them. Extracted from UsageCard.tsx on 2026-09-05
// (Sign in with ChatGPT review, P-2): the Model Providers rows now show the
// same bars for the Claude plan and the ChatGPT plan, and one recipe in one
// file is how those three places stay identical.
import React from 'react';
import { ProgressBar } from './ui';

export interface PlanWindow { utilization: number; resets_at: string }
export interface PlanUsage { five_hour?: PlanWindow | null; seven_day?: PlanWindow | null }

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

/** Both bars, or nothing at all when neither window is known — a caller never
 *  has to check before rendering. `compact` drops the outer spacing for a row. */
export function PlanWindows({ usage, className = '' }: { usage: PlanUsage | null | undefined; className?: string }) {
  if (!usage?.five_hour && !usage?.seven_day) return null;
  return (
    <div className={`space-y-2 ${className}`}>
      {usage.five_hour && <WindowRow label="5-hour limit" win={usage.five_hour} />}
      {usage.seven_day && <WindowRow label="7-day limit" win={usage.seven_day} />}
    </div>
  );
}
