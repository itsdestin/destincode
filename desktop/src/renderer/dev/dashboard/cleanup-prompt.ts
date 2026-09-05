import type { Checkout } from './api';

const LINE: Record<Checkout['status'], (c: Checkout) => string> = {
  unsaved: (c) => `${c.dirty} uncommitted file(s) — git has no copy of these`,
  unpushed: (c) => `${c.ahead} commit(s) not on GitHub`,
  pushed: () => 'pushed to GitHub, not yet merged',
  safe: () => 'merged into master and clean',
};

/** The prompt a fresh conversation gets.
 *
 *  It carries the MEASUREMENTS, not just the pill, so whoever reads it can
 *  re-check the conclusion rather than trust it — the summary is exactly the
 *  thing that has been wrong before. And it asks for a PLAN: a prompt that says
 *  "delete these" invites acting before checking. */
export function buildCleanupPrompt(selected: Checkout[]): string {
  const risky = selected.filter((c) => c.status === 'unsaved' || c.status === 'unpushed');

  const rows = selected
    .map((c) => `- ${c.name} (${c.branch ?? 'detached, no branch'}) at ${c.path} — ${LINE[c.status](c)}`)
    .join('\n');

  const warning = risky.length
    ? `\n${risky.length} of these hold the only copy of some work. That needs saving or pushing `
      + 'first — deleting them would lose it.\n'
    : '';

  return (
    `I want to clean up these ${selected.length} worktree(s) in the youcoded workspace:\n\n`
    + `${rows}\n${warning}\n`
    + 'Please check each one yourself before doing anything — re-run the status rather than '
    + 'trusting the summary above — then give me a plan for which are safe to remove and what '
    + "needs saving or pushing first. Don't remove anything until I say so.\n"
  );
}
