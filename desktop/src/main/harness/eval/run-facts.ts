// What the transcript says a run did, rendered for the reviews doc.
//
// WHY this exists: on 2026-08-10 a model made 14 tool calls — 13 Read, one Glob,
// one Bash — and wrote a review describing Edit duplicate-string tests,
// replace_all, and a `sleep 15` timeout with exit 124. It was appended as a
// genuine review and only caught by hand-reading the transcript. The evidence
// was already on disk, written thirty lines earlier by the CLI, and nothing
// consulted it.
//
// WHY pure: it takes a finished BatteryRun and returns strings, so the check is
// unit-testable without a session or a paid run.
import { CORE_TOOLS } from '../tools';
import type { BatteryRun, BatteryMetrics, BatteryOutcome } from './run-case';

// Below this, a run did not exercise ten tools across seven areas, whatever its
// text claims. Round 5's Qwen 3.6 27B stopped after two calls.
export const MIN_TOOL_CALLS = 10;

// WHY derived from CORE_TOOLS rather than a hand-copied name list: the tool
// roster changes independently of this file, and a hand-copied list would
// silently drift out of sync with what the harness actually offers.
const TOOL_NAMES = CORE_TOOLS.map((t) => t.name);

export interface RunFacts {
  metrics: BatteryMetrics;
  outcome: BatteryOutcome;
  // Derived, never re-typed: this WAS a hand-copied literal union and it went
  // stale the moment a fourth trigger ('stopped-early') was added — tsc caught
  // it, but only because the assignment happened to be checked. Same reasoning
  // as TOOL_NAMES above.
  wrapUpReason?: BatteryRun['wrapUpReason'];
  error?: string;
  /** Tools the review names that never appear in metrics.toolsUsed. */
  unbackedClaims: string[];
  belowFloor: boolean;
}

/** Tool names mentioned in the review text, as whole words. WHY whole words:
 *  "Reading the file" must not count as the Read tool, or every review would
 *  flag. Sorted and deduplicated so the output is stable.
 *
 *  WHY escape the name before interpolating into a RegExp: every current
 *  CORE_TOOLS name is plain PascalCase with no regex metacharacters, so this
 *  is currently a no-op — but nothing enforces that stays true, and an
 *  unescaped name (e.g. one containing `.` or `+`) would silently change what
 *  "whole word" means instead of throwing. Cheap to harden now. */
export function claimedTools(reviewText: string): string[] {
  return TOOL_NAMES.filter((name) => {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`\\b${escaped}\\b`).test(reviewText);
  }).sort();
}

/** WHY a parameter: MIN_TOOL_CALLS is "what it takes to walk the battery" and
 *  is nonsense for a task like "explain this file", where two calls is a
 *  complete answer. The default keeps every existing caller identical. */
export function collectRunFacts(run: BatteryRun, minToolCalls: number = MIN_TOOL_CALLS): RunFacts {
  const used = new Set(run.metrics.toolsUsed);
  return {
    metrics: run.metrics,
    outcome: run.outcome,
    wrapUpReason: run.wrapUpReason,
    error: run.error,
    unbackedClaims: claimedTools(run.review).filter((name) => !used.has(name)),
    belowFloor: run.metrics.toolCalls < minToolCalls,
  };
}

function duration(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s`;
}

/** A markdown block for the reviews doc: warnings first (if any), then what the
 *  run measurably did. WHY warnings FLAG rather than judge: a review that
 *  honestly says "I never reached Edit" trips the unbacked-claims check too, and
 *  a reader settles that in two seconds. Refusing to append would spend real
 *  money and then discard the result on a heuristic. */
/** WHY a parameter: the warning text below quotes the floor the run was
 *  judged against. If a caller threads a custom floor into collectRunFacts
 *  but not here, the rendered warning would claim a run failed the
 *  battery's 10 when it was actually judged against a per-task floor — a
 *  false statement in a report a human is meant to trust. Default keeps
 *  every existing caller identical. */
export function renderRunFacts(facts: RunFacts, minToolCalls: number = MIN_TOOL_CALLS): string {
  const lines: string[] = [];

  if (facts.unbackedClaims.length) {
    lines.push(
      `> ⚠️ This review names ${facts.unbackedClaims.join(', ')}, which the ` +
      `transcript shows no call to. Check the claims against the run before ` +
      `acting on them.`,
      '',
    );
  }
  if (facts.belowFloor) {
    lines.push(
      `> ⚠️ Only ${facts.metrics.toolCalls} tool calls — below the ${minToolCalls} ` +
      `it takes to walk the battery. This run did not cover the tools.`,
      '',
    );
  }

  const m = facts.metrics;
  const ending = facts.wrapUpReason
    ? `wrapped up (${facts.wrapUpReason})`
    : facts.outcome;
  lines.push(
    `**Run facts:** ${ending} · ${m.toolCalls} tool calls · ${m.asks} asks · ` +
    `${m.stepGates} step gates · ${m.thinkingEvents} thinking events · ` +
    `${m.outputTokens.toLocaleString()} output tokens · ${duration(m.wallClockMs)}`,
    '',
    `**Tools actually used:** ${m.toolsUsed.length ? m.toolsUsed.join(', ') : 'none'}`,
  );
  if (facts.error) lines.push('', `**Error:** ${facts.error}`);

  return lines.join('\n');
}
