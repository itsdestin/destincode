// Ranking rule for the unified Files search (Destin, 2026-07-22): ONE list,
// no name/contents toggle — filename matches render first (the existing card
// grid), content hits below. A file that already name-matched is dropped from
// the content section: its card is right above, and repeating it as snippet
// rows would read as more results than there are.
export interface RankableHit {
  path: string;   // project-relative, forward slashes
  line: number;
  text: string;
}

export function dedupeContentHits(hits: RankableHit[], nameMatchedPaths: Set<string>): RankableHit[] {
  return hits.filter((h) => !nameMatchedPaths.has(h.path));
}

/** Cap the rendered rows — the IPC already caps at 200 hits, but 200 DOM rows
 * under the grid drowns the cards the ranking says matter more. */
export const MAX_CONTENT_ROWS = 60;
