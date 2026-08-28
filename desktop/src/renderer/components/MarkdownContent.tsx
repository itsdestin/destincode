import React, { useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import remarkGfm from 'remark-gfm';
import type { Plugin } from 'unified';
import type { Root, Element, Text, RootContent } from 'hast';
import { visitParents } from 'unist-util-visit-parents';
import { detectFilepaths } from '../hooks/useInlineFilepathDetector';
import { Button } from './ui';
import { FilepathToken } from './FilepathToken';
import { CONVERSATIONS_FENCE, parseConversationRefs } from '../../shared/chatsearch-refs';
import ChatsearchRefBlock from './tool-views/ChatsearchRefBlock';
import { SessionRefsEnabled } from './session-refs-context';

/**
 * Rehype plugin: tag every <code> that lives inside a <pre> with data-block.
 *
 * Fix: `code()` used to infer "inline" from the ABSENCE of a className, but a
 * fenced block with no language (```\n…) gets no class from rehype-highlight
 * either — so it was rendered with the inline-code styling while every
 * languaged block got hljs styling. Two visibly different code blocks for the
 * same markdown construct. The parent chain is the only reliable signal;
 * react-markdown v10 dropped the `inline` prop it used to pass.
 */
const rehypeMarkBlockCode: Plugin<[], Root> = () => (tree: Root) => {
  visitParents(tree, 'element', (node, ancestors) => {
    const el = node as Element;
    if (el.tagName !== 'code') return;
    const inPre = ancestors.some(
      (a) => a.type === 'element' && (a as Element).tagName === 'pre',
    );
    if (inPre) el.properties = { ...el.properties, 'data-block': 'true' };
  });
};

// Stable plugin arrays — avoids re-creating on every render when sessionId
// is absent (non-artifact contexts). When filepath detection is active,
// the rehype plugin array is memoized per-sessionId in the component below.
const remarkPluginsStable = [remarkGfm];
const rehypePluginsStable = [rehypeHighlight, rehypeMarkBlockCode];

/**
 * Collect the raw text of a hast subtree.
 *
 * Fix: the Copy button used to read `child.props.children` and only accepted a
 * STRING, but rehype-highlight replaces the code element's single text node
 * with a tree of <span>s the moment highlight.js recognises any token — so the
 * button silently vanished on exactly the blocks worth copying (```json,
 * ```python, any bash with a comment) and survived only on blocks the
 * highlighter failed to tokenise. Reading the hast node instead is immune to
 * whatever the highlighter did to the element tree.
 */
function hastText(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const n = node as { type?: string; value?: string; children?: unknown[] };
  if (n.type === 'text') return n.value ?? '';
  if (Array.isArray(n.children)) return n.children.map(hastText).join('');
  return '';
}

/**
 * Rehype plugin: walks hast text nodes that are NOT inside <code> or <pre>
 * elements and splits detected file paths into filepath-token elements.
 *
 * Filepath detection runs in the hast (HTML AST) pass — after the markdown is
 * already parsed — so we get correct element context (inline code vs. block code)
 * for free by checking the ancestor chain. No regex pre-processing of the source.
 */
const rehypeFilepathTokens: Plugin<[], Root> = () => (tree: Root) => {
  // visitParents provides the full ancestor chain so we can correctly detect
  // whether the text node is inside a <code> or <pre> element.
  visitParents(tree, 'text', (node, ancestors) => {
    const parent = ancestors[ancestors.length - 1];
    if (!parent) return;
    const index = (parent as Element | Root).children.indexOf(node as Text);
    if (index === -1) return;

    // Fix: skip ONLY when inside a <pre> element (fenced code block).
    // Inline <code> spans are intentionally NOT excluded — Claude commonly formats
    // file paths as backtick-wrapped inline code (e.g. `foo.md`) and users expect
    // those to be clickable. Multi-line fenced blocks still get no detection because
    // the <pre> ancestor check correctly catches them.
    const inPreBlock = ancestors.some(
      (a) => a.type === 'element' && (a as Element).tagName === 'pre',
    );
    if (inPreBlock) return;

    const textNode = node as Text;
    const matches = detectFilepaths(textNode.value);
    if (matches.length === 0) return;

    // Split the text node into a sequence of text + filepath-token elements.
    const replacements: RootContent[] = [];
    let cursor = 0;
    for (const m of matches) {
      if (m.start > cursor) {
        replacements.push({ type: 'text', value: textNode.value.slice(cursor, m.start) });
      }
      replacements.push({
        type: 'element',
        tagName: 'filepath-token',
        properties: { 'data-path': m.path },
        children: [],
      } as Element);
      cursor = m.end;
    }
    if (cursor < textNode.value.length) {
      replacements.push({ type: 'text', value: textNode.value.slice(cursor) });
    }

    // Replace the original text node with our sequence in the parent's children array.
    (parent as Element | Root).children.splice(index as number, 1, ...replacements);
    // Skip past the newly-inserted nodes — they're already processed.
    return index + replacements.length;
  });
};

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Button
      // ghost, not secondary (spec §11 decision 74): this floats over a code
      // block, and a bordered button would draw a visible box on top of the code.
      variant="ghost"
      size="sm"
      onClick={handleCopy}
      // Floating overlay control in the code block's corner, so opacity-0 at rest
      // is correct and stays (spec decision 74). focus-visible:opacity-100 is new:
      // at opacity-0 the button was invisible to keyboard users who tabbed to it.
      className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
    >
      {copied ? 'Copied!' : 'Copy'}
    </Button>
  );
}

