// @vitest-environment jsdom
// Perf cycle 2 regression guard.
//
// The session drawer's file list used to be loaded once by ChatView at session
// mount and then refreshed as a SIDE EFFECT of transcript replay: the artifact
// tool-use tracker listens to transcript events, so re-streaming a whole
// conversation's history happened to re-list its files. Paged history stopped
// streaming history through that channel and the drawer went empty — caught by
// the perf rig, whose files-drawer scenario failed twice in a row.
//
// The drawer must list its own session when it opens, against the RESOLVED
// project root.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({ state: {} as any, dispatch: vi.fn() }));

vi.mock('../src/renderer/state/ArtifactContext', () => ({
  useArtifact: () => ({ state: mocks.state, dispatch: mocks.dispatch }),
}));

import { SessionDrawer } from '../src/renderer/components/SessionDrawer';

const SESSION = 's1';
const ROOT = '/projects/alpha';

function baseState(drawerOpen: boolean) {
  return {
    sessionArtifacts: { [SESSION]: [] },
    drawerOpenBySession: { [SESSION]: drawerOpen },
    activeArtifactBySession: {},
    gitReviewBySession: {},
    pillError: {},
    drawerExpanded: false,
    // Added by the artifact-zoom / session-preview work merged from master.
    activeSessionPreviewBySession: {},
    referencedSessionsBySession: {},
  };
}

let listSession: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mocks.dispatch = vi.fn();
  listSession = vi.fn().mockResolvedValue({ ok: true, artifacts: [{ id: 'a1', path: `${ROOT}/perf-small.ts` }] });
  (window as any).claude = {
    artifacts: {
      listSession,
      checkExistence: vi.fn().mockResolvedValue({ ok: true, missingIds: [] }),
    },
  };
});
afterEach(() => cleanup());

describe('SessionDrawer lists its session when it opens', () => {
  it('calls listSession with the RESOLVED project root and loads the rows', async () => {
    mocks.state = baseState(true);
    render(<SessionDrawer sessionId={SESSION} projectRoot={ROOT} projectId="p" projectName="alpha" />);
    await waitFor(() => expect(listSession).toHaveBeenCalledWith(SESSION, ROOT));
    await waitFor(() => expect(mocks.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'SESSION_ARTIFACTS_LOADED', sessionId: SESSION }),
    ));
  });

  it('does not list while the drawer is closed', () => {
    mocks.state = baseState(false);
    render(<SessionDrawer sessionId={SESSION} projectRoot={ROOT} projectId="p" projectName="alpha" />);
    expect(listSession).not.toHaveBeenCalled();
  });

  it('does not list before the project root has resolved', () => {
    mocks.state = baseState(true);
    render(<SessionDrawer sessionId={SESSION} projectRoot="" projectId="p" projectName="alpha" />);
    expect(listSession).not.toHaveBeenCalled();
  });
});
