//
// Session-so-far totals for the status bar and the /usage card (spec §2).
//
// WHY accumulate instead of walking the timeline on demand: the reader is a
// useSyncExternalStore hook, which needs a referentially STABLE snapshot or
// React loops. An incremental object replaced only when a number actually
// changes is stable by construction, costs O(1) per event, and — because the
// reducer sees replayed events exactly as it sees live ones — is rebuilt for
// free when a resumed session replays its record. "Only when a number
// actually changes" is enforced explicitly: addTurnUsage/addSubagentUsage
// return the SAME object on a no-op call (e.g. a Claude Code turn, whose
// usage payload is absent) rather than allocating a lookalike copy — a
// specialist run is never a no-op, because it always increments
// specialistRuns even with zero usage.
//
// WHAT IS COUNTED, in one place, because three chips and a card all repeat it:
//   - every turn of this session, plus every specialist run under it
//   - input counted PER REQUEST: a long turn re-sends its history each step and
//     each send is counted, because that is what a provider bills for. (This is
//     deliberately NOT the context gauge's number — that one measures occupancy
//     and lives on TurnUsage.contextUsedTokens.)
import type { StructuredPatchHunk } from '../../shared/types';

export interface SessionTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** USD for work whose model had a published price. Work with no published
   *  price contributes NOTHING here and sets anyUnpriced instead — a false zero
   *  is worse than an absent chip (docs/error-message-standards.md). */
  costUsd: number;
  /** Some counted work had a published price → a cost figure means something. */
  anyPriced: boolean;
  /** Some counted work had NO published price → the figure is incomplete, and
   *  the tooltip has to say so. */
  anyUnpriced: boolean;
  /** Some counted work ran on a model that costs nothing to run (a local
   *  engine). Distinct from anyUnpriced, which means "metered, but we have no
   *  published rate" — opposite situations that the bar and the Customize menu
   *  must word differently. Both can be true at once: a free local parent that
   *  delegated to a metered specialist. */
  anyFree: boolean;
  linesAdded: number;
  linesRemoved: number;
  /** Specialist runs folded in above. Lets a tooltip say "including 3 specialists". */
  specialistRuns: number;
  /** Of costUsd, how much was spent by specialist runs rather than by this
   *  session's own turns. Lets the Cost chip name where the money came from
   *  instead of leaving it to a hover tooltip. Always ≤ costUsd. */
  specialistCostUsd: number;
}

export interface TurnUsageLike {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /** number = priced; null = native work with no published price; ABSENT = no
   *  pricing information at all (a Claude Code turn, whose cost comes from the
   *  statusline instead). The three cases are deliberately distinct. */
  costUsd?: number | null;
  /** True when the work ran on a model that costs nothing to run (a local
   *  engine). Main stamps it, because the renderer cannot tell a free local
   *  model from a metered one with no published price — SessionInfo carries no
   *  provider type. Absent is treated as false. */
  free?: boolean;
}

export function emptyTotals(): SessionTotals {
  return {
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
    costUsd: 0, anyPriced: false, anyUnpriced: false, anyFree: false,
    linesAdded: 0, linesRemoved: 0, specialistRuns: 0, specialistCostUsd: 0,
  };
}

// WHY a no-op guard: the chat reducer calls addTurnUsage(session.totals,
// action.usage ?? {}) on EVERY completed turn, and `?? {}` is exactly "no
// usage payload" — true for a Claude Code turn (its cost comes from the
// statusline instead) and for any turn whose usage is absent. That path
// runs constantly, not rarely. The totals object is read through
// useSyncExternalStore, which needs an UNCHANGED value to keep the SAME
// object reference or React re-render-loops — so allocating a new object
// unconditionally here would break that contract on the common case.
function addUsage(t: SessionTotals, u: TurnUsageLike): SessionTotals {
  const hasTokens = !!(u.inputTokens || u.outputTokens || u.cacheReadTokens || u.cacheCreationTokens);
  // costUsd carries information even when it's 0 or null — only a fully
  // absent field means "nothing to add" here. null still means something
  // ("priced work with no published price") and must produce a new object.
  const hasCost = u.costUsd !== undefined;
  // WHY `&& !t.anyFree` and not just `u.free`: anyFree is a latch — once set it
  // can never change again, so a free turn arriving at already-free totals
  // changes NOTHING. Every turn of a local session carries free: true, so
  // without this clause the common case would allocate a lookalike object on
  // every single turn and churn the useSyncExternalStore snapshot the guard
  // above exists to keep stable.
  const hasFree = u.free === true && !t.anyFree;
  if (!hasTokens && !hasCost && !hasFree) return t;

  const next: SessionTotals = {
    ...t,
    inputTokens: t.inputTokens + (u.inputTokens ?? 0),
    outputTokens: t.outputTokens + (u.outputTokens ?? 0),
    cacheReadTokens: t.cacheReadTokens + (u.cacheReadTokens ?? 0),
    cacheCreationTokens: t.cacheCreationTokens + (u.cacheCreationTokens ?? 0),
  };
  if (typeof u.costUsd === 'number') {
    next.costUsd = t.costUsd + u.costUsd;
    next.anyPriced = true;
  } else if (u.costUsd === null) {
    next.anyUnpriced = true;
  }
  // Set OUTSIDE the costUsd branches on purpose: "free to run" is a third state,
  // not a spelling of unpriced, and a free turn may also carry a cost field
  // (a free parent's totals still absorb its metered specialists' spend).
  if (u.free === true) next.anyFree = true;
  return next;
}

export function addTurnUsage(t: SessionTotals, u: TurnUsageLike): SessionTotals {
  return addUsage(t, u);
}

// WHY this can never take the no-op shortcut: a specialist run always
// increments specialistRuns, even one with zero usage — so it always
// changes the totals and must always return a new object.
export function addSubagentUsage(t: SessionTotals, u: TurnUsageLike): SessionTotals {
  const next = addUsage(t, u);
  const withRun: SessionTotals = next === t ? { ...t } : next;
  withRun.specialistRuns = t.specialistRuns + 1;
  // The same dollars, counted a second time in a narrower bucket — NOT extra
  // spend. Only a real published price lands here, exactly as costUsd above:
  // an unpriced specialist adds a run but no money, so specialistCostUsd can
  // never claim a figure costUsd doesn't already contain.
  if (typeof u.costUsd === 'number') withRun.specialistCostUsd = t.specialistCostUsd + u.costUsd;
  return withRun;
}

/** Count real edits out of jsdiff-style hunks. Hunk lines are prefixed ' ',
 *  '-' or '+' by construction (tools/edit.ts, tools/write.ts), so this is a
 *  prefix count, not a diff. Defensive against a malformed record: a hunk with
 *  no lines array contributes nothing rather than throwing inside a reducer. */
export function addPatchLines(t: SessionTotals, hunks: StructuredPatchHunk[] | undefined): SessionTotals {
  if (!hunks?.length) return t;
  let added = 0;
  let removed = 0;
  for (const h of hunks) {
    if (!Array.isArray(h?.lines)) continue;
    for (const line of h.lines) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  }
  if (!added && !removed) return t;
  return { ...t, linesAdded: t.linesAdded + added, linesRemoved: t.linesRemoved + removed };
}