// Stable component overrides — defined at module scope so ReactMarkdown
// receives the same object reference on every render, preventing unnecessary
// reconciliation of the entire markdown tree.
const mdComponents = {
  h1({ children, ...props }: any) {
    return <h1 className="text-xl font-bold mt-6 mb-3 pb-1.5 text-fg border-b border-edge" {...props}>{children}</h1>;
  },
  h2({ children, ...props }: any) {
    return <h2 className="text-lg font-bold mt-6 mb-3 pb-1 text-fg border-b border-edge" {...props}>{children}</h2>;
  },
  h3({ children, ...props }: any) {
    return <h3 className="text-base font-bold mt-5 mb-2 text-fg" {...props}>{children}</h3>;
  },
  h4({ children, ...props }: any) {
    return <h4 className="text-sm font-bold mt-4 mb-1.5 text-fg" {...props}>{children}</h4>;
  },
  p({ children, ...props }: any) {
    return <p className="mb-3 last:mb-0 leading-relaxed" {...props}>{children}</p>;
  },
  ol({ children, ...props }: any) {
    return <ol className="list-decimal pl-6 mb-3 space-y-1.5" {...props}>{children}</ol>;
  },
  ul({ children, ...props }: any) {
    return <ul className="list-disc pl-6 mb-3 space-y-1.5" {...props}>{children}</ul>;
  },
  li({ children, ...props }: any) {
    return <li className="leading-relaxed" {...props}>{children}</li>;
  },
  hr({ ...props }: any) {
    return <hr className="border-edge my-5" {...props} />;
  },
  blockquote({ children, ...props }: any) {
    return (
      <blockquote className="border-l-2 border-edge pl-3 my-3 text-fg-dim italic" {...props}>
        {children}
      </blockquote>
    );
  },
  strong({ children, ...props }: any) {
    return <strong className="font-bold text-fg" {...props}>{children}</strong>;
  },
  em({ children, ...props }: any) {
    return <em className="italic text-fg-2" {...props}>{children}</em>;
  },
  pre({ children, node, ...props }: any) {
    // Text comes from the source AST, not the rendered children — see hastText.
    const codeText = hastText(node);
    // A `conversations` fence is not code: it is the assistant naming past
    // conversations inside its own message, and the renderer draws them as a
    // reference block (compare Round 8 A). Gated on the context so this only
    // happens in a live assistant bubble — a PAST conversation being previewed
    // could contain the same fence, and resolving ids from another device
    // inside a read-only transcript would render a block of dead rows.
    if (isConversationsFence(node)) {
      return <ConversationsFence body={codeText} />;
    }
    return (
      <div className="relative group my-3">
        {/* yc-code is the hook the globals.css rule needs to out-specify
            highlight.js's own `pre code.hljs` box (see the .yc-code block
            there). Don't drop it. */}
        <pre className="yc-code rounded-md bg-canvas border border-edge p-3 overflow-x-auto text-sm text-fg" {...props}>
          {children}
        </pre>
        {codeText && <CopyButton text={codeText} />}
      </div>
    );
  },
  code({ className, children, node, ...props }: any) {
    // Block vs inline comes from the parent chain (rehypeMarkBlockCode), NOT
    // from "has a className" — an unlanguaged fence has neither.
    const isBlock = props['data-block'] !== undefined;
    if (!isBlock) {
      return (
        <code className="text-sm text-code" {...props}>
          {children}
        </code>
      );
    }
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  },
  a({ href, children, ...props }: any) {
    const isSafeHref = href && /^(https?:|mailto:)/.test(href);
    if (!isSafeHref) {
      return <span className="text-link">{children}</span>;
    }
    return (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        className="text-link hover:text-link-hover underline"
        {...props}
      >
        {children}
      </a>
    );
  },
  table({ children, ...props }: any) {
    return (
      <div className="overflow-x-auto my-3">
        <table className="border-collapse border border-edge text-sm w-full" {...props}>
          {children}
        </table>
      </div>
    );
  },
  th({ children, ...props }: any) {
    return (
      <th className="border border-edge px-3 py-2 bg-panel text-left font-bold text-fg" {...props}>
        {children}
      </th>
    );
  },
  td({ children, ...props }: any) {
    return (
      <td className="border border-edge px-3 py-2" {...props}>
        {children}
      </td>
    );
  },
};

