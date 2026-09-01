// src/renderer/dev/workbench/compare/lookup.ts
//
// Resolve one candidate out of the compare registry from a URL's worth of
// strings, for the live review route (?view=live&surface=…&round=…&candidate=…).
//
// WHY the failure case carries `available`: the names come from a review-deck
// spec, which is a JSON file in a DIFFERENT repository (youcoded-dev). Nothing
// can check that join at build time — one side is TypeScript here, the other is
// a file over there — so this is the only place in the world that can say "there
// is no candidate called that, and here is what there is". A pane that just went
// blank would send Destin to ask why the design looks broken.
import { COMPARE_SURFACES } from './registry';
import type { Candidate, CompareSurface, Round } from './types';

export type Lookup =
  | { ok: true; surface: CompareSurface; round: Round; candidate: Candidate }
  | { ok: false; level: 'surface' | 'round' | 'candidate'; asked: string; available: string[] };

/**
 * WHY `round` is required and not an optimisation: candidate ids are unique only
 * WITHIN a round, and the registry keeps every round forever by design (the
 * breadcrumb IS the record of how a design got where it did). Measured on
 * 2026-08-31, `close-prompt-body` has ten rounds and reuses the id `labelled`
 * (rounds 1 and 2) and `one-line` (rounds 3 and 5). Address a candidate without
 * a round and a pane silently shows the wrong design — and the reviewer approves
 * something they never saw, which is worse than an error.
 *
 * (`inline` also appears twice in the registry, but in two different SURFACES —
 * `close-prompt-body` and `bash-grant-width` — which the surface parameter
 * already tells apart. It is not evidence for this rule; don't cite it as such.)
 */
export function findCandidate(
  surfaceId?: string | null,
  round?: string | number | null,
  candidateId?: string | null,
): Lookup {
  const surface = COMPARE_SURFACES.find((s) => s.id === surfaceId);
  if (!surface) {
    return { ok: false, level: 'surface', asked: String(surfaceId ?? ''), available: COMPARE_SURFACES.map((s) => s.id) };
  }
  const n = Number(round);
  const found = Number.isFinite(n) ? surface.rounds.find((r) => r.n === n) : undefined;
  if (!found) {
    return { ok: false, level: 'round', asked: String(round ?? ''), available: surface.rounds.map((r) => String(r.n)) };
  }
  const candidate = found.candidates.find((c) => c.id === candidateId);
  if (!candidate) {
    return { ok: false, level: 'candidate', asked: String(candidateId ?? ''), available: found.candidates.map((c) => c.id) };
  }
  return { ok: true, surface, round: found, candidate };
}
