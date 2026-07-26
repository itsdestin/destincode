// @vitest-environment jsdom
// Pins the reference BUILDER — the pure half of "Ask Claude about this".
// The strings here are the v1 scaffold strings, moved verbatim from
// build-menu.ts's askAboutThis()/scaffold() so the prompt Claude receives
// does not change; only where it lives does.
import { describe, it, expect, afterEach } from 'vitest';
import { buildChatReference, buildCodeReference, buildArtifactReference, truncateLabel } from './build-reference';

function mountBubble(cls: 'assistant-bubble' | 'user-bubble', text: string) {
  const el = document.createElement('div');
  el.className = cls;
  el.textContent = text;
  document.body.appendChild(el);
  return el;
}

function selectWithin(node: Node, start: number, end: number) {
  const range = document.createRange();
  range.setStart(node.firstChild!, start);
  range.setEnd(node.firstChild!, end);
  const sel = window.getSelection()!;
  sel.removeAllRanges();
  sel.addRange(range);
}

afterEach(() => {
  document.body.innerHTML = '';
  window.getSelection()?.removeAllRanges();
});

describe('truncateLabel', () => {
  it('leaves short text alone', () => {
    expect(truncateLabel('alpha bravo')).toBe('alpha bravo');
  });

  it('truncates with an ellipsis at the limit', () => {
    expect(truncateLabel('a'.repeat(80), 10)).toBe('aaaaaaaaaa…');
  });

  it('collapses newlines so the placeholder stays one line', () => {
    expect(truncateLabel('alpha\nbravo')).toBe('alpha bravo');
  });
});

describe('buildChatReference', () => {
  it('quotes an assistant bubble with the assistant lead-in', () => {
    const el = mountBubble('assistant-bubble', 'the reducer preserves Map refs');
    const ref = buildChatReference(el, el)!;
    expect(ref.kind).toBe('chat-text');
    expect(ref.promptText).toBe(
      'In an earlier message, you said:\n"the reducer preserves Map refs"\n\nThe user has a follow-up: ',
    );
    expect(ref.label).toBe('"the reducer preserves Map refs"');
  });

  it('flips the lead-in for the user\'s own bubble', () => {
    const el = mountBubble('user-bubble', 'why does memo work');
    expect(buildChatReference(el, el)!.promptText).toBe(
      'Earlier I wrote:\n"why does memo work"\n\nThe user has a follow-up: ',
    );
  });

  it('stays neutral when the bubble class is unknown', () => {
    const el = document.createElement('div');
    el.textContent = 'floating text';
    document.body.appendChild(el);
    expect(buildChatReference(null, el)!.promptText).toBe(
      'Regarding this:\n"floating text"\n\nThe user has a follow-up: ',
    );
  });

  it('prefers the live selection over the whole bubble', () => {
    const el = mountBubble('assistant-bubble', 'alpha bravo charlie');
    selectWithin(el, 6, 11); // "bravo"
    const ref = buildChatReference(el, el)!;
    expect(ref.promptText).toContain('"bravo"');
    expect(ref.anchor?.range).not.toBeNull();
  });

  it('does not mutate the DOM (no surroundContents split, no host attribute)', () => {
    // This is the whole point of the fix: the old implementation tagged the
    // host with data-reference-host and wrapped the selection in a marker
    // <span> via Range.surroundContents(), which changes outerHTML and (on a
    // real React tree) crashes the next reconcile with
    // `NotFoundError: Failed to execute 'removeChild'`. Byte-identical
    // outerHTML before/after proves the new anchor is DOM-mutation-free.
    const el = mountBubble('assistant-bubble', 'alpha bravo charlie');
    selectWithin(el, 6, 11); // "bravo"
    const before = el.outerHTML;
    const ref = buildChatReference(el, el)!;
    expect(el.outerHTML).toBe(before);
    expect(ref.anchor?.host).toBe(el);
    expect(ref.anchor?.range).not.toBeNull();
  });

  it('returns null when there is nothing to quote', () => {
    const el = mountBubble('assistant-bubble', '   ');
    expect(buildChatReference(el, el)).toBeNull();
  });
});

describe('buildCodeReference', () => {
  it('fences the code block and strips trailing newlines', () => {
    const pre = document.createElement('pre');
    pre.append(document.createTextNode('const x = 1;\n\n'));
    document.body.appendChild(pre);
    Object.defineProperty(pre, 'innerText', { value: 'const x = 1;\n\n', configurable: true });
    const ref = buildCodeReference(pre);
    expect(ref.kind).toBe('chat-code');
    expect(ref.promptText).toBe(
      'Earlier, you shared this code:\n```\nconst x = 1;\n```\n\nThe user has a follow-up: ',
    );
  });

  it('does not mutate the DOM (no surroundContents split, no host attribute)', () => {
    // Same guarantee as buildChatReference's equivalent test, extended to this
    // builder: the old buildCodeReference() also tagged `pre` with
    // data-reference-host unconditionally. buildCodeReference never reads the
    // live selection (it always quotes the whole <pre>), so there's no
    // selection setup needed here — just prove the host is untouched.
    const pre = document.createElement('pre');
    pre.append(document.createTextNode('const x = 1;\n\n'));
    document.body.appendChild(pre);
    Object.defineProperty(pre, 'innerText', { value: 'const x = 1;\n\n', configurable: true });
    const before = pre.outerHTML;
    const ref = buildCodeReference(pre);
    expect(pre.outerHTML).toBe(before);
    expect(ref.anchor?.host).toBe(pre);
  });
});

describe('buildArtifactReference', () => {
  function mountViewer(body: string) {
    const container = document.createElement('div');
    container.setAttribute('data-artifact-viewer', 'true');
    container.setAttribute('data-doc-path', 'docs/notes.txt');
    container.setAttribute('data-artifact-source', 'raw');
    const pre = document.createElement('pre');
    pre.textContent = body;
    container.appendChild(pre);
    document.body.appendChild(container);
    return { container, pre };
  }

  it('cites source lines and labels them for the placeholder', () => {
    const { container, pre } = mountViewer('alpha\nbravo\ncharlie');
    selectWithin(pre, 6, 11); // "bravo" — line 2
    const ref = buildArtifactReference(container)!;
    expect(ref.kind).toBe('artifact');
    expect(ref.promptText).toBe(
      'The user is referencing line 2 from "docs/notes.txt". Respond to the following prompt accordingly:\n\n',
    );
    expect(ref.label).toBe('line 2 of notes.txt');
  });

  it('returns null with no selection — never reference a whole file', () => {
    const { container } = mountViewer('alpha\nbravo');
    expect(buildArtifactReference(container)).toBeNull();
  });

  it('does not mutate the DOM (no surroundContents split, no host attribute)', () => {
    // Same guarantee as buildChatReference's equivalent test, extended to this
    // builder: the old buildArtifactReference() also tagged the container with
    // data-reference-host and wrapped the selection in a marker <span>. A real
    // selection is required here — with no selection the function returns null
    // before it would ever reach the old mutation code path, which would make
    // this assertion pass trivially without proving anything.
    const { container, pre } = mountViewer('alpha\nbravo\ncharlie');
    selectWithin(pre, 6, 11); // "bravo" — line 2
    const before = container.outerHTML;
    const ref = buildArtifactReference(container)!;
    expect(ref).not.toBeNull();
    expect(container.outerHTML).toBe(before);
    expect(ref.anchor?.host).toBe(container);
    expect(ref.anchor?.range).not.toBeNull();
  });
});
