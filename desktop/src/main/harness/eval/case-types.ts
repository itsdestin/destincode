// The data type describing one evaluation task, plus the checks and rubric
// items a case can carry. `HARNESS_BATTERY` (cases/harness-battery.ts) is the
// first EvalCase; the registry (cases/index.ts) is how a runner looks one up
// by id.
// Imported AND re-exported: `Check.run` below needs CaseRun in local scope,
// while report.ts, judge.ts, assertions.ts, and their tests all import
// CaseRun from here rather than from run-case.ts directly — this file is the
// case-layer's type surface.
import type { CaseRun } from './run-case';
export type { CaseRun };

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
