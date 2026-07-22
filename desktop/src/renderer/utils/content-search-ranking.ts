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
  // Most matches first (Destin, 2026-07-22) — the file that mentions the query
  // ten times is a better bet than ten files that mention it once. Sort is
  // stable, so equal counts keep first-seen order.
  return [...byPath.values()].sort((a, b) => b.hits.length - a.hits.length);
}

/** Apply the display cap by WHOLE groups after sorting, so the cap never
 * splits a file's matches in half — except the first group, which is always
 * shown and clipped to the budget if it alone exceeds it. */
export function capGroups(groups: HitGroup[], maxRows: number): { groups: HitGroup[]; shownRows: number; capped: boolean } {
  const out: HitGroup[] = [];
  let rows = 0;
  for (const group of groups) {
    if (out.length === 0 && group.hits.length > maxRows) {
      out.push({ path: group.path, hits: group.hits.slice(0, maxRows) });
      rows = maxRows;
      break;
    }
    if (rows + group.hits.length > maxRows) break;
    out.push(group);
    rows += group.hits.length;
  }
  return { groups: out, shownRows: rows, capped: out.length < groups.length || groups.some((g, i) => i === 0 && out[0] && out[0].hits.length < g.hits.length) };
}
