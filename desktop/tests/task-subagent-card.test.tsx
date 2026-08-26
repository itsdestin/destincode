// @vitest-environment jsdom
/**
 * Pins that the NATIVE harness's `Task` tool renders the SUBAGENT card, the
 * same one Claude Code's `Agent` tool gets (ToolBody.tsx's dispatcher).
 *
 * Why this needs a test of its own: the two halves of the subagent timeline are
 * selected by different keys. The reducer fills `subagentSegments` from any
 * event carrying `parentAgentToolUseId` (applySubagentEvent, chat-reducer.ts) —
 * it never looks at the tool's NAME. The card that displays those segments is
 * chosen by `switch (tool.toolName)`. So dropping the `case 'Task'` line breaks
 * nothing loudly: the specialist's re-stamped events still accumulate in state,
 * every existing test still passes, and the user just sees a raw JSON card with
 * no sign the specialist ever did anything.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import { ChatProvider } from '../src/renderer/state/chat-context';
import type { ToolCallState, SubagentSegment } from '../src/shared/types';

afterEach(cleanup);

const SEGMENTS: SubagentSegment[] = [
  { type: 'tool', id: 'sa-1', toolUseId: 'toolu_c1', toolName: 'Glob', input: { pattern: '*.ts' }, status: 'complete', response: 'src/x.ts' },
  { type: 'text', id: 'sa-2', content: 'REPORT: found it at src/x.ts' },
];

function renderExpanded(tool: ToolCallState): HTMLElement {
  const { container } = render(<ChatProvider><ToolCard tool={tool} sessionId="s1" /></ChatProvider>);
  fireEvent.click(screen.getByTestId('tool-card-chevron').closest('button')!);
  expect(screen.getByTestId('tool-card-body')).toBeTruthy();
  return container;
}

const taskCall = (over: Partial<ToolCallState> = {}): ToolCallState => ({
  id: 'tool-1',
  toolUseId: 'tc-1',
  toolName: 'Task',
  // The native Task tool's real arg names (tools/task.ts's schema).
  input: { description: 'Find the config loader', agent: 'explorer', prompt: 'Find where config is loaded and report the paths.', work_dir: '/proj' },
  status: 'complete',
  subagentSegments: SEGMENTS,
  ...over,
} as ToolCallState);

describe("the native Task tool renders the subagent card, not the raw fallback", () => {
  it("shows the specialist's activity timeline rather than a JSON dump of its input", () => {
    const container = renderExpanded(taskCall());
    // The Activity section is AgentView's — RawFallbackView has no such section.
    expect(container.textContent).toContain(`Activity (${SEGMENTS.length})`);
    // ...and the child's work is actually visible inside it.
    expect(container.textContent).toContain('REPORT: found it at src/x.ts');
    // The raw fallback would render the input as pretty-printed JSON; the
    // subagent card never does.
    expect(container.textContent).not.toContain('"work_dir"');
  });

  it("labels the card with the specialist that ran, not 'general-purpose'", () => {
    // The native tool's arg is `agent`; Claude Code's is `subagent_type`. A
    // card that reads only the CC name would silently mislabel every native
    // specialist as the default agent.
    const container = renderExpanded(taskCall());
    expect(container.textContent).toContain('explorer');
    expect(container.textContent).not.toContain('general-purpose');
  });

  it("still renders Claude Code's own Agent card unchanged", () => {
    const container = renderExpanded(taskCall({
      toolName: 'Agent',
      input: { description: 'Find the config loader', subagent_type: 'Explore', prompt: 'go' },
    }));
    expect(container.textContent).toContain(`Activity (${SEGMENTS.length})`);
    expect(container.textContent).toContain('Explore');
  });
});
