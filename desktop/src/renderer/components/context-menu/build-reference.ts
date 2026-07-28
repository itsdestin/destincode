import { editorViewFor } from '../artifact-views/cm/editor-registry';
import type { PendingReference } from '../../state/reference-context';
import {
  LEAD_ASSISTANT,
  LEAD_USER,
  LEAD_NEUTRAL,
  LEAD_CODE,
  buildScaffold,
  buildArtifactScaffold,
} from './reference-prompt';

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

// WHY no DOM tagging here: the original design re-found the host/selection via
// a `data-reference-host` attribute plus a marker `<span>` wrapped around the
// selection with Range.surroundContents(). Chat bubbles (UserMessage.tsx,
// AssistantTurnBubble.tsx) render their text as plain React-managed JSX, so
// splitting that text node out from under React left its fiber pointing at a
// node that no longer existed in the expected shape — the next reconcile threw
// `NotFoundError: Failed to execute 'removeChild'` and crashed the chat view.
// Holding the live host Element and a cloned Range instead needs no mutation.
function captureRange(): Range | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  // cloneRange: the live selection is cleared the moment focus moves to the
  // composer, which would empty a borrowed reference out from under us.
  return sel.getRangeAt(0).cloneRange();
}

/** One-line, bounded placeholder copy. Newlines collapse so it can't wrap. */
export function truncateLabel(text: string, max = 42): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : flat.slice(0, max) + '…';
}

function selectionText(): string {
  return window.getSelection()?.toString() ?? '';
}

function baseName(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() || p;
}

/**
 * The quotable text of a bubble, EXCLUDING its chrome.
 *
 * `.bubble-timestamp` renders INSIDE the bubble div (UserMessage.tsx:75,
 * AssistantTurnBubble.tsx:437), so a plain `textContent` sweeps it into the
 * quote — Destin's dev review caught a scaffold reading
 * `...ready to use or delete as needed.12:55 AM"`. Clone the node, strip the
 * chrome, then read. Cloning matters: the reference path must never mutate
 * the live DOM (an earlier design did, and crashed React's reconciler).
 */
function elementQuote(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll('.bubble-timestamp').forEach((n) => n.remove());
  return copy.textContent?.trim() ?? '';
}

export function buildChatReference(bubble: Element | null, target: HTMLElement): PendingReference | null {
  // Fix vs. the original textMenu(): fall back to TARGET's text, not just bubble's,
  // when there's no bubble ancestor — otherwise a floating (non-bubble) text node
  // with no live selection always produced an empty quote and a silent null return.
  const quote = (selectionText().trim() || elementQuote(bubble ?? target)) ?? '';
  if (!quote) return null;

  // "you said" reads right for an assistant message; flip it for the user's own
  // bubble, and stay neutral if we can't tell. (Moved verbatim from build-menu.ts.)
  const lead = bubble?.classList.contains('assistant-bubble')
    ? LEAD_ASSISTANT
    : bubble?.classList.contains('user-bubble')
      ? LEAD_USER
      : LEAD_NEUTRAL;

  const host = (bubble ?? target) as Element;
  const range = selectionText().trim() ? captureRange() : null;

  return {
    kind: 'chat-text',
    label: `"${truncateLabel(quote)}"`,
    promptText: buildScaffold(lead, quote, false),
    anchor: { host, range },
  };
}

export function buildCodeReference(pre: HTMLElement): PendingReference {
  const code = pre.innerText.replace(/\n+$/, '');
  return {
    kind: 'chat-code',
    label: truncateLabel(code),
    promptText: buildScaffold(LEAD_CODE, code, true),
    anchor: { host: pre, range: null },
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

  return {
    kind: 'artifact',
    // `ref` is either "line 2" / "lines 2-4" or a quoted excerpt; only the
    // line form reads well with "of <file>".
    label: ref.startsWith('line') ? `${ref} of ${baseName(path)}` : truncateLabel(ref),
    promptText: buildArtifactScaffold(ref, path),
    anchor: { host: container, range: captureRange() },
  };
}