/** Does this <pre> hold a fenced block whose language is `conversations`? */
function isConversationsFence(node: any): boolean {
  const code = node?.children?.find((c: any) => c?.tagName === 'code');
  const classes = code?.properties?.className;
  const list = Array.isArray(classes) ? classes : typeof classes === 'string' ? classes.split(/\s+/) : [];
  return list.includes(`language-${CONVERSATIONS_FENCE}`);
}

function ConversationsFence({ body }: { body: string }) {
  const enabled = React.useContext(SessionRefsEnabled);
  const ids = React.useMemo(() => parseConversationRefs(body), [body]);
  // Not enabled here: fall back to what the text says on its own, rather than
  // silently swallowing the block.
  if (!enabled) return <pre className="yc-code rounded-md bg-canvas border border-edge p-3 overflow-x-auto text-sm text-fg">{body}</pre>;
  return <ChatsearchRefBlock shortIds={ids} />;
}
// Preview mode: the same renderer with NOTHING interactive in it. WHY: a file tile is itself a
// <button> (FilesTab, Deliverables), and the code-block Copy button / links inside a rendered
// markdown preview made a <button> inside a <button> — invalid HTML, a React error on every
// Projects screen (found by the 2026-08-27 sweep). Code blocks keep their look, links read as text.
const mdPreviewComponents = {
  ...mdComponents,
  pre({ children, node: _node, ...props }: any) {
    return (
      <pre className="yc-code rounded-md bg-canvas border border-edge p-3 overflow-x-auto text-sm text-fg my-3" {...props}>
        {children}
      </pre>
    );
  },
  a({ href: _href, children, ...props }: any) {
    return <span className="text-link underline" {...props}>{children}</span>;
  },
};

interface Props {
  content: string;
  /** When provided, file paths detected in text are rendered as FilepathToken chips. */
  sessionId?: string;
  /** Decorative rendering for tiles: no Copy buttons, no links — nothing focusable or clickable. */
  preview?: boolean;
}

export default React.memo(function MarkdownContent({ content, sessionId, preview }: Props) {
  // Memoize the rehype plugin array and the component map by sessionId so that:
  // (a) When sessionId is absent, we use the stable module-scope arrays (no allocation).
  // (b) When sessionId is present, the filepath-token component is added once and
  //     remains stable across re-renders for the same session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const rehypePlugins = useMemo(
    () => sessionId ? [rehypeHighlight, rehypeMarkBlockCode, rehypeFilepathTokens] : rehypePluginsStable,
    // Intentionally omitting rehypeFilepathTokens from deps — it's stable (module-level function).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sessionId],
  );

  const components = useMemo(() => {
    if (preview) return mdPreviewComponents;
    if (!sessionId) return mdComponents;
    // Extend the base component map with a handler for our custom <filepath-token> hast element.
    // react-markdown lowercases custom element names, so 'filepath-token' matches the tagName.
    return {
      ...mdComponents,
      // react-markdown v10 passes custom hast element props directly.
      // 'data-path' becomes 'data-path' in props (React preserves data-* attrs).
      'filepath-token': ({ node, ...props }: any) => {
        const path: string = (node as Element)?.properties?.['data-path'] as string ?? props['data-path'] ?? '';
        if (!path) return null;
        return <FilepathToken path={path} sessionId={sessionId} />;
      },
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, preview]);

  return (
    <ReactMarkdown
      remarkPlugins={remarkPluginsStable}
      rehypePlugins={rehypePlugins}
      components={components}
    >
      {content}
    </ReactMarkdown>
  );
});
