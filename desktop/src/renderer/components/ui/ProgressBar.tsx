
/**
 * Determinate progress (change 46, §1.8).
 *
 * Unifies three near-misses: ModelLoadingBar (bg-well track), FirstRunView
 * (already matched), and LocalModelsSection (unrounded fill). Track is always
 * bg-inset — never bg-well.
 */

export type ProgressBarProps = {
  /** 0-100. Clamped, so callers can pass raw ratios without guarding. */
  percent: number;
  /** Status hue for the fill (UsageCard's thresholds). Omit for bg-accent. */
  color?: string;
  /** Right-aligned percent readout. */
  showLabel?: boolean;
  'aria-label'?: string;
  className?: string;
};

export function ProgressBar({
  percent,
  color,
  showLabel = false,
  className = '',
  'aria-label': ariaLabel,
}: ProgressBarProps) {
  const pct = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));

  return (
    <div className={`flex items-center gap-2 ${className}`.trim()}>
      <div
        className="flex-1 h-1.5 rounded-full bg-inset overflow-hidden"
        role="progressbar"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={ariaLabel}
      >
        <div
          // transition only width — animating a generic `all` here also animates
          // background-color, which makes UsageCard's status-hue changes smear.
          className={`h-full rounded-full transition-[width] duration-300 ease-out ${color ? '' : 'bg-accent'}`}
          style={{ width: `${pct}%`, backgroundColor: color }}
        />
      </div>
      {showLabel && (
        // tabular-nums so the readout doesn't jitter horizontally as digits change
        <span className="text-xs text-fg-muted tabular-nums shrink-0">{Math.round(pct)}%</span>
      )}
    </div>
  );
}
