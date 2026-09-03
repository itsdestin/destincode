// @vitest-environment jsdom
// Pins the Files tab's LIST view (design decks 2026-09-03: file-views.questions
// Q-1/Q-3, file-views-round2 R-2/R-3). The grid was the only way to see a
// project's files for a year; the list is the other half, and the two draw from
// exactly the same data, so a change that only fixes the grid can silently
// break the list. Pinned here:
//   1. A file row carries its filename, its kind and a relative modified time.
//   2. A folder row carries its file COUNT and no date — a folder has no single
//      modified time of its own, and borrowing one file's would read as the
//      folder's.
//   3. Loose files come before folders, matching the grid's order.
//   4. The switch is per-app, not per-project: the chosen view is written to
//      localStorage so the next project opens the same way.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { FilesTab } from '../src/renderer/components/project-view/tabs/FilesTab';
import { ArtifactProvider } from '../src/renderer/state/ArtifactContext';

const listAllFiles = vi.fn();

// Two loose files and two files nested one folder deep, so listDir has both a
// file list and a folder to roll up.
const FILES = [
  { id: 'f1', kind: 'internal', path: 'notes.md', lastModified: new Date(Date.now() - 3 * 3600_000).toISOString() },
  { id: 'f2', kind: 'internal', path: 'chart.png', lastModified: new Date(Date.now() - 2 * 3600_000).toISOString() },
  { id: 'f3', kind: 'internal', path: 'docs/spec.md', lastModified: new Date().toISOString() },
  { id: 'f4', kind: 'internal', path: 'docs/plan.md', lastModified: new Date().toISOString() },
];

const project = { id: 'p1', path: '/proj', name: 'Proj' } as any;

function renderTab(view: 'grid' | 'list') {
  return render(
    <ArtifactProvider value={{ state: { activeArtifactBySession: {} } as any, dispatch: vi.fn() }}>
      <FilesTab
        project={project}
        search=""
        types={new Set()}
        sortBy="name"
        view={view}
        onViewChange={vi.fn()}
        refreshKey={0}
      />
    </ArtifactProvider>,
  );
}

beforeEach(() => {
  // The grid's thumbnails gate their reads on an IntersectionObserver, which
  // jsdom doesn't implement — without a stub the grid render throws and the
  // "cards, not rows" assertion fails for the wrong reason.
  (globalThis as any).IntersectionObserver = class {
    observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
  };
  listAllFiles.mockResolvedValue({ ok: true, files: FILES });
  (window as any).claude = {
    artifacts: {
      listAllFiles,
      // The tab subscribes to file-change events and renders thumbnails; both
      // are irrelevant here, and both tolerate a rejected/absent channel.
      onChanged: () => () => {},
      watchProject: () => Promise.reject(new Error('no watcher in tests')),
      get: () => Promise.resolve({ ok: false }),
      readBinary: () => Promise.resolve({ ok: false }),
    },
  };
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('FilesTab list view', () => {
  it('gives each file a name, a kind and a relative time', async () => {
    const { findByTitle } = renderTab('list');
    const row = await findByTitle('notes.md');
    expect(row.textContent).toContain('notes.md');
    expect(row.textContent).toContain('Document');
    expect(row.textContent).toMatch(/ago|just now/);
  });

  it('gives a folder its file count and no date', async () => {
    const { findByTitle } = renderTab('list');
    const row = await findByTitle('docs');
    expect(row.textContent).toContain('2 files');
    expect(row.textContent).not.toMatch(/ago|just now/);
  });

  it('lists loose files before folders, as the grid does', async () => {
    const { container, findByTitle } = renderTab('list');
    await findByTitle('docs');
    const titles = [...container.querySelectorAll('button[title]')].map((b) => b.getAttribute('title'));
    expect(titles.indexOf('chart.png')).toBeLessThan(titles.indexOf('docs'));
    expect(titles.indexOf('notes.md')).toBeLessThan(titles.indexOf('docs'));
  });

  it('draws cards, not rows, in grid view', async () => {
    const { container, findByTitle } = renderTab('grid');
    await findByTitle('notes.md');
    // The thumbnail is the card's defining part and the list has none.
    expect(container.querySelector('.h-44')).not.toBeNull();
  });
});

describe('the view preference', () => {
  it('is stored app-wide, not against a project id', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'src/renderer/components/project-view/ProjectView.tsx'), 'utf8');
    // The key must not be interpolated with a project id — Q-4a chose ONE
    // answer to "what view am I in", not one per project.
    expect(src).toContain("const FILE_VIEW_KEY = 'youcoded.projectView.fileView'");
    expect(src).toMatch(/localStorage\.setItem\(FILE_VIEW_KEY, fileView\)/);
  });
});
