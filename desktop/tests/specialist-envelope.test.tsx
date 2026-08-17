// @vitest-environment jsdom
/**
 * Task 10 — the renderer's per-cwd definition lookup (useSpecialistDefinition)
 * and the Always-allow gate it feeds (ToolCard.tsx:1181). Three things this
 * pins, none of which the mock-contract/fixture-replay tests touch:
 *
 *  1. A Task card that passes its session's cwd resolves a PROJECT-defined
 *     specialist (not just built-ins) — the one-line bug this whole cache
 *     exists to prevent is a card that forgets to pass cwd and silently sees
 *     nothing from the project's own .claude/agents.
 *  2. The refetch-on-miss fires AT MOST ONCE per (cwd, agentId) — a
 *     genuinely unknown id costs one extra list() call, never a loop.
 *  3. Always-allow is default-CLOSED: hidden while the definition is
 *     unknown, shown only once the lookup positively says 'builtin', and
 *     never shown for a personal/claude-code hire even once resolved.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor, renderHook, act } from '@testing-library/react';
import React from 'react';
import ToolCard from '../src/renderer/components/ToolCard';
import { ChatProvider } from '../src/renderer/state/chat-context';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';
import { useSpecialistDefinition, refreshSpecialistRoster } from '../src/renderer/hooks/useSpecialists';
import type { ToolCallState, SpecialistsListResult } from '../src/shared/types';

afterEach(cleanup);

/** Stubs window.claude.specialists.list to resolve `result` every call, and
 *  returns the spy so a test can assert how many times it was invoked. */
function mockSpecialistsList(result: SpecialistsListResult): ReturnType<typeof vi.fn> {
  const list = vi.fn().mockResolvedValue(result);
  (window as any).claude = {
    specialists: {
      list,
      getDelegatedModels: vi.fn().mockResolvedValue({ budget: null, frontier: null }),
      setDelegatedModel: vi.fn(),
      steer: vi.fn(),
      interrupt: vi.fn(),
    },
    session: { respondToPermission: vi.fn().mockResolvedValue(true) },
  };
  return list;
}

function renderTaskCard(tool: ToolCallState, cwd: string) {
  return render(
    <ArtifactProvider value={{ state: { ...initialArtifactState, sessionCwd: { s1: cwd } }, dispatch: () => {} }}>
      <ChatProvider><ToolCard tool={tool} sessionId="s1" /></ChatProvider>
    </ArtifactProvider>,
  );
}

const taskCall = (over: Partial<ToolCallState> = {}): ToolCallState => ({
  toolUseId: 'tc-1',
  toolName: 'Task',
  input: { description: 'x', agent: 'docs-writer', prompt: 'y', work_dir: '.' },
  status: 'awaiting-approval',
  requestId: 'native-1',
  ...over,
} as ToolCallState);

describe('a project-defined helper resolves when the card passes its cwd', () => {
  it('shows the project file\'s definition and provenance, not just the built-ins', async () => {
    mockSpecialistsList({
      definitions: [{
        id: 'docs-writer', displayName: 'Docs Writer', description: 'Writes docs.',
        charter: 'read-write', allowedTools: ['Read', 'Write', 'Edit'],
        source: 'claude-code', path: '/proj/.claude/agents/docs-writer.md',
        warnings: [], offered: true,
      }],
      skipped: [],
      folders: { personal: '/home/d/.youcoded/specialists', claudeUser: '/home/d/.claude/agents', project: '/proj/.claude/agents' },
    });

    renderTaskCard(taskCall({ input: { description: 'x', agent: 'docs-writer', prompt: 'y', work_dir: '.' } }), '/proj');

    const envelope = await waitFor(() => screen.getByTestId('specialist-envelope'));
    await waitFor(() => expect(envelope.textContent).toContain('Docs Writer'));
    expect(envelope.textContent).toContain("This project's .claude/agents/docs-writer.md");
  });
});

