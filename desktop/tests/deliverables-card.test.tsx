// @vitest-environment jsdom
// Pins the approved Deliverables card (spec §2) plus the two review fixes:
// the open/closed seed follows Ctrl+O like every tool card, and a failed tile
// shows the TOOL's error text — never a hard-coded guess (error-message rule).
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react';
import type { ToolCallState } from '../src/shared/types';

// The card is under test, not the preview: ArtifactThumbnail does IPC.
vi.mock('../src/renderer/components/ArtifactThumbnail', () => ({
  ArtifactThumbnail: () => <div data-testid="thumb" />,
}));

import { DeliverablesCard } from '../src/renderer/components/DeliverablesCard';
import { broadcastCollapseAll, broadcastExpandAll } from '../src/renderer/hooks/useExpandAllToggle';

// jsdom has neither matchMedia (useNarrowViewport) nor ResizeObserver (fades).
function setViewport(narrow: boolean) {
  (window as any).matchMedia = (query: string) => ({
    matches: narrow, media: query, addEventListener: () => {}, removeEventListener: () => {},
  });
}
(globalThis as any).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const call = (id: string, files: string[], extra: Partial<ToolCallState> = {}): ToolCallState => ({
  toolUseId: id, toolName: 'SendUserFile', input: { files, status: 'normal' }, status: 'complete', ...extra,
});

afterEach(cleanup);

describe('DeliverablesCard', () => {
  it('is open by default with one tile per file', () => {
    setViewport(false);
    render(<DeliverablesCard tools={[call('t1', ['/p/docs/a.md', '/tmp/b.png'])]} sessionId="s" />);
    expect(screen.getByTestId('deliverables-strip')).toBeInTheDocument();
    expect(screen.getAllByTestId('sent-file-tile')).toHaveLength(2);
    expect(screen.getByText('a.md')).toBeInTheDocument();
    expect(screen.getByText('/tmp/')).toBeInTheDocument(); // external folder shown absolute
  });

  it('seeds CLOSED when Ctrl+O collapse-all is active at mount, and reopens on expand-all', () => {
    setViewport(false);
    broadcastCollapseAll();
    render(<DeliverablesCard tools={[call('t1', ['/p/a.md'])]} sessionId="s" />);
    expect(screen.queryByTestId('deliverables-strip')).toBeNull();
    act(() => broadcastExpandAll());
    expect(screen.getByTestId('deliverables-strip')).toBeInTheDocument();
  });

  it('header click collapses to one line', () => {
    setViewport(false);
    render(<DeliverablesCard tools={[call('t1', ['/p/a.md'], { input: { files: ['/p/a.md'], caption: 'the report' } })]} sessionId="s" />);
    fireEvent.click(screen.getByText('Deliverables'));
    expect(screen.queryByTestId('deliverables-strip')).toBeNull();
    expect(screen.getByText('the report')).toBeInTheDocument(); // caption survives in the header
  });

  it('merges several calls: files concatenate, captions stack under the strip', () => {
    setViewport(false);
    render(<DeliverablesCard tools={[
      call('t1', ['/p/a.md'], { input: { files: ['/p/a.md'], caption: 'first' } }),
      call('t2', ['/p/b.md', '/p/c.md'], { input: { files: ['/p/b.md', '/p/c.md'], caption: 'second' } }),
    ]} sessionId="s" />);
    expect(screen.getAllByTestId('sent-file-tile')).toHaveLength(3);
    expect(screen.getByText('first').tagName).toBe('P');
    expect(screen.getByText('second').tagName).toBe('P');
  });

  it("a failed tile shows the tool's own error text, never a fixed guess", () => {
    setViewport(false);
    const err = 'SendUserFile failed — nothing was sent:\n- /tmp/out is a directory';
    render(<DeliverablesCard tools={[call('t1', ['/tmp/out'], { status: 'failed', error: err })]} sessionId="s" />);
    expect(screen.getByText('Couldn’t send')).toBeInTheDocument();
    expect(screen.getByText(/is a directory/)).toBeInTheDocument();
    expect(screen.queryByText(/not found/)).toBeNull();
    expect(screen.getByTestId('sent-file-tile')).toHaveAttribute('title', expect.stringContaining('is a directory'));
  });

  it('a running call shows Sending…', () => {
    setViewport(false);
    render(<DeliverablesCard tools={[call('t1', ['/p/a.md'], { status: 'running' })]} sessionId="s" />);
    expect(screen.getByText('Sending…')).toBeInTheDocument();
  });

});
