// @vitest-environment jsdom
// The Session Drawer holds its file list for one frame while the on-disk check
// settles, so it never paints rows it is about to remove (the "deleted files
// flash", 2026-08-30). A hold has a failure mode the flash does not: a list
// that never appears at all. These cases pin both escapes — no folder to check
// against, and a check that never answers — because a permanently blank file
// pane is a far worse outcome than the cosmetic flash it replaced.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { ArtifactContext } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';
import type { ArtifactRecord } from '../src/shared/artifacts/types';
import { __resetMissingArtifactsCache } from '../src/renderer/hooks/useMissingArtifacts';

vi.mock('../src/renderer/state/theme-context', () => ({
  useTheme: () => ({
    hideCodeAndConfigs: false, setHideCodeAndConfigs: vi.fn(),
    showDeletedArtifacts: false, setShowDeletedArtifacts: vi.fn(),
    drawerWidth: 420, setDrawerWidth: vi.fn(), resetDrawerWidth: vi.fn(),
  }),
}));

import { SessionDrawer } from '../src/renderer/components/SessionDrawer';

afterEach(() => { cleanup(); __resetMissingArtifactsCache(); });

const artifact: ArtifactRecord = {
  id: 'a1', path: 'out/report.md', kind: 'internal', absolutePath: null,
  lastModified: new Date().toISOString(), status: 'active',
  versions: [{ id: 'v1', ts: new Date().toISOString(), sessionId: 'sess', type: 'create', author: 'agent', toolUseId: 'toolu_1' }],
  comments: [], tags: [],
};

const state = {
  ...initialArtifactState,
  sessionArtifacts: { sess: [artifact] },
  drawerOpenBySession: { sess: true },
  activeArtifactBySession: {},
};

function renderDrawer(cwd: string) {
  return render(
    <ArtifactContext.Provider value={{ state, dispatch: vi.fn() }}>
      <SessionDrawer sessionId="sess" projectRoot="/home/u/proj" cwd={cwd} projectId="proj-1" projectName="proj" />
    </ArtifactContext.Provider>,
  );
}

describe('SessionDrawer settle hold', () => {
  it('does not hold when there is no folder to check against', () => {
    // cwd is optional on BOTH call sites (ChatView, TerminalRightSlot) and
    // arrives as ''. Holding on a check that can never be issued would blank
    // the list forever.
    (window as any).claude = {
      artifacts: { get: vi.fn(), checkExistence: vi.fn(), onChanged: undefined },
    };
    const { container } = renderDrawer('');
    expect(container.querySelector('.text-3xs')).toBeTruthy();   // the row, on frame one
    expect((window as any).claude.artifacts.checkExistence).not.toHaveBeenCalled();
  });

  it('paints anyway when the check never answers', async () => {
    (window as any).claude = {
      artifacts: { get: vi.fn(), checkExistence: vi.fn(() => new Promise(() => {})), onChanged: undefined },
    };
    const { container } = renderDrawer('/home/u/proj');
    expect(container.querySelector('.text-3xs')).toBeFalsy();    // held, briefly
    await waitFor(() => expect(container.querySelector('.text-3xs')).toBeTruthy(), { timeout: 3000 });
  });
});
