// Dev-only page: renders every fixture through the real ToolCard/ToolBody so
// we can iterate on compact views with Vite HMR. Gated behind a query-param
// in App.tsx in dev builds — must not be reachable in prod builds.
//
// Why ChatProvider: ToolCard internally calls useChatDispatch() for click
// handlers (expand/collapse, approval), so it crashes outside the provider
// even though the fixtures don't actually drive the store's session state.

import React from 'react';
import { ChatProvider } from '../state/chat-context';
import ToolCard from '../components/ToolCard';
import { loadFixture, type FixtureBlock } from './fixture-loader';

// Vite's import.meta.glob eagerly reads every fixture as a raw string at build
// time. We silence tsc because our tsconfig uses `module: "commonjs"` which
// rejects the `import.meta` syntax (TS1343) — Vite still rewrites this call
// statically during bundling, so the literal syntax must be preserved. Only
// Vite ever bundles this file; the Electron main process never loads it.
// @ts-ignore TS1343 — import.meta is intercepted by Vite at build time
const fixtures = import.meta.glob('./fixtures/*.jsonl', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// Renders a single block — text as prose, tool as a real <ToolCard>.
function renderBlock(block: FixtureBlock, index: number): React.ReactNode {
  if (block.kind === 'text') {
    return (
      <p key={`text-${index}`} style={{ margin: '8px 0', lineHeight: 1.5, opacity: 0.9 }}>
        {block.text}
      </p>
    );
  }
  return <ToolCard key={block.tool.toolUseId} tool={block.tool} />;
}

export function ToolSandbox() {
  const entries = Object.entries(fixtures)
    .map(([path, raw]) => {
      const name = path.split('/').pop()!.replace(/\.jsonl$/, '');
      return { name, result: loadFixture(name, raw) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <ChatProvider>
      {/* App root CSS pins html/body to 100vh + overflow:hidden so chat/terminal
          panes can manage their own scroll. Sandbox is a normal document, so
          we opt the scroll back in on this outer container. */}
      <div style={{ height: '100vh', overflowY: 'auto' }}>
      <div style={{ padding: 24, maxWidth: 960, margin: '0 auto' }}>
        <h1 style={{ fontSize: 20, marginBottom: 16 }}>ToolCard Sandbox</h1>
        <p style={{ opacity: 0.7, marginBottom: 24, fontSize: 13 }}>
          Dev-only. Each card renders a real &lt;ToolCard&gt; against a fixture
          tool_use/tool_result pair. Edit ToolBody.tsx and save to see changes
          via HMR.
        </p>
        {entries.map(({ name, result }) => {
          // Multi-block fixtures (or any fixture with text) get a bubble frame
          // so the grouping reads as "one assistant turn". Single-tool fixtures
          // render bare — matches the original sandbox look.
          const hasText = result.blocks.some((b) => b.kind === 'text');
          const wrap = result.blocks.length > 1 || hasText;
          return (
            <section key={name} style={{ marginBottom: 32 }}>
              <h2 style={{ fontSize: 14, opacity: 0.6, marginBottom: 8 }}>{name}</h2>
              {result.error ? (
                <div style={{ color: 'tomato', fontFamily: 'monospace' }}>
                  {result.error}
                </div>
              ) : wrap ? (
                // Light outline + padding so the grouping reads visually.
                // Intentionally minimal; the point is "this is all one turn", not theming.
                <div
                  style={{
                    border: '1px solid var(--edge-dim, #333)',
                    borderRadius: 8,
                    padding: 16,
                    margin: '8px 0',
                  }}
                >
                  {result.blocks.map(renderBlock)}
                </div>
              ) : (
                result.blocks.map(renderBlock)
              )}
            </section>
          );
        })}
      </div>
      </div>
    </ChatProvider>
  );
}
