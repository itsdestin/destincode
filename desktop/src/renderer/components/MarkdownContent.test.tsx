// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import MarkdownContent from './MarkdownContent';

afterEach(cleanup);

// The regression this pins: the Copy button used to be derived from
// `child.props.children` and only accepted a STRING. rehype-highlight replaces
// the code element's text node with a <span> tree as soon as highlight.js
// recognises ANY token, so the button silently disappeared on exactly the
// blocks worth copying — and survived only on blocks the highlighter failed to
// tokenise. The failure is invisible (a missing button looks like a design
// choice), and `bash` flips between the two states depending on whether the
// snippet happens to contain a comment, so a single sample proves nothing.
// Every variant below must behave identically.
const FENCES: { name: string; md: string; code: string }[] = [
  {
    name: 'no language (highlighter emits no tokens)',
    md: '```\nhello world\n```',
    code: 'hello world\n',
  },
  {
    name: 'bash with nothing colourable',
    md: '```bash\nnpm run build\n```',
    code: 'npm run build\n',
  },
  {
    // The load-bearing case: identical to the one above but for a comment
    // line, which is all it took for highlight.js to tokenise and the button
    // to vanish.
    name: 'bash with a comment',
    md: '```bash\n# install first\nnpm run build\n```',
    code: '# install first\nnpm run build\n',
  },
  { name: 'json', md: '```json\n{"a": 1}\n```', code: '{"a": 1}\n' },
  { name: 'python', md: '```python\ndef f(): return 1\n```', code: 'def f(): return 1\n' },
  { name: 'markdown', md: '```markdown\n# Title\n```', code: '# Title\n' },
  {
    name: 'unknown language',
    md: '```foolang\nabc\n```',
    code: 'abc\n',
  },
];

describe('MarkdownContent fenced code blocks', () => {
  for (const f of FENCES) {
    it(`renders a Copy button for ${f.name}`, () => {
      render(<MarkdownContent content={f.md} />);
      expect(screen.getByRole('button', { name: /copy/i })).toBeInTheDocument();
    });

    it(`copies the full source text for ${f.name}`, async () => {
      const writes: string[] = [];
      Object.assign(navigator, {
        clipboard: { writeText: (t: string) => { writes.push(t); return Promise.resolve(); } },
      });
      const { getByRole } = render(<MarkdownContent content={f.md} />);
      getByRole('button', { name: /copy/i }).click();
      // Must be the raw source, not the highlighted markup — the whole point of
      // reading the hast node instead of the rendered children.
      expect(writes).toEqual([f.code]);
    });

    it(`styles ${f.name} as a block, not inline code`, () => {
      const { container } = render(<MarkdownContent content={f.md} />);
      const code = container.querySelector('pre code');
      expect(code).not.toBeNull();
      // text-code is the INLINE styling. A fenced block must never carry it —
      // an unlanguaged fence used to, because "no className" was read as
      // "inline" and an unlanguaged fence gets no class from the highlighter.
      expect(code!.className).not.toContain('text-code');
    });

    it(`keeps the yc-code hook on the <pre> for ${f.name}`, () => {
      const { container } = render(<MarkdownContent content={f.md} />);
      // globals.css out-specifies highlight.js's own `pre code.hljs` box via
      // `pre.yc-code code.hljs`. Drop the class and the double-rectangle
      // regression returns, with nothing else to catch it.
      expect(container.querySelector('pre.yc-code')).not.toBeNull();
    });
  }

  it('leaves inline code as inline', () => {
    const { container } = render(<MarkdownContent content={'some `inline` code'} />);
    expect(container.querySelector('pre')).toBeNull();
    expect(container.querySelector('code')!.className).toContain('text-code');
  });

  it('copies only the block that was clicked when several are present', () => {
    const writes: string[] = [];
    Object.assign(navigator, {
      clipboard: { writeText: (t: string) => { writes.push(t); return Promise.resolve(); } },
    });
    render(<MarkdownContent content={'```json\n{"a": 1}\n```\n\ntext\n\n```python\ndef f(): pass\n```'} />);
    const buttons = screen.getAllByRole('button', { name: /copy/i });
    expect(buttons).toHaveLength(2);
    buttons[1].click();
    expect(writes).toEqual(['def f(): pass\n']);
  });
});
