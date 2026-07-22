// @vitest-environment jsdom
// Pins the artifact-viewer branch of the right-click menu: the "Ask about this"
// scaffold must cite SOURCE LINE NUMBERS for raw text/code views and fall back to
// a quote for rendered markdown (whose DOM doesn't map back to source lines).
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildContextMenu } from './build-menu';

// Builds the DOM shape MarkdownView emits for raw text (txt) and rendered md.
// CODE files no longer use this shape — CodeMirror replaced CodeView, and its
// contract is pinned by build-menu-cm6.test.tsx, which mounts the REAL
// component (a synthetic shape here would stay green while production broke).
function mountViewer(opts: { path: string; source: 'raw' | 'rendered'; body: string }) {
  const container = document.createElement('div');
  container.setAttribute('data-artifact-viewer', 'true');
  container.setAttribute('data-doc-path', opts.path);
  container.setAttribute('data-artifact-source', opts.source);
  const pre = document.createElement('pre');
  pre.textContent = opts.body;
  container.appendChild(pre);
  document.body.appendChild(container);
  return { container, pre };
}

// The menu reads window.getSelection(), so drive the real selection API.
function selectWithin(node: Node, start: number, end: number) {
  const range = document.createRange();
  const textNode = node.firstChild!;
  range.setStart(textNode, start);
  range.setEnd(textNode, end);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

// Runs the menu's "Ask about this" action and returns the text it would insert
// into the composer (delivered via the youcoded:compose-insert CustomEvent).
function composedTextFor(container: HTMLElement): string | null {
  const entries = buildContextMenu(container);
  const ask = entries?.find((e) => e.type === 'item' && e.id === 'ask');
  if (!ask || ask.type !== 'item') return null;
  const spy = vi.fn();
  window.addEventListener('youcoded:compose-insert', spy);
  ask.run();
  window.removeEventListener('youcoded:compose-insert', spy);
  return (spy.mock.calls[0]?.[0] as CustomEvent)?.detail?.text ?? null;
}

const FILE = 'alpha\nbravo\ncharlie\ndelta';

afterEach(() => {
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
});

describe('artifact viewer context menu', () => {
  it('cites a single source line for a one-line selection', () => {
    const { container, pre } = mountViewer({ path: 'docs/notes.txt', source: 'raw', body: FILE });
    selectWithin(pre, 6, 11); // "bravo" — second line
    expect(composedTextFor(container)).toBe(
      'The user is referencing line 2 from "docs/notes.txt". Respond to the following prompt accordingly:\n\n',
    );
  });

  it('cites a line RANGE for a multi-line selection', () => {
    const { container, pre } = mountViewer({ path: 'src/app.ts', source: 'raw', body: FILE });
    selectWithin(pre, 6, 19); // "bravo\ncharlie" — lines 2-3
    expect(composedTextFor(container)).toBe(
      'The user is referencing lines 2-3 from "src/app.ts". Respond to the following prompt accordingly:\n\n',
    );
  });

  it('falls back to a quote for rendered markdown (no reliable source mapping)', () => {
    const { container, pre } = mountViewer({ path: 'README.md', source: 'rendered', body: FILE });
    selectWithin(pre, 6, 11);
    expect(composedTextFor(container)).toBe(
      'The user is referencing "bravo" from "README.md". Respond to the following prompt accordingly:\n\n',
    );
  });

  it('offers no "Ask about this" without a selection — the whole file is never implied', () => {
    const { container } = mountViewer({ path: 'docs/notes.txt', source: 'raw', body: FILE });
    const entries = buildContextMenu(container);
    expect(entries?.some((e) => e.type === 'item' && e.id === 'ask')).toBe(false);
  });

  it('leaves non-artifact, non-chat surfaces alone (no menu hijack)', () => {
    const stray = document.createElement('div');
    document.body.appendChild(stray);
    expect(buildContextMenu(stray)).toBeNull();
  });

  it('gives the artifact edit textarea a cut/copy/paste menu', () => {
    const ta = document.createElement('textarea');
    ta.className = 'artifact-edit-textarea';
    ta.value = 'draft text';
    document.body.appendChild(ta);
    const ids = buildContextMenu(ta)?.filter((e) => e.type === 'item').map((e: any) => e.id);
    expect(ids).toEqual(['cut', 'copy', 'paste', 'select-all']);
  });
});
