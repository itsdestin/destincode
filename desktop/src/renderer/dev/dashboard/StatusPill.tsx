import type { Checkout, Status } from './api';

// The COPY is the feature. A pill that says "0 ahead" makes the reader do the
// reasoning; these say what deleting the folder would actually cost.
//
// The container stays NEUTRAL and a coloured dot carries the state — design rule
// 6, the same shape ErrorState and StatusStrip already use. Errors are not red
// boxes here.
export const PILL_COPY: Record<Status, { label: string; hint: string; dot: string }> = {
  unsaved: {
    label: 'Unsaved work',
    hint: 'Files here have never been saved to git. This is the only copy — deleting the folder loses them.',
    dot: 'bg-destructive',
  },
  unpushed: {
    label: 'Unpushed work',
    hint: 'Saved to git, but never sent to GitHub. The commits exist only on this disk.',
    dot: 'bg-amber-500',
  },
  pushed: {
    label: 'Pushed',
    hint: 'On GitHub. Deleting this folder loses nothing permanent.',
    dot: 'bg-green-500',
  },
  safe: {
    label: 'Safe to delete',
    hint: 'Already merged into master, nothing uncommitted.',
    dot: 'bg-fg-muted/40',
  },
};

/** The measurements behind the pill, in words. Shown on hover so the conclusion
 *  can be checked rather than trusted — the pill is a judgement, and the numbers
 *  are what it was made from. */
export function pillDetail(c: Checkout): string {
  const bits: string[] = [];
  if (c.dirty > 0) bits.push(`${c.dirty} uncommitted file${c.dirty === 1 ? '' : 's'}`);
  if (c.ahead > 0) bits.push(`${c.ahead} commit${c.ahead === 1 ? '' : 's'} ahead of master`);
  if (c.branch && c.pushed) bits.push('tip matches GitHub');
  if (c.merged) bits.push('merged into master');
  return bits.length ? bits.join(' · ') : 'nothing ahead, nothing uncommitted';
}

/** The main checkout is never "safe to delete" — everything else hangs off it, and
 *  a green all-clear beside it invites exactly the wrong action. Every OTHER state
 *  passes through unchanged: suppressing the all-clear must not suppress a real
 *  warning, because an uncommitted file in the shared checkout matters as much as
 *  it does anywhere else. */
export function mainPillCopy(status: Status): { label: string; hint: string; dot: string } {
  if (status !== 'safe') return PILL_COPY[status];
  return {
    label: 'Main checkout',
    hint: 'The shared checkout every worktree hangs off. Not something to remove.',
    dot: 'bg-fg-muted/40',
  };
}

export function StatusPill({ status, isMain }: { status: Status; isMain?: boolean }) {
  const c = isMain ? mainPillCopy(status) : PILL_COPY[status];
  return (
    <span
      // aria-label carries the consequence for a screen reader. It is NOT the
      // only place the detail lives — the row prints the measurements as visible
      // text, because a tooltip never fires on a touchscreen.
      aria-label={`${c.label}. ${c.hint}`}
      className="inline-flex shrink-0 items-center gap-1.5 rounded-sm border border-edge-dim bg-inset px-1.5 py-0.5 text-3xs leading-none text-fg-2"
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${c.dot}`} aria-hidden="true" />
      {c.label}
    </span>
  );
}
