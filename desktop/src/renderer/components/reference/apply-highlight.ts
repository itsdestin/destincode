/**
 * Applies the `.reference-mark` highlight to a DETACHED clone, at the
 * character-offset span `build-reference.ts` computed against the live
 * source (dev-review fix B: "it doesn't show that I was asking about a
 * specific selection").
 *
 * Mutating `root` here is SAFE and a different class of change than the
 * DOM-mutation the reference path otherwise forbids: `root` is a
 * `cloneNode(true)` copy, detached from the document and never seen by
 * React, so splitting its text nodes touches nothing React's reconciler
 * tracks. Contrast the withdrawn `Range.surroundContents()` design, which
 * split text nodes INSIDE the live, React-managed source and crashed the
 * next reconcile with `NotFoundError: removeChild` — see the WHY comment on
 * `captureRange` in build-reference.ts.
 */
export function applyHighlightMark(root: Element, start: number, end: number): void {
  if (!(end > start)) return; // empty/inverted span — nothing to highlight

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  // Collect the covered runs FIRST, then mutate — mutating mid-walk (splitText
  // creates a new sibling Text node) would confuse the TreeWalker's notion of
  // "next node" and risks visiting a just-created fragment a second time.
  const runs: { node: Text; from: number; to: number }[] = [];
  let offset = 0;
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    const len = text.data.length;
    const nodeStart = offset;
    const nodeEnd = offset + len;
    const from = Math.max(start, nodeStart);
    const to = Math.min(end, nodeEnd);
    if (from < to) runs.push({ node: text, from: from - nodeStart, to: to - nodeStart });
    offset += len;
  }
  if (runs.length === 0) return; // offsets didn't land on anything real — skip, don't throw

  // Wrap each run independently — a span crossing multiple text nodes (e.g. a
  // selection that straddles two <span> tokens from syntax highlighting)
  // gets one <mark> per covered node, not one mark spanning across element
  // boundaries (which isn't representable as a single DOM wrap anyway).
  for (const run of runs) {
    let target = run.node;
    // Peel off the UNcovered prefix into its own text node, so `target` starts
    // exactly at the covered run.
    if (run.from > 0) target = target.splitText(run.from);
    const runLength = run.to - run.from;
    // Peel off the uncovered suffix, if any remains after the split above.
    if (runLength < target.data.length) target.splitText(runLength);

    const mark = document.createElement('mark');
    mark.className = 'reference-mark';
    target.parentNode?.replaceChild(mark, target);
    mark.appendChild(target);
  }
}
