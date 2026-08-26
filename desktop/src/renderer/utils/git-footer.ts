// Footer-entry visibility (mockup ledger 9): show the Review Changes button
// when the file has uncommitted changes OR any git history; counts render only
// when there are uncommitted changes. Pure so it unit-tests without React.
import type { GitFileStatusResult, GitFileCounts } from '../../shared/git-types';

export function gitFooterState(
  s: GitFileStatusResult | null,
): { show: boolean; counts: GitFileCounts | null; conflicted: boolean } {
  if (!s || !s.ok || !s.isRepo) return { show: false, counts: null, conflicted: false };
  const changed = s.counts !== null;
  // conflicted forces show: a mid-merge file must never read as clean here
  // (2026-07-22 bug — unmerged entries used to vanish from the footer).
  return {
    show: changed || s.hasHistory || s.conflicted,
    counts: changed ? s.counts : null,
    conflicted: s.conflicted,
  };
}
