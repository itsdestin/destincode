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
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { ArtifactContext } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';
import type { FileTypeGroup } from '../src/shared/artifacts/categorization';

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
      // Stubbed so the debounced content search SETTLES deterministically —
      // while it is in flight the tab suppresses its own empty state, which
      // would otherwise mask what the search tests below are checking.
      searchContent: vi.fn().mockResolvedValue({ ok: true, hits: [], truncated: false }),
      watchProject: vi.fn(), unwatchProject: vi.fn(),
    },
  };
};

const props = {
  // Type filter went multi-select on 2026-07-23 and "Hide code & configs" was
  // retired the same day (code is just one of the types). An EMPTY set means
  // "all types", which is the unfiltered view these tests want.
  project: PROJECT, search: '', types: new Set<FileTypeGroup>(),
  sortBy: 'name' as const, refreshKey: 0,
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

  it('drops DELETED externals — the tab that hosted tombstones is gone', async () => {
    // LIST_PROJECT still returns tombstones for the session drawer's "Show
    // deleted" toggle. Nothing here filtered them, so a deleted external
    // rendered permanently with the irreversible Exclude as the only way out.
    stubClaude([], [
      { ...external('e1', '/home/d/other/gone.md'), status: 'deleted' },
      external('e2', '/home/d/other/budget.xlsx'),
    ]);
    renderFilesTab();
    await waitFor(() => expect(screen.getByText('External Artifacts')).toBeTruthy());
    expect(screen.getByText('budget.xlsx')).toBeTruthy();
    expect(screen.queryByText('gone.md')).toBeNull();
  });

  it('omits the section when its only external is a tombstone', async () => {
    stubClaude([], [{ ...external('e1', '/home/d/other/gone.md'), status: 'deleted' }]);
    renderFilesTab();
    await waitFor(() => expect(screen.getByText('Project Files')).toBeTruthy());
    expect(screen.queryByText('External Artifacts')).toBeNull();
  });

  it('keeps an ORPHAN external — tracked, active, file missing from disk', async () => {
    // Deliberate per spec: a moved/deleted file must be visible as an orphan
    // row, not silently absent. Only status-deleted tombstones are dropped.
    (window as any).claude = undefined;
    stubClaude([], [external('e1', '/home/d/other/budget.xlsx')]);
    (window as any).claude.artifacts.checkExistence =
      vi.fn().mockResolvedValue({ ok: true, missingIds: ['e1'] });
    renderFilesTab();
    await waitFor(() => expect(screen.getByText('External Artifacts')).toBeTruthy());
    expect(screen.getByText('budget.xlsx')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('deleted')).toBeTruthy()); // orphan badge
  });

  // The two empty states below are computed from the FILE GRID only, while the
  // External Artifacts section renders independently right underneath — so they
  // used to print "nothing matched" directly above a card for the very file the
  // user was looking for.
  describe('empty states account for the External Artifacts section', () => {
    // Pin the platform to 'browser' for the SEARCH cases: the project-wide
    // CONTENT search is desktop-only, and on any other platform the effect
    // settles synchronously instead of through a 300ms debounce + IPC round
    // trip. Without this the assertions race the in-flight-search suppression
    // and pass against broken code.
    const asBrowser = () => { (window as any).__PLATFORM__ = 'browser'; };
    afterEach(() => { delete (window as any).__PLATFORM__; });

    const renderWith = (extra: Record<string, unknown>) => render(
      <ArtifactContext.Provider
        value={{ state: { ...initialArtifactState, activeArtifactBySession: {} }, dispatch: vi.fn() }}
      >
        <FilesTab {...props} {...extra} />
      </ArtifactContext.Provider>,
    );

    it('does not claim "no files match" while a matching external renders below', async () => {
      asBrowser();
      stubClaude([], [external('e1', '/home/d/other/budget.xlsx')]);
      renderWith({ search: 'budget' });
      await waitFor(() => expect(screen.getByText('budget.xlsx')).toBeTruthy());
      expect(screen.queryByText(/No files match/)).toBeNull();
    });

    it('still shows the empty state when nothing at all matches', async () => {
      asBrowser();
      stubClaude([], [external('e1', '/home/d/other/budget.xlsx')]);
      renderWith({ search: 'zzzznope' });
      await waitFor(() => expect(screen.getByText(/No files match/)).toBeTruthy());
    });

    it('does not claim "nothing matches the current filters" over a matching external', async () => {
      // The type-filter flatten has its own line, with no search to clear.
      stubClaude([], [external('e1', '/home/d/other/budget.xlsx')]);
      renderWith({ types: new Set<FileTypeGroup>(['sheet']) });
      await waitFor(() => expect(screen.getByText('budget.xlsx')).toBeTruthy());
      expect(screen.queryByText(/Nothing matches the current filters/)).toBeNull();
    });

    it('still shows the filter empty state when the external is filtered out too', async () => {
      stubClaude([], [external('e1', '/home/d/other/budget.xlsx')]);
      renderWith({ types: new Set<FileTypeGroup>(['image']) });
      await waitFor(() => expect(screen.getByText(/Nothing matches the current filters/)).toBeTruthy());
    });
  });

  // The browsed folder is the "+ Add file" destination — ProjectView reads it
  // back through onCurrentDirChange — so resetting it on every import both
  // yanked the user back to the root AND made the NEXT import land in the wrong
  // folder.
  describe('browsed folder survives a refresh', () => {
    const inDocs = {
      id: 'f1', path: 'docs/notes.md', kind: 'internal', absolutePath: null, discovered: true,
      versions: [], status: 'active', lastModified: '', comments: [], tags: [],
    };

    const renderTree = (onCurrentDirChange: (d: string) => void, refreshKey = 0) => render(
      <ArtifactContext.Provider
        value={{ state: { ...initialArtifactState, activeArtifactBySession: {} }, dispatch: vi.fn() }}
      >
        <FilesTab {...props} refreshKey={refreshKey} onCurrentDirChange={onCurrentDirChange} />
      </ArtifactContext.Provider>,
    );

    it('stays in the browsed folder when refreshKey bumps (an import)', async () => {
      const onDir = vi.fn();
      stubClaude([inDocs], []);
      const { rerender } = renderTree(onDir);
      await waitFor(() => expect(screen.getByText('docs')).toBeTruthy());
      fireEvent.click(screen.getByTitle('docs'));
      await waitFor(() => expect(onDir).toHaveBeenLastCalledWith('docs'));

      rerender(
        <ArtifactContext.Provider
          value={{ state: { ...initialArtifactState, activeArtifactBySession: {} }, dispatch: vi.fn() }}
        >
          <FilesTab {...props} refreshKey={1} onCurrentDirChange={onDir} />
        </ArtifactContext.Provider>,
      );
      await waitFor(() => expect(screen.getByText('notes.md')).toBeTruthy());
      // Still in docs/ — and ProjectView was never told otherwise, so a second
      // consecutive import still targets docs/ rather than the project root.
      expect(onDir).toHaveBeenLastCalledWith('docs');
    });

    it('still returns to the root on a real project switch', async () => {
      const onDir = vi.fn();
      stubClaude([inDocs], []);
      const { rerender } = renderTree(onDir);
      await waitFor(() => expect(screen.getByText('docs')).toBeTruthy());
      fireEvent.click(screen.getByTitle('docs'));
      await waitFor(() => expect(onDir).toHaveBeenLastCalledWith('docs'));

      rerender(
        <ArtifactContext.Provider
          value={{ state: { ...initialArtifactState, activeArtifactBySession: {} }, dispatch: vi.fn() }}
        >
          <FilesTab {...props} project={{ ...PROJECT, id: 'p2' }} onCurrentDirChange={onDir} />
        </ArtifactContext.Provider>,
      );
      await waitFor(() => expect(onDir).toHaveBeenLastCalledWith(''));
    });
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
