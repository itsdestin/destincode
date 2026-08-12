// The data type describing one evaluation task, plus the checks and rubric
// items a case can carry. `HARNESS_BATTERY` (cases/harness-battery.ts) is the
// first EvalCase; the registry (cases/index.ts) is how a runner looks one up
// by id.
import type { BatteryRun } from './run-case';

// WHY an alias rather than a fresh type: the plan (docs/active/plans/
// 2026-08-12-harness-evaluator.md, Task 2 note) renames BatteryRun -> CaseRun
// once run-case.ts itself becomes case-agnostic, but that rename touches
// run-case.ts/run-facts.ts, which are outside this task's file list (and
// potentially live in a sibling worktree's hands right now). Aliasing keeps
// `Check.run` typed against the real finished-run shape today without
// duplicating it or racing the rename.
export type CaseRun = BatteryRun;

export type CheckState = 'passed' | 'failed' | 'never-ran';

export interface CheckResult {
  id: string;
  state: CheckState;
  detail: string;
}

export interface Check {
  id: string;
  run(run: CaseRun): CheckResult;
}

export interface RubricItem {
  id: string;
  ask: string;
}

export interface EvalCase {
  id: string;
  prompt: string;
  wrapUpPrompt: string;
  /** Minimum tool calls for this task to have been attempted at all. */
  minToolCalls: number;
  expect: Check[];
  rubric: RubricItem[];
}
