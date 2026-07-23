// Footer-entry visibility (mockup ledger 9): show the Review Changes button
// when the file has uncommitted changes OR any git history; counts render only
// when there are uncommitted changes. Pure so it unit-tests without React.
import type { GitFileStatusResult, GitFileCounts } from '../../shared/git-types';

export function gitFooterState(
  s: GitFileStatusResult | null,
): { show: boolean; counts: GitFileCounts | null } {
  if (!s || !s.ok || !s.isRepo) return { show: false, counts: null };
  const changed = s.counts !== null;
  return { show: changed || s.hasHistory, counts: changed ? s.counts : null };
}
