// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { GitReviewView } from './GitReviewView';
import type { GitFileReviewResult } from '../../../shared/git-types';

// Typed against the real IPC result shape (not inferred from the literal) so
// `Partial<typeof review>` allows `uncommitted: null` in the "clean file"
// test below — `uncommitted` is `GitUncommitted | null` on the real type,
// but a bare object-literal inference would narrow it to non-null only.
const review: GitFileReviewResult = {
  ok: true, isRepo: true, branch: 'master',
  uncommitted: {
    hunks: [{ oldStart: 142, oldLines: 1, newStart: 142, newLines: 2, lines: ['-old line', '+new line', '+added line'] }],
    counts: { added: 2, removed: 1 }, staged: false, untracked: false, inHead: true, binary: false,
  },
  log: [
    // pathAtCommit deliberately differs from relPath ('src/f.ts') so the
    // "historical path, not current path" assertion below is meaningful.
    { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'fix: first', authorDate: '2026-07-22T10:00:00Z', pathAtCommit: 'old-name.ts' },
    { sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: 'feat: second', authorDate: '2026-07-21T10:00:00Z', pathAtCommit: 'src/f.ts' },
  ],
  hasMore: false, stagedCount: 0,
};

function mountWith(overrides: Partial<typeof review> = {}, props: Partial<React.ComponentProps<typeof GitReviewView>> = {}) {
  (window as any).claude = {
    git: {
      fileReview: vi.fn(async () => ({ ...review, ...overrides })),
      commitFileDiff: vi.fn(async () => ({ ok: true, hunks: [], binary: false })),
      stage: vi.fn(async () => ({ ok: true })),
      unstage: vi.fn(async () => ({ ok: true })),
      commit: vi.fn(async () => ({ ok: true })),
      onChanged: vi.fn(() => () => {}),
    },
  };
  render(
    <GitReviewView
      projectRoot="/proj" relPath="src/f.ts" fileName="f.ts"
      onBack={() => {}} onOpenAtLine={() => {}} onRequestDiscard={() => {}}
      {...props}
    />,
  );
  return (window as any).claude.git;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('GitReviewView', () => {
  it('renders sub-header title, branch chip, uncommitted card first and expanded', async () => {
    mountWith();
    await waitFor(() => expect(screen.getByText('Uncommitted changes')).toBeInTheDocument());
    expect(screen.getByText(/Reviewing changes for/)).toBeInTheDocument();
    expect(screen.getByText('master')).toBeInTheDocument();
    // expanded by default: its diff rows are visible
    expect(screen.getByText('-old line'.slice(1))).toBeInTheDocument(); // "old line" text cell
    // commit cards listed, collapsed
    expect(screen.getByText('fix: first')).toBeInTheDocument();
    expect(screen.getByText('feat: second')).toBeInTheDocument();
  });

  it('no uncommitted card when the file is clean', async () => {
    mountWith({ uncommitted: null });
    await waitFor(() => expect(screen.getByText('fix: first')).toBeInTheDocument());
    expect(screen.queryByText('Uncommitted changes')).not.toBeInTheDocument();
  });

  it('expanding a commit card lazily fetches its diff using the HISTORICAL path, not the current path', async () => {
    const git = mountWith();
    await waitFor(() => screen.getByText('fix: first'));
    fireEvent.click(screen.getByText('fix: first'));
    await waitFor(() =>
      expect(git.commitFileDiff).toHaveBeenCalledWith('/proj', 'a'.repeat(40), 'old-name.ts', undefined));
  });

  it('renders "Moved from" copy instead of the generic empty state for a renamedFrom commit with no content changes', async () => {
    const git = mountWith({
      log: [
        {
          sha: 'c'.repeat(40), shortSha: 'ccccccc', subject: 'chore: move file',
          authorDate: '2026-07-20T10:00:00Z', pathAtCommit: 'src/f.ts', renamedFrom: 'old-name.ts',
        },
      ],
    });
    await waitFor(() => screen.getByText('chore: move file'));
    fireEvent.click(screen.getByText('chore: move file'));
    await waitFor(() =>
      expect(git.commitFileDiff).toHaveBeenCalledWith('/proj', 'c'.repeat(40), 'src/f.ts', 'old-name.ts'));
    await waitFor(() =>
      expect(screen.getByText('Moved from “old-name.ts” — no content changes in this commit.')).toBeInTheDocument());
    expect(screen.queryByText('No direct changes to this file in this commit.')).not.toBeInTheDocument();
  });

  it('Show more appears when hasMore and fetches the next page', async () => {
    const git = mountWith({ hasMore: true });
    await waitFor(() => screen.getByRole('button', { name: /Show more/ }));
    fireEvent.click(screen.getByRole('button', { name: /Show more/ }));
    await waitFor(() =>
      expect(git.fileReview).toHaveBeenCalledWith('/proj', 'src/f.ts', { logSkip: 2 }));
  });

  it('composer: disabled until a message exists AND stagedCount > 0', async () => {
    mountWith({ stagedCount: 0 });
    await waitFor(() => screen.getByText('Uncommitted changes'));
    const btn = screen.getByRole('button', { name: /Commit/ }) as HTMLButtonElement;
    expect(btn).toBeDisabled(); // no staged files
    fireEvent.change(screen.getByPlaceholderText('Commit message'), { target: { value: 'msg' } });
    expect(btn).toBeDisabled(); // still no staged files
  });

  it('composer: commit fires git.commit with the message and clears it', async () => {
    const git = mountWith({ stagedCount: 2 });
    await waitFor(() => screen.getByText('Uncommitted changes'));
    const area = screen.getByPlaceholderText('Commit message');
    fireEvent.change(area, { target: { value: 'feat: from drawer' } });
    const btn = screen.getByRole('button', { name: 'Commit 2 staged files' });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    await waitFor(() => expect(git.commit).toHaveBeenCalledWith('/proj', 'feat: from drawer'));
    await waitFor(() => expect((area as HTMLTextAreaElement).value).toBe(''));
  });

  it('staged checkbox row stages/unstages the file', async () => {
    const git = mountWith();
    await waitFor(() => screen.getByText('Staged for commit'));
    fireEvent.click(screen.getByText('Staged for commit'));
    await waitFor(() => expect(git.stage).toHaveBeenCalledWith('/proj', 'src/f.ts'));
  });

  it('surfaces a failed operation error verbatim', async () => {
    const git = mountWith({ stagedCount: 1 });
    git.commit.mockResolvedValueOnce({ ok: false, error: 'nothing added to commit' });
    await waitFor(() => screen.getByText('Uncommitted changes'));
    fireEvent.change(screen.getByPlaceholderText('Commit message'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Commit 1 staged file' }));
    await waitFor(() => expect(screen.getByText('nothing added to commit')).toBeInTheDocument());
  });

  it('surfaces a commit-diff fetch error instead of collapsing to "No direct changes"', async () => {
    const git = mountWith();
    git.commitFileDiff.mockResolvedValueOnce({ ok: false, error: 'fatal: bad object', hunks: [], binary: false });
    await waitFor(() => screen.getByText('fix: first'));
    fireEvent.click(screen.getByText('fix: first'));
    await waitFor(() => expect(screen.getByText('fatal: bad object')).toBeInTheDocument());
    expect(screen.queryByText('No direct changes to this file in this commit.')).not.toBeInTheDocument();
  });

  it('renders externalError in the same slot as opError when there is no opError', async () => {
    mountWith({}, { externalError: 'fatal: could not restore f.ts' });
    await waitFor(() => screen.getByText('Uncommitted changes'));
    expect(screen.getByText('fatal: could not restore f.ts')).toBeInTheDocument();
  });

  it('calls onExternalErrorClear at the top of a new run() (stage/unstage)', async () => {
    const onExternalErrorClear = vi.fn();
    const git = mountWith({}, { onExternalErrorClear });
    await waitFor(() => screen.getByText('Staged for commit'));
    fireEvent.click(screen.getByText('Staged for commit'));
    await waitFor(() => expect(git.stage).toHaveBeenCalledWith('/proj', 'src/f.ts'));
    expect(onExternalErrorClear).toHaveBeenCalledTimes(1);
  });

  it('a blocked run() (busy guard) does not call onExternalErrorClear', async () => {
    const onExternalErrorClear = vi.fn();
    const git = mountWith({}, { onExternalErrorClear });
    await waitFor(() => screen.getByText('Staged for commit'));
    let resolveStage: (v: { ok: boolean }) => void = () => {};
    git.stage.mockReturnValueOnce(new Promise((resolve) => { resolveStage = resolve; }));
    const btn = screen.getByText('Staged for commit');
    fireEvent.click(btn); // first call clears
    fireEvent.click(btn); // second call is blocked by the busy guard — no additional clear
    expect(onExternalErrorClear).toHaveBeenCalledTimes(1);
    resolveStage({ ok: true });
    await waitFor(() => expect(git.stage).toHaveBeenCalledTimes(1));
  });

  it('serializes overlapping stage/unstage clicks through run()', async () => {
    const git = mountWith();
    await waitFor(() => screen.getByText('Staged for commit'));
    let resolveStage: (v: { ok: boolean }) => void = () => {};
    git.stage.mockReturnValueOnce(new Promise((resolve) => { resolveStage = resolve; }));
    const btn = screen.getByText('Staged for commit');
    fireEvent.click(btn);
    fireEvent.click(btn); // second click while the first op is still in-flight
    expect(git.stage).toHaveBeenCalledTimes(1);
    resolveStage({ ok: true });
    await waitFor(() => expect(git.stage).toHaveBeenCalledTimes(1));
  });
});
