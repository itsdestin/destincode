// @vitest-environment jsdom
// project-view-external-artifacts.test.tsx
//
// Pins the Task 5 "External Artifacts" section in the merged Files tab: sidecar
// records that live OUTSIDE the project folder, which the on-disk walk
// (Project Files) structurally cannot produce. See FilesTab.tsx header comment.
//
// Scaffolding note: this is the first test for FilesTab/ProjectView/
// FileFilterPopover in the repo. The harness (theme-context mock, window.claude
// stub shape, ArtifactContext wrapping) mirrors
// tests/artifacts/html-viewer-stale-content.test.tsx; the assertions below are
// verbatim from the task-5 brief.

import React from 'react';
import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { ArtifactContext } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';

// jsdom has no IntersectionObserver; ArtifactThumbnail (rendered per card)
// needs one for any non-fallback file type (e.g. the .md card below) to mount
// without throwing. Mirrors the ResizeObserver stub pattern used elsewhere
// (tests/context-popup.test.tsx).
beforeAll(() => {
  if (typeof window.IntersectionObserver === 'undefined') {
    window.IntersectionObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof IntersectionObserver;
  }
});

// theme-context reads localStorage / matchMedia / queryLocalFonts on mount and
// doesn't export its raw Context, so mock the hook to the fields FilesTab's
// subtree actually consumes (mirrors html-viewer-stale-content.test.tsx).
vi.mock('../src/renderer/state/theme-context', () => ({
  useTheme: () => ({
    hideCodeAndConfigs: false,
    setHideCodeAndConfigs: vi.fn(),
    showDeletedArtifacts: false,
    setShowDeletedArtifacts: vi.fn(),
    drawerWidth: 420,
    setDrawerWidth: vi.fn(),
    resetDrawerWidth: vi.fn(),
  }),
}));

import { FilesTab } from '../src/renderer/components/project-view/tabs/FilesTab';

const PROJECT = { id: 'p1', name: 'Proj', path: '/home/d/proj' } as any;

const external = (id: string, abs: string) => ({
  id, path: abs.split('/').pop(), kind: 'external', absolutePath: abs,
  versions: [{ type: 'edit' }], status: 'active', lastModified: new Date().toISOString(),
  comments: [], tags: [],
});

const stubClaude = (files: any[], tracked: any[], opts: { gated?: boolean } = {}) => {
  (window as any).claude = {
    artifacts: {
      listAllFiles: vi.fn().mockResolvedValue({ ok: true, files, truncated: false, gated: !!opts.gated }),
      listProject: vi.fn().mockResolvedValue({ ok: true, artifacts: tracked }),
      checkExistence: vi.fn().mockResolvedValue({ ok: true, missingIds: [] }),
      watchProject: vi.fn(), unwatchProject: vi.fn(),
    },
  };
};

const props = {
  project: PROJECT, search: '', typeFilter: 'all' as const,
  sortBy: 'name' as const, hideCode: true, refreshKey: 0,
};

// FilesTab needs ArtifactContext (useArtifact throws without a provider).
function renderFilesTab() {
  const state = { ...initialArtifactState, activeArtifactBySession: {} };
  return render(
    <ArtifactContext.Provider value={{ state, dispatch: vi.fn() }}>
      <FilesTab {...props} />
    </ArtifactContext.Provider>,
  );
}

describe('FilesTab — External Artifacts section', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  // RTL doesn't auto-unmount between tests within one file; without this, each
  // render() piles onto the previous test's DOM and text queries see duplicates.
  afterEach(cleanup);

  it('renders the section when an external artifact exists', async () => {
    stubClaude([], [external('e1', '/home/d/other/budget.xlsx')]);
    renderFilesTab();
    await waitFor(() => expect(screen.getByText('External Artifacts')).toBeTruthy());
    expect(screen.getByText('budget.xlsx')).toBeTruthy();
  });

  it('omits the section entirely when there are no externals', async () => {
    stubClaude([], [
      { id: 'i1', path: 'in.md', kind: 'internal', absolutePath: null,
        versions: [{ type: 'edit' }], status: 'active', lastModified: '', comments: [], tags: [] },
    ]);
    renderFilesTab();
    await waitFor(() => expect(screen.getByText('Project Files')).toBeTruthy());
    expect(screen.queryByText('External Artifacts')).toBeNull();
  });

  it('renders externals even on a gated root, where the disk walk is skipped', async () => {
    // The gate covers Project Files only — the section reads the sidecar and
    // never scans, so a home-dir project still shows what Claude touched outside.
    stubClaude([], [external('e1', '/home/d/other/budget.xlsx')], { gated: true });
    renderFilesTab();
    await waitFor(() => expect(screen.getByText('External Artifacts')).toBeTruthy());
    expect(screen.getByText(/This folder is very large/)).toBeTruthy();
  });

  it('drops internal records — in-folder artifacts are not differentiated', async () => {
    stubClaude(
      [{ id: 'in.md', path: 'in.md', kind: 'internal', absolutePath: null, discovered: true,
         versions: [], status: 'active', lastModified: '', comments: [], tags: [] }],
      [{ id: 'i1', path: 'in.md', kind: 'internal', absolutePath: null,
         versions: [{ type: 'edit' }], status: 'active', lastModified: '', comments: [], tags: [] }],
    );
    renderFilesTab();
    await waitFor(() => expect(screen.getByText('Project Files')).toBeTruthy());
    expect(screen.queryByText('External Artifacts')).toBeNull();
    expect(screen.getAllByText('in.md')).toHaveLength(1); // once, from the walk
  });
});
