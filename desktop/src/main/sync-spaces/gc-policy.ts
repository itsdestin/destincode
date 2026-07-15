// desktop/src/main/sync-spaces/gc-policy.ts
// Pure decision logic for the periodic LOCAL git-gc (spec §7 "known limit").
// Extracted so the wrap/threshold behavior is unit-testable without touching
// the filesystem. See GitTransport.maybeGc for the IO shell that uses it.

/**
 * Given the PREVIOUS persisted per-space sync counter, decide the next counter
 * value and whether a local `git gc` should run this sync.
 *
 * - `prev` that is missing/corrupt/negative/non-integer is treated as 0 (a
 *   robust default — a mangled counter file must never wedge sync).
 * - gc fires every Nth sync (when the incremented counter is a multiple of N),
 *   so with N=50 the 50th, 100th, … syncs repack. This is a LOCAL repack only;
 *   it never rewrites history, so it can never desync peers.
 */
export function nextGcCounter(prev: number, n: number): { counter: number; shouldGc: boolean } {
  const base = Number.isInteger(prev) && prev >= 0 ? prev : 0;
  const counter = base + 1;
  // n must be a positive integer; guard so a bad injected interval never
  // divides-by-zero or NaN-compares into "always gc".
  const interval = Number.isInteger(n) && n > 0 ? n : 50;
  return { counter, shouldGc: counter % interval === 0 };
}
