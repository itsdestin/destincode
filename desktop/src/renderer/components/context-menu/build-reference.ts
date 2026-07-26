import { editorViewFor } from '../artifact-views/cm/editor-registry';
import type { PendingReference } from '../../state/reference-context';

// describeArtifactSelection MOVES here from build-menu.ts:205 (with its full
// comment block) — see Task 2 Step 1. Module-private on purpose: exporting it
// would make build-menu.ts and build-reference.ts circular.

// Best-effort: match the selection against the artifact's rendered <pre> text to
// report source line numbers. Only attempted for 'raw' viewers (CodeView, and
// MarkdownView on non-.md files) where the <pre> is a verbatim copy of the file —
// rendered markdown prose doesn't map 1:1 back to source lines, so it always
// falls through to a quote. Line matching is first-occurrence indexOf, so a
// selection that also appears earlier in the file can report the wrong line —
// an acceptable miss for a prompt scaffold the user reviews before sending.
//
// textContent, NOT innerText: innerText is layout-dependent (forces a reflow, and
// its line handling follows *rendered* boxes) — on a `whitespace-pre-wrap` <pre>
// that risks counting soft-wrap breaks as source newlines. textContent walks the
// highlight.js spans and yields the file's exact characters. It's also the only
// one jsdom implements, so this stays unit-testable.
function describeArtifactSelection(sel: string, container: HTMLElement): string {
  const source = container.getAttribute('data-artifact-source');
  // CodeMirror viewers NEVER use the textContent path below: CM6 virtualizes,
  // so only viewport lines exist in the DOM and an indexOf count reports a
  // plausible WRONG line (a selection at line 800 cites "line 41") straight
  // into a prompt scaffold (spec §5.3). state.doc.lineAt() is
  // virtualization-immune; the live view comes from the editor registry.
  if (source === 'cm6') {
    const view = editorViewFor(container);
    const range = view?.state.selection.main;
    if (view && range && !range.empty) {
      const startLine = view.state.doc.lineAt(range.from).number;
      const endLine = view.state.doc.lineAt(range.to).number;
      return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
    }
    return `"${sel}"`;
  }
  const pre = source === 'raw' ? container.querySelector('pre') : null;
  const full = pre?.textContent ?? '';
  const idx = pre ? full.indexOf(sel) : -1;
  if (idx !== -1) {
    const startLine = (full.slice(0, idx).match(/\n/g) || []).length + 1;
    const endLine = startLine + (sel.match(/\n/g) || []).length;
    return startLine === endLine ? `line ${startLine}` : `lines ${startLine}-${endLine}`;
  }
  return `"${sel}"`;
}

/**
 * Builds the "Ask Claude about this" reference (spec 2026-07-26).
 *
 * This is v1's askAboutThis()/scaffold() INVERTED: the same prompt strings, but
 * RETURNED AS DATA instead of dispatched at the composer as text. Keeping it pure
 * is what makes it testable — and keeps build-menu.ts a pure DOM-inspection module.
 */

/** Marks the element a reference came from, so the overlay can re-find it. */
const HOST_ATTR = 'data-reference-host';
const RUN_ATTR = 'data-reference-run';
let hostSeq = 0;

function tagHost(el: Element): string {
  const id = String(++hostSeq);
  el.setAttribute(HOST_ATTR, id);
  return `[${HOST_ATTR}="${id}"]`;
}

/**
 * Wraps the current selection in marker spans so the overlay can re-measure it
 * later. getClientRects() on these spans returns ONE RECT PER LINE BOX — the
 * same shape Range.getClientRects() gives — which is what the union outline
 * (Task 5) traces. Returns null when the selection can't be wrapped (it crosses
 * element boundaries, which surroundContents rejects).
 */
function tagSelectionRuns(hostId: string): string | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  try {
    const span = document.createElement('span');
    span.setAttribute(RUN_ATTR, hostId);
    sel.getRangeAt(0).surroundContents(span);
    return `[${RUN_ATTR}="${hostId}"]`;
  } catch {
    // Selection spans multiple elements — fall back to a whole-element outline.
    return null;
  }
}

/** One-line, bounded placeholder copy. Newlines collapse so it can't wrap. */
export function truncateLabel(text: string, max = 42): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max) + '…';
}

function scaffold(lead: string, body: string, fenced: boolean): string {
  const quoted = fenced ? '```\n' + body + '\n```' : `"${body}"`;
  return `${lead}\n${quoted}\n\nThe user has a follow-up: `;
}

function selectionText(): string {
  return window.getSelection()?.toString() ?? '';
}

function baseName(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() || p;
}

export function buildChatReference(bubble: Element | null, target: HTMLElement): PendingReference | null {
  // Fix vs. the original textMenu(): fall back to TARGET's text, not just bubble's,
  // when there's no bubble ancestor — otherwise a floating (non-bubble) text node
  // with no live selection always produced an empty quote and a silent null return.
  const quote = (selectionText().trim() || (bubble ?? target).textContent?.trim()) ?? '';
  if (!quote) return null;

  // "you said" reads right for an assistant message; flip it for the user's own
  // bubble, and stay neutral if we can't tell. (Moved verbatim from build-menu.ts.)
  const lead = bubble?.classList.contains('assistant-bubble')
    ? 'In an earlier message, you said:'
    : bubble?.classList.contains('user-bubble')
      ? 'Earlier I wrote:'
      : 'Regarding this:';

  const host = (bubble ?? target) as Element;
  const hostSelector = tagHost(host);
  const hostId = host.getAttribute(HOST_ATTR)!;
  const runSelector = selectionText().trim() ? tagSelectionRuns(hostId) : null;

  return {
    kind: 'chat-text',
    label: `"${truncateLabel(quote)}"`,
    promptText: scaffold(lead, quote, false),
    anchor: { hostSelector, runSelector },
  };
}

export function buildCodeReference(pre: HTMLElement): PendingReference {
  const code = pre.innerText.replace(/\n+$/, '');
  return {
    kind: 'chat-code',
    label: truncateLabel(code),
    promptText: scaffold('Earlier, you shared this code:', code, true),
    anchor: { hostSelector: tagHost(pre), runSelector: null },
  };
}

export function buildArtifactReference(container: HTMLElement): PendingReference | null {
  // data-doc-path, not data-artifact-path: the latter stays reserved for the
  // deferred image sub-menu's absolute path on <img> elements.
  const path = container.getAttribute('data-doc-path') || '';
  const sel = selectionText().trim();
  // No selection → no reference. Falling back to the whole file would paste an
  // entire document (deliberate, carried over from v1).
  if (!sel || !path) return null;

  const ref = describeArtifactSelection(sel, container);
  const hostSelector = tagHost(container);
  const hostId = container.getAttribute(HOST_ATTR)!;

  return {
    kind: 'artifact',
    // `ref` is either "line 2" / "lines 2-4" or a quoted excerpt; only the
    // line form reads well with "of <file>".
    label: ref.startsWith('line') ? `${ref} of ${baseName(path)}` : truncateLabel(ref),
    promptText: `The user is referencing ${ref} from "${path}". Respond to the following prompt accordingly:\n\n`,
    anchor: { hostSelector, runSelector: tagSelectionRuns(hostId) },
  };
}
