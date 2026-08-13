// How many tokens ONE specialist's report may occupy in the parent's context
// (spec §3, plan 1a Task 7).
//
// WHY this is headroom-aware rather than a flat per-specialist number: a static
// cap is sized against an EMPTY parent, and a parent is almost never empty when
// it delegates. Hermes (NousResearch, `_apply_summary_budget`) shipped the flat
// version first and hit a real fan-out → parent-context-blowout death spiral:
// N children each returning a full static-cap report overflowed a parent that
// was already most of the way through its window, which forced a compaction
// that threw away the very conversation the reports were meant to advance. The
// fix — and the formula below — is to divide what the parent can STILL afford
// across the children currently reporting, and take the smaller of that and the
// definition's own cap. (2026-08-11 subagent-platform research, §Hermes.)
//
// In plan 1a `concurrentReporters` is always 1 (delegation is foreground: the
// parent is blocked on exactly one child). It is a parameter anyway because 1b
// adds parallel fan-out, and the division is the whole point of the formula —
// discovering it was missing later would mean rediscovering Hermes's bug.

/** Share of the parent's REMAINING window that all reports together may claim.
 *  Half, not all: the parent still has to think, call tools, and answer AFTER
 *  reading the reports. */
const HEADROOM_FRACTION = 0.5;

/** Never hand back less than this, even to a parent with no room left. Below a
 *  couple hundred tokens a "report" is a truncation notice with a few words
 *  attached — strictly worse for the parent than a short but real answer, and
 *  it wastes the entire child run that produced it. */
const MIN_REPORT_TOKENS = 200;

export interface ReportBudgetInput {
  /** The specialist definition's own cap (SpecialistDefinition.reportBudgetTokens). */
  staticCapTokens: number;
  /** Parent context window minus what it currently occupies. Pass `Infinity`
   *  when occupancy is unmeasurable (no step has reported usage yet) — that
   *  degrades to the static cap rather than to the floor. */
  parentRemainingTokens: number;
  /** Children whose reports will land in this parent. 1 in plan 1a. */
  concurrentReporters: number;
}

export function computeReportBudget(i: ReportBudgetInput): number {
  // max(1, …) so a caller that passes 0 reporters divides by one child rather
  // than producing Infinity (which would silently disable the headroom half).
  const share = Math.floor((i.parentRemainingTokens * HEADROOM_FRACTION) / Math.max(1, i.concurrentReporters));
  return Math.max(MIN_REPORT_TOKENS, Math.min(i.staticCapTokens, share));
}
