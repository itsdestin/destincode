// @vitest-environment jsdom
// Pins the artifact-pane read lifecycle (the "no longer on disk" flash fix).
// content === null used to be ONE signal meaning both "read in flight" and
// "file is gone", so EVERY artifact open flashed the alarming missing-file
// message until the read resolved. useArtifactContent + ArtifactContentState
// now keep loading / ready / missing / error apart. Pinned here:
//   1. While the read is pending: NO missing-file message — a quiet
//      loading placeholder instead.
//   2. A read that resolves orphan:true (the handler's genuine not-found
//      signal) shows "This file is no longer on disk."
//   3. A read that resolves with content shows the content.
//   4. A read ERROR is surfaced as the real error with Retry — never mapped
//      to "no longer on disk" (a permissions failure is not a deleted file).
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent, cleanup } from '@testing-library/react';
import { ActiveArtifactView } from '../src/renderer/components/artifact-views/ActiveArtifactView';
import { useArtifactContent } from '../src/renderer/components/artifact-views/useArtifactContent';

const get = vi.fn();
const save = vi.fn();

const MISSING_MSG = /no longer on disk/i;
const LOADING_MSG = /Loading file/i;

// Minimal real host: the same wiring SessionDrawer and FilesTab use —
// useArtifactContent owns the read, ActiveArtifactView renders the phases.
function Host({ artifact }: { artifact: any }) {
  const { content, setContent, contentInfo, contentState, retryRead } =
    useArtifactContent('/proj', artifact.id);
  return (
    <ActiveArtifactView
      artifact={artifact}
      content={content}
      contentInfo={contentInfo}
      contentState={contentState}
      onRetryRead={retryRead}
      projectRoot="/proj"
      projectId="p1"
      projectName="Proj"
      sessionId="s1"
      onContentChange={setContent}
    />
  );
}

const mdArtifact = { id: 'a1', kind: 'internal', path: 'notes.md' } as any;

// Controllable read: each get() call parks until the test resolves/rejects it.
let pending: Array<{ resolve: (v: any) => void; reject: (e: any) => void }>;
// Latest watcher subscription (ActiveArtifactView's onChanged effect) so tests
// can simulate an external write / file-reappears event.
let changedCb: ((evt: any) => void) | null;

beforeEach(() => {
  pending = [];
  changedCb = null;
  get.mockReset().mockImplementation(
    () => new Promise((resolve, reject) => { pending.push({ resolve, reject }); })
  );
  save.mockReset().mockResolvedValue({ ok: true, mtimeMs: 1 });
  (window as any).claude = {
    artifacts: {
      get, save,
      onChanged: (cb: (evt: any) => void) => { changedCb = cb; return () => {}; },
    },
  };
});

// Queries bind to document.body — without cleanup, renders leak across tests
// and getByText trips on the previous test's tree.
afterEach(cleanup);

async function settle(fn: () => void) {
  await act(async () => { fn(); });
}

