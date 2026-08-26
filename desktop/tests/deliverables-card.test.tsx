// @vitest-environment jsdom
// Pins the approved Deliverables card (spec §2) plus Destin's 2026-08-25
// follow-up fixes: the card mounts CLOSED like a tool card (Ctrl+O still
// seeds it open/closed in both directions), its header carries the same "|"
// separator a tool card header does, and a failed tile shows the TOOL's own
// error text — never a hard-coded guess (error-message rule).
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
  it('mounts CLOSED, and a header click reveals one tile per file', () => {
    setViewport(false);
    render(<DeliverablesCard tools={[call('t1', ['/p/docs/a.md', '/tmp/b.png'])]} sessionId="s" />);
    expect(screen.queryByTestId('deliverables-strip')).toBeNull();
    fireEvent.click(screen.getByText('Deliverables'));
    expect(screen.getByTestId('deliverables-strip')).toBeInTheDocument();
    expect(screen.getAllByTestId('sent-file-tile')).toHaveLength(2);
    expect(screen.getByText('a.md')).toBeInTheDocument();
    expect(screen.getByText('/tmp/')).toBeInTheDocument(); // external folder shown absolute
  });

  it('renders the | separator between the glyph and the "Deliverables" label, like a tool card', () => {
    setViewport(false);
    render(<DeliverablesCard tools={[call('t1', ['/p/a.md'])]} sessionId="s" />);
    const label = screen.getByText('Deliverables');
    const sep = label.previousElementSibling;
    expect(sep).toHaveTextContent('|');
    expect(sep?.className).toContain('select-none');
  });

  it('header click on an expanded card collapses it back to one line', () => {
    setViewport(false);
    render(<DeliverablesCard tools={[call('t1', ['/p/a.md'], { input: { files: ['/p/a.md'], caption: 'the report' } })]} sessionId="s" />);
    fireEvent.click(screen.getByText('Deliverables')); // open first — the card mounts closed now
    expect(screen.getByTestId('deliverables-strip')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Deliverables')); // then close it again
    expect(screen.queryByTestId('deliverables-strip')).toBeNull();
    expect(screen.getByText('the report')).toBeInTheDocument(); // caption survives in the header
  });

  it('merges several calls: files concatenate, captions stack under the strip', () => {
    setViewport(false);
    render(<DeliverablesCard tools={[
      call('t1', ['/p/a.md'], { input: { files: ['/p/a.md'], caption: 'first' } }),
      call('t2', ['/p/b.md', '/p/c.md'], { input: { files: ['/p/b.md', '/p/c.md'], caption: 'second' } }),
    ]} sessionId="s" />);
    fireEvent.click(screen.getByText('Deliverables'));
    expect(screen.getAllByTestId('sent-file-tile')).toHaveLength(3);
    expect(screen.getByText('first').tagName).toBe('P');
    expect(screen.getByText('second').tagName).toBe('P');
  });

  it("a failed tile shows the tool's own error text, never a fixed guess", () => {
    setViewport(false);
    const err = 'SendUserFile failed — nothing was sent:\n- /tmp/out is a directory';
    // No header click: a failed call now seeds the card open (Finding 2 fix)
    // — see the dedicated "mounts OPEN" test below for that behavior itself.
    render(<DeliverablesCard tools={[call('t1', ['/tmp/out'], { status: 'failed', error: err })]} sessionId="s" />);
    expect(screen.getByText('Couldn’t send')).toBeInTheDocument();
    expect(screen.getByText(/is a directory/)).toBeInTheDocument();
    expect(screen.queryByText(/not found/)).toBeNull();
    expect(screen.getByTestId('sent-file-tile')).toHaveAttribute('title', expect.stringContaining('is a directory'));
  });

  it('a running call shows Sending…', () => {
    setViewport(false);
    render(<DeliverablesCard tools={[call('t1', ['/p/a.md'], { status: 'running' })]} sessionId="s" />);
    fireEvent.click(screen.getByText('Deliverables'));
    expect(screen.getByText('Sending…')).toBeInTheDocument();
  });

  it('a card whose only call failed mounts OPEN and shows the error text without any click (Finding 2 fix)', () => {
    setViewport(false);
    const err = 'SendUserFile failed — nothing was sent:\n- /tmp/out is a directory';
    render(<DeliverablesCard tools={[call('t1', ['/tmp/out'], { status: 'failed', error: err })]} sessionId="s" />);
    // No click on the header — a failure must be visible on first paint.
    expect(screen.getByTestId('deliverables-strip')).toBeInTheDocument();
    expect(screen.getByText('Couldn’t send')).toBeInTheDocument();
    expect(screen.getByText(/is a directory/)).toBeInTheDocument();
  });

  it('a card whose calls all succeeded still mounts collapsed', () => {
    setViewport(false);
    render(<DeliverablesCard tools={[call('t1', ['/p/a.md'])]} sessionId="s" />);
    expect(screen.queryByTestId('deliverables-strip')).toBeNull();
  });

  it('a failure arriving mid-flight (running -> failed on the SAME instance) opens the card with no click', () => {
    // This is the live-delivery path, not replay: the card mounts while the
    // call is still 'running' (hasFailure false at first render, so the
    // mount-time seed alone would miss it), then the SAME tool entry flips to
    // 'failed' on a later render — exactly what chat-reducer does when a
    // result arrives. `rerender` keeps the component instance so this can
    // only pass via the live effect, never the mount seed. A fresh `render`
    // per status would reproduce the replay case and pass against the broken
    // seed-only code — the trap the rest of this suite fell into.
    setViewport(false);
    const err = 'SendUserFile failed — nothing was sent:\n- /tmp/out is a directory';
    const { rerender } = render(<DeliverablesCard tools={[call('t1', ['/tmp/out'], { status: 'running' })]} sessionId="s" />);
    expect(screen.queryByTestId('deliverables-strip')).toBeNull();
    rerender(<DeliverablesCard tools={[call('t1', ['/tmp/out'], { status: 'failed', error: err })]} sessionId="s" />);
    expect(screen.getByTestId('deliverables-strip')).toBeInTheDocument();
    expect(screen.getByText('Couldn’t send')).toBeInTheDocument();
    expect(screen.getByText(/is a directory/)).toBeInTheDocument();
  });

  it('a card the mid-flight failure opened can still be collapsed by the user, and stays collapsed', () => {
    // Pins the transition guard (wasFailed ref): once hasFailure has already
    // gone true, a LATER re-render for an unrelated reason (here, a caption
    // showing up) must not force `open` back on and undo the user's click.
    setViewport(false);
    const err = 'SendUserFile failed — nothing was sent:\n- /tmp/out is a directory';
    const { rerender } = render(<DeliverablesCard tools={[call('t1', ['/tmp/out'], { status: 'running' })]} sessionId="s" />);
    rerender(<DeliverablesCard tools={[call('t1', ['/tmp/out'], { status: 'failed', error: err })]} sessionId="s" />);
    expect(screen.getByTestId('deliverables-strip')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Deliverables')); // user collapses it
    expect(screen.queryByTestId('deliverables-strip')).toBeNull();
    rerender(<DeliverablesCard tools={[call('t1', ['/tmp/out'], { status: 'failed', error: err, input: { files: ['/tmp/out'], caption: 'still failed' } })]} sessionId="s" />);
    expect(screen.queryByTestId('deliverables-strip')).toBeNull();
  });

  // Run LAST: broadcastCollapseAll/broadcastExpandAll flip a module-level flag
  // in useExpandAllToggle.ts that persists for the rest of this file's test
  // run (by design — see that file's header comment), so a test earlier in
  // this list would silently inherit 'expanded' or 'collapsed' mode instead
  // of the plain default this suite otherwise relies on.
  it('seeds CLOSED when Ctrl+O collapse-all is active at mount, and reopens on expand-all', () => {
    setViewport(false);
    broadcastCollapseAll();
    render(<DeliverablesCard tools={[call('t1', ['/p/a.md'])]} sessionId="s" />);
    expect(screen.queryByTestId('deliverables-strip')).toBeNull();
    act(() => broadcastExpandAll());
    expect(screen.getByTestId('deliverables-strip')).toBeInTheDocument();
  });

});
