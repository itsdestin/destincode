// @vitest-environment jsdom
// G-1: the five card states from the workbench fixtures, plus the Stop wiring.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import ToolCard, { friendlyToolDisplay } from '../src/renderer/components/ToolCard';
import { ChatProvider } from '../src/renderer/state/chat-context';
import type { ToolCallState, ShellRunView } from '../src/shared/types';

afterEach(cleanup);
const base = (run?: ShellRunView, extra: Partial<ToolCallState> = {}): ToolCallState => ({
  id: 'x', toolUseId: 'toolu_1', toolName: 'Bash', status: 'complete',
  input: { command: 'npm run dev:renderer', description: 'Start the dev server', run_in_background: true },
  response: 'Started in the background (shell id sh-4f2a).', shellRun: run, ...extra,
} as ToolCallState);
const now = Date.now();
const running: ShellRunView = { toolUseId: 'toolu_1', shellId: 'sh-4f2a', status: 'running', startedAt: now - 134_000, tail: 'VITE ready', logPath: '/tmp/l.txt' };

function expand(t: ToolCallState) {
  const killShell = vi.fn(async () => ({ ok: true }));
  (window as any).claude = { native: { killShell }, on: {} };
  const { container } = render(<ChatProvider><ToolCard tool={t} sessionId="s1" /></ChatProvider>);
  fireEvent.click(screen.getByTestId('tool-card-chevron').closest('button')!);
  return { container, killShell };
}

describe('ShellView states', () => {
  it('running: strip with ticking elapsed, Stop, live output, log path; header suffix', () => {
    const { container, killShell } = expand(base(running));
    expect(container.textContent).toMatch(/Running in the background · 2m 1\ds/);
    expect(container.textContent).toContain('Live output');
    expect(container.textContent).toContain('Full log: /tmp/l.txt');
    expect(friendlyToolDisplay(base(running)).label).toContain('in the background');
    fireEvent.click(screen.getByText('Stop'));
    expect(killShell).toHaveBeenCalledWith('s1', 'sh-4f2a');
  });
  it('a refused Stop returns the button to "Stop"', async () => {
    (window as any).claude = { native: { killShell: async () => ({ ok: false, reason: 'not-running' }) }, on: {} };
    render(<ChatProvider><ToolCard tool={base(running)} sessionId="s1" /></ChatProvider>);
    fireEvent.click(screen.getByTestId('tool-card-chevron').closest('button')!);
    fireEvent.click(screen.getByText('Stop'));
    await waitFor(() => expect(screen.getByText('Stop')).toBeTruthy());
  });
  it('finished: Background + green Exit 0 chip; failed: red Exit 1', () => {
    const a = expand(base({ ...running, status: 'exited', exitCode: 0, endedAt: running.startedAt + 702_000 }));
    expect(a.container.textContent).toContain('Exit 0 · 11m 42s');
    expect(a.container.textContent).toContain('Background');
    cleanup();
    const b = expand(base({ ...running, status: 'exited', exitCode: 1, endedAt: running.startedAt + 192_000 }));
    expect(b.container.textContent).toContain('Exit 1 · 3m 12s');
  });
  it('stopped: names the reason; detached: says it hit its time limit', () => {
    const a = expand(base({ ...running, status: 'stopped', stopReason: 'conversation-closed', endedAt: running.startedAt + 2_400_000 }));
    expect(a.container.textContent).toContain('Stopped when the conversation closed · after 40m');
    cleanup();
    const b = expand(base({ ...running, detached: true }));
    expect(b.container.textContent).toContain('Hit its time limit');
  });
  it('a rebuilt app-quit record shows no "0s" and no empty log line', () => {
    const { container } = expand(base({ toolUseId: 'toolu_1', shellId: 'sh-4f2a', status: 'stopped', stopReason: 'app-quit', detached: false, startedAt: 0, tail: '', logPath: '' }));
    expect(container.textContent).toContain('Stopped when the app quit');
    expect(container.textContent).not.toContain('after 0s');
    expect(container.textContent).not.toContain('Full log:');
  });
});