describe('artifact pane read lifecycle', () => {
  it('shows a loading placeholder, NOT the missing-file message, while the read is pending', () => {
    const utils = render(<Host artifact={mdArtifact} />);
    expect(get).toHaveBeenCalledTimes(1);
    // The bug this whole change exists to fix:
    expect(utils.queryByText(MISSING_MSG)).toBeNull();
    expect(utils.getByText(LOADING_MSG)).toBeTruthy();
  });

  it('shows "no longer on disk" ONLY once the read genuinely resolved orphan:true', async () => {
    const utils = render(<Host artifact={mdArtifact} />);
    await settle(() => pending[0].resolve({ ok: true, content: null, orphan: true }));
    expect(utils.getByText(MISSING_MSG)).toBeTruthy();
    expect(utils.queryByText(LOADING_MSG)).toBeNull();
  });

  it('shows the content once the read resolves with it', async () => {
    const utils = render(<Host artifact={mdArtifact} />);
    await settle(() => pending[0].resolve({
      ok: true, content: '# Hello world', orphan: false, binary: false, mtimeMs: 1,
    }));
    expect(await utils.findByText('Hello world')).toBeTruthy();
    expect(utils.queryByText(MISSING_MSG)).toBeNull();
    expect(utils.queryByText(LOADING_MSG)).toBeNull();
  });

  it('surfaces a failed read as the real error with Retry — never as "no longer on disk"', async () => {
    const utils = render(<Host artifact={mdArtifact} />);
    await settle(() => pending[0].resolve({ ok: false, error: 'protected-path' }));
    expect(utils.queryByText(MISSING_MSG)).toBeNull();
    expect(utils.getByText(/protected location/i)).toBeTruthy();
    // Retry re-runs the read; a successful second read shows the content.
    await settle(() => { fireEvent.click(utils.getByText('Retry')); });
    expect(get).toHaveBeenCalledTimes(2);
    await settle(() => pending[1].resolve({
      ok: true, content: '# Back now', orphan: false, binary: false, mtimeMs: 2,
    }));
    expect(await utils.findByText('Back now')).toBeTruthy();
  });

  it('surfaces a rejected invoke (thrown handler error) as an error, not a deleted file', async () => {
    const utils = render(<Host artifact={mdArtifact} />);
    await settle(() => pending[0].reject(new Error('EACCES: permission denied')));
    expect(utils.queryByText(MISSING_MSG)).toBeNull();
    expect(utils.getByText(/EACCES: permission denied/)).toBeTruthy();
  });

  it('unknown error codes surface verbatim (never a guessed cause)', async () => {
    const utils = render(<Host artifact={mdArtifact} />);
    await settle(() => pending[0].resolve({ ok: false, error: 'weird-new-code' }));
    expect(utils.getByText(/weird-new-code/)).toBeTruthy();
  });

  it('legacy callers without contentState keep the old semantics (null = missing)', () => {
    // Back-compat pin: a caller that has not adopted the tri-state must not
    // silently lose the missing-file notice.
    const utils = render(
      <ActiveArtifactView
        artifact={mdArtifact}
        content={null}
        projectRoot="/proj"
        projectId="p1"
        projectName="Proj"
        sessionId="s1"
        onContentChange={() => {}}
      />
    );
    expect(utils.getByText(MISSING_MSG)).toBeTruthy();
  });

  it('switching artifacts returns to loading (no stale missing message from the previous file)', async () => {
    const utils = render(<Host artifact={mdArtifact} />);
    await settle(() => pending[0].resolve({ ok: true, content: null, orphan: true }));
    expect(utils.getByText(MISSING_MSG)).toBeTruthy();
    // Switch to another file: the pane must drop back to loading, not keep
    // claiming the NEW file is gone while its read is in flight.
    await settle(() => {
      utils.rerender(<Host artifact={{ id: 'a2', kind: 'internal', path: 'other.md' } as any} />);
    });
    expect(get).toHaveBeenCalledTimes(2);
    expect(utils.queryByText(MISSING_MSG)).toBeNull();
    expect(utils.getByText(LOADING_MSG)).toBeTruthy();
  });

  it('ignores a stale resolve from a switched-away artifact (cancelled guard)', async () => {
    const utils = render(<Host artifact={mdArtifact} />);
    // Switch to a2 while a1's read is STILL pending — a1's late resolve must
    // not paint a1's content (or any resolved phase) into a2's pane.
    await settle(() => {
      utils.rerender(<Host artifact={{ id: 'a2', kind: 'internal', path: 'other.md' } as any} />);
    });
    expect(get).toHaveBeenCalledTimes(2);
    await settle(() => pending[0].resolve({
      ok: true, content: '# Hello from a1', orphan: false, binary: false, mtimeMs: 1,
    }));
    expect(utils.queryByText('Hello from a1')).toBeNull();
    expect(utils.getByText(LOADING_MSG)).toBeTruthy();
  });

  it('recovers from missing when the file reappears on disk (watcher refetch → onContentChange)', async () => {
    // PR #303 review regression: ActiveArtifactView's onChanged effect hands
    // refetched bytes back via onContentChange WITHOUT re-running the hook's
    // read — the phase must reconcile to ready, not stay stuck on "missing"
    // until reselect. Pre-tri-state this auto-recovered.
    const utils = render(<Host artifact={mdArtifact} />);
    await settle(() => pending[0].resolve({ ok: true, content: null, orphan: true }));
    expect(utils.getByText(MISSING_MSG)).toBeTruthy();
    // Agent recreates the file → watcher 'add'/'change' → subscribed handler
    // refetches (the REAL production path, not a synthetic setContent call).
    expect(changedCb).toBeTruthy();
    await settle(() => changedCb!({ projectRoot: '/proj', artifactId: 'a1', kind: 'add' }));
    expect(get).toHaveBeenCalledTimes(2);
    await settle(() => pending[1].resolve({
      ok: true, content: '# Recovered', orphan: false, binary: false, mtimeMs: 2,
    }));
    expect(await utils.findByText('Recovered')).toBeTruthy();
    expect(utils.queryByText(MISSING_MSG)).toBeNull();
  });
});