describe('the definition refetch-on-miss', () => {
  it('fires exactly once per (cwd, agentId) — a genuinely unknown id never loops', async () => {
    const cwd = 'cwd-refetch-once';
    const list = mockSpecialistsList({
      definitions: [],
      skipped: [],
      folders: { personal: '/p', claudeUser: '/c' },
    });

    const { result } = renderHook(() => useSpecialistDefinition(cwd, 'mystery-agent'));

    // Initial load (1) + the one retry the first miss triggers (2).
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(result.current).toBeUndefined();

    // Something UNRELATED refreshes the same cwd (Settings' Refresh button,
    // or another card's own miss on a different id) — the roster object
    // changes, but 'mystery-agent' is STILL missing from it.
    await act(async () => { await refreshSpecialistRoster(cwd); });
    expect(list).toHaveBeenCalledTimes(3);

    // The hook re-evaluated against the new roster and saw the same miss
    // again. definitionMissRetried already recorded (cwd, 'mystery-agent'),
    // so this must NOT trigger a 4th call.
    await new Promise((r) => setTimeout(r, 30));
    expect(list).toHaveBeenCalledTimes(3);
  });
});

describe('Always-allow on a Task hire', () => {
  const roster: SpecialistsListResult = {
    definitions: [
      {
        id: 'explorer', displayName: 'Explorer', description: 'Finds things.',
        charter: 'read-only', allowedTools: ['Read'], source: 'builtin',
        warnings: [], offered: true,
      },
      {
        id: 'docs-writer', displayName: 'Docs Writer', description: 'Writes docs.',
        charter: 'read-write', allowedTools: ['Write'], source: 'personal',
        path: '/home/d/.youcoded/specialists/docs-writer.md', warnings: [], offered: true,
      },
    ],
    skipped: [],
    folders: { personal: '/home/d/.youcoded/specialists', claudeUser: '/home/d/.claude/agents' },
  };

  it('offers Always allow for a built-in hire, once resolved — never optimistically', async () => {
    mockSpecialistsList(roster);
    renderTaskCard(
      taskCall({ requestId: 'native-builtin', input: { description: 'x', agent: 'explorer', prompt: 'y' } }),
      'cwd-builtin',
    );
    // Default-closed: not shown before the lookup resolves (built-ins are in
    // the very first list result, but that result is still an async call).
    expect(screen.queryByText(/always allow/i)).toBeNull();
    await waitFor(() => expect(screen.getByText(/always allow/i)).toBeTruthy());
  });

  it('never offers Always allow for a personal (file-defined) hire', async () => {
    mockSpecialistsList(roster);
    renderTaskCard(
      taskCall({ requestId: 'native-personal', input: { description: 'x', agent: 'docs-writer', prompt: 'y' } }),
      'cwd-personal',
    );
    await waitFor(() => expect(screen.getByTestId('specialist-envelope').textContent).toContain('Docs Writer'));
    expect(screen.queryByText(/always allow/i)).toBeNull();
  });

  it('never offers Always allow for an unresolved (unknown) hire', async () => {
    const list = mockSpecialistsList(roster);
    renderTaskCard(
      taskCall({ requestId: 'native-unknown', input: { description: 'x', agent: 'totally-unknown-agent', prompt: 'y' } }),
      'cwd-unknown',
    );
    // Give the initial load AND the one retry-on-miss time to resolve — the
    // id is genuinely absent from every response, so it never resolves.
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText(/always allow/i)).toBeNull();
  });
});

// Fix pass (Task 10 review, finding 1): ToolCard used to pass the session's
// REAL cwd into useSpecialistDefinition for every card, gating only agentId —
// so a Read/Write/Bash card with no hire in sight still forced a per-project
// specialists.list() disk read via the roster hook underneath. Only a hire
// card (truthy hireAgent) has any use for the real cwd.
describe('a non-hire tool card', () => {
  it('never asks the backend to read its own project\'s specialist folders', async () => {
    const list = mockSpecialistsList({
      definitions: [], skipped: [], folders: { personal: '/p', claudeUser: '/c' },
    });
    renderTaskCard(
      {
        toolUseId: 'tc-read-1',
        toolName: 'Read',
        input: { file_path: '/proj/foo.ts' },
        status: 'complete',
      } as ToolCallState,
      'cwd-non-hire-should-never-be-read',
    );
    // Give the hook's auto-load effect a beat to fire if it were going to.
    await new Promise((r) => setTimeout(r, 30));
    expect(list).not.toHaveBeenCalledWith(
      expect.objectContaining({ cwd: 'cwd-non-hire-should-never-be-read' }),
    );
  });
});
