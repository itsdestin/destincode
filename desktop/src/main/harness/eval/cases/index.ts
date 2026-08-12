import { HARNESS_BATTERY } from './harness-battery';
import type { EvalCase } from '../case-types';

const CASES: Record<string, EvalCase> = { [HARNESS_BATTERY.id]: HARNESS_BATTERY };

export function allCaseIds(): string[] {
  return Object.keys(CASES).sort();
}

export function getCase(id: string): EvalCase {
  const found = CASES[id];
  // WHY name the known ids: a typo'd case id in a test plan is the most likely
  // failure here, and "unknown case: confgi-investigation" without the list
  // sends you reading source to find the right spelling.
  if (!found) throw new Error(`Unknown case "${id}". Known cases: ${allCaseIds().join(', ')}`);
  return found;
}
