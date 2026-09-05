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

/** Everything a fresh session needs to deal with one branch's unsaved work.
 *  Carries the file list because "40 uncommitted files" is not something anyone
 *  can act on, and the kinds because whether it is notes or code changes what to
 *  do with it. */
export function buildSaveWorkPrompt(
  checkout: Checkout,
  detail: { byKind: Record<string, Array<{ file: string; state: string }>>; commits: Array<{ subject: string }>; lastCommitRel: string | null },
): string {
  const groups = Object.entries(detail.byKind)
    .map(([kind, files]) => `${kind} (${files.length}):\n${files.map((f) => `  ${f.file} — ${f.state}`).join('\n')}`)
    .join('\n\n');

  const about = detail.commits.length
    ? `\nWhat the branch was doing, from its most recent changes:\n${detail.commits.slice(0, 5).map((c) => `  ${c.subject}`).join('\n')}\n`
    : '\nThe branch has no commits of its own beyond master.\n';

  return (
    `The worktree ${checkout.name} (branch ${checkout.branch ?? 'detached'}) at ${checkout.path} `
    + `has ${checkout.dirty} uncommitted file(s). Git has no copy of them, so this folder is the `
    + 'only place they exist.\n\n'
    + `${groups}\n${about}`
    + `\nLast commit there was ${detail.lastCommitRel ?? 'unknown'}.\n\n`
    + 'Please look at what is actually in these files and tell me, in plain terms, what this '
    + 'work is and whether it is worth keeping. Then recommend what to do with it — finish it, '
    + 'commit and push it as-is, or discard it. Do not discard anything until I say so.\n'
  );
}

/** For a branch that is already saved: what is it, and what is left to do. */
export function buildReviewPrompt(
  checkout: Checkout,
  detail: { commits: Array<{ subject: string }>; lastCommitRel: string | null; pr: { number?: number; state?: string } | null },
): string {
  const commits = detail.commits.length
    ? `Its changes beyond master:\n${detail.commits.map((c) => `  ${c.subject}`).join('\n')}\n`
    : 'It has no commits beyond master.\n';

  const pr = detail.pr?.number
    ? `It has pull request #${detail.pr.number} (${detail.pr.state?.toLowerCase()}).\n`
    : 'It has no pull request.\n';

  return (
    `Tell me about the branch ${checkout.branch ?? checkout.name} at ${checkout.path}.\n\n`
    + `${commits}${pr}`
    + `Last commit ${detail.lastCommitRel ?? 'unknown'}.\n\n`
    + 'In plain terms: what was this for, is it finished, and what would it take to close it '
    + 'out? Check the branch itself rather than trusting the summary above.\n'
  );
}
