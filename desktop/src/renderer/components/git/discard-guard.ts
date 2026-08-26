// Staleness guard for the SessionDrawer's discard confirm (2026-07-22 bug):
// `onConfirm` awaited git.discard and then set the error banner
// unconditionally — closing and reopening the review while the discard was
// still in flight let the OLD attempt's failure paint a stale banner into the
// reopened view. Same shape as GitReviewView's aliveRef, but a ref COUNTER:
// close+reopen remounts nothing in the host drawer, so a boolean can't tell
// "still open" from "closed and opened again".
//
// `gen` is a monotonic token the host bumps in closeGitReview. A result that
// lands after the token moved belongs to a superseded attempt and is dropped.
export async function runGuardedDiscard(
  discard: () => Promise<{ ok: boolean; error?: string } | undefined> | undefined,
  gen: { current: number },
  setError: (e: string | null) => void,
): Promise<void> {
  const attempt = gen.current;
  let r: { ok: boolean; error?: string } | undefined;
  try {
    r = await discard();
  } catch (e) {
    // Real message passthrough (error-message standard) — never a guessed cause.
    r = { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  if (attempt !== gen.current) return; // review closed since — stale result
  setError(r?.ok ? null : (r?.error ?? 'git discard failed'));
}
