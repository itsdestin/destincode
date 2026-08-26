import { useEffect, useState } from 'react';
import type { ToolCallState } from '../../../shared/types';

/** "Working in the background · 2m 14s" / "Finished in 4m · 5 steps" — the
 *  one line that answers "is it done?" without opening anything. Ticks once a
 *  second only while running. */
export function RunStatusLine({ run, report }: { run: NonNullable<ToolCallState['specialistRun']>; report?: ToolCallState['specialistReport'] }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (run.status !== 'running') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [run.status]);
  const end = run.endedAt ?? now;
  const elapsed = formatElapsed(Math.max(0, end - run.startedAt));
  const steps = run.steps !== undefined ? ` · ${run.steps} step${run.steps === 1 ? '' : 's'}` : '';
  let text: string;
  let tone = 'text-fg-muted';
  if (run.status === 'running') {
    text = `${run.background ? 'Working in the background' : 'Working'} · ${elapsed}${run.stale ? ' · no activity for a while — may be stuck' : ''}`;
    if (run.stale) tone = 'text-amber-500';
  } else if (run.status === 'completed') {
    text = report?.status === 'failed' ? `Failed after ${elapsed}${steps}` : `Finished in ${elapsed}${steps}`;
    // Fix: `danger` isn't a real token (no --color-danger in globals.css), so this
    // line rendered in plain body color instead of red on failure. `destructive-fg`
    // is the app's real error/destructive text token.
    if (report?.status === 'failed') tone = 'text-destructive-fg';
  } else if (run.status === 'failed') {
    text = `Failed after ${elapsed}${steps}`;
    tone = 'text-destructive-fg';
  } else {
    text = `Stopped after ${elapsed}${steps} — the assistant can pick this back up`;
  }
  return <div className={`text-xs ${tone}`} data-testid="specialist-status-line">{text}</div>;
}

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

