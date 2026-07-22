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

export interface HitGroup {
  path: string;
  hits: RankableHit[];
}

/** Group hits by file, first-seen order (Destin, 2026-07-22: content results
 * grouped per file — "N results in CLAUDE.md" — instead of one flat list).
 * rg usually emits a file's matches contiguously, but its parallel workers can
 * interleave files, so group via a map rather than trusting adjacency. */
export function groupContentHits(hits: RankableHit[]): HitGroup[] {
  const byPath = new Map<string, HitGroup>();
  for (const hit of hits) {
    let group = byPath.get(hit.path);
    if (!group) {
      group = { path: hit.path, hits: [] };
      byPath.set(hit.path, group);
    }
    group.hits.push(hit);
  }
  return [...byPath.values()];
}
