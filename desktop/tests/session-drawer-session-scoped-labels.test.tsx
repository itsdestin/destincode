// @vitest-environment jsdom
// session-drawer-session-scoped-labels.test.tsx
//
// Bug: the Session Drawer is a per-session activity log, but its row labels
// (status word + timestamp) were computed from the artifact RECORD's whole
// history — every session that ever touched the file, not just this one. A
// file edited weeks ago in another session and merely READ in today's
// session showed "edited · 7/26/2026": the word came from a record-global
// version count, the date from the record-global lastModified cache. Neither
// describes what THIS session did.
//
// Pinned here: a record with edits in other sessions and exactly one 'read'
// version in the CURRENT session renders "viewed" + that read's own
// timestamp — not the global edit history bleeding into this session's row.
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { afterEach } from 'vitest';
import { ArtifactContext } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';
import type { ArtifactRecord } from '../src/shared/artifacts/types';

// theme-context reads localStorage / matchMedia / queryLocalFonts on mount and
// doesn't export its raw Context, so mock the hook to the fields SessionDrawer
// actually consumes (same approach as html-viewer-stale-content.test.tsx).
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

import { SessionDrawer } from '../src/renderer/components/SessionDrawer';

const SESSION = 'sess-current';
const OTHER_SESSION_1 = 'sess-old-1';
const OTHER_SESSION_2 = 'sess-old-2';
const ROOT = '/home/u/proj';

afterEach(cleanup);

// jsdom has no matchMedia — the preview header's narrow-viewport collapse
// (spec 2026-08-26 A4) calls useNarrowViewport() unconditionally on every
// SessionDrawer render now, same stub shape as use-narrow-viewport.test.tsx.
(window as any).matchMedia = (window as any).matchMedia || ((q: string) => ({
  matches: false, media: q, onchange: null,
  addEventListener: () => {}, removeEventListener: () => {},
  addListener: () => {}, removeListener: () => {}, dispatchEvent: () => true,
}));

describe('SessionDrawer row labels are scoped to THIS session', () => {
  it('shows "viewed" and the read\'s own timestamp for a file only read in this session, ignoring edits from other sessions', async () => {
    const now = Date.now();
    const threeHoursAgo = new Date(now - 3 * 60 * 60 * 1000).toISOString();
    const sevenDaysAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();
    const threeWeeksAgo = new Date(now - 21 * 24 * 60 * 60 * 1000).toISOString();

    const artifact: ArtifactRecord = {
      id: 'a1',
      path: 'PITFALLS.md',
      kind: 'internal',
      absolutePath: null,
      // Record-global cache — stale/misleading for THIS session's row; the fix
      // must not read this field when this session has its own version(s).
      lastModified: sevenDaysAgo,
      status: 'active',
      versions: [
        // Edited weeks ago, in a DIFFERENT session — must not count toward
        // this session's status word or supply this session's timestamp.
        { id: 'v1', ts: threeWeeksAgo, sessionId: OTHER_SESSION_1, type: 'create', author: 'agent' },
        { id: 'v2', ts: sevenDaysAgo, sessionId: OTHER_SESSION_2, type: 'edit', author: 'agent' },
        // The ONLY version event belonging to the current session: a read.
        { id: 'v3', ts: threeHoursAgo, sessionId: SESSION, type: 'read', author: 'agent' },
      ],
      comments: [],
      tags: [],
    };

    const state = {
      ...initialArtifactState,
      sessionArtifacts: { [SESSION]: [artifact] },
      drawerOpenBySession: { [SESSION]: true },
      // No active artifact selected — renders the list-only branch, which
      // needs no artifacts.get mock for content.
      activeArtifactBySession: {},
    };

    (window as any).claude = {
      artifacts: {
        get: vi.fn(),
        checkExistence: vi.fn().mockResolvedValue({ ok: true, missingIds: [] }),
        onChanged: undefined,
      },
      // SessionDrawer's preview header (spec 2026-08-26 A1/A2/A4) calls
      // useTagRegistry() UNCONDITIONALLY — not just while a preview is
      // showing — so every SessionDrawer render needs this, even a test like
      // this one that never opens a preview.
      tags: { list: vi.fn().mockResolvedValue([]) },
    };

    const { container } = render(
      <ArtifactContext.Provider value={{ state, dispatch: vi.fn() }}>
        <SessionDrawer
          sessionId={SESSION}
          projectRoot={ROOT}
          cwd={ROOT}
          projectId="proj-1"
          projectName="proj"
        />
      </ArtifactContext.Provider>,
    );

    // Row label format is "{statusWord} · {relTime}" — rendered in its own
    // div (ArtifactListItem's "text-3xs" line), separate from the filename
    // div, so target it directly rather than a parent whose textContent
    // would concatenate the filename in front of the label.
    // The list holds one frame while the on-disk check settles (the drawer no
    // longer paints rows it may be about to remove — see useMissingArtifacts),
    // so the row arrives on the next tick rather than synchronously.
    await waitFor(() => expect(container.querySelector('.text-3xs')).toBeTruthy());
    const labelEl = container.querySelector('.text-3xs');
    const label = labelEl?.textContent ?? null;

    expect(label).toBeTruthy();
    // The word must be "viewed" (only a read in THIS session) — NOT "edited",
    // which is what the record-global version count (2 non-read versions,
    // both in OTHER sessions) would wrongly report.
    expect(label).toMatch(/^viewed · /);
    // The timestamp must be THIS session's read (~3h ago), not the
    // record-global lastModified cache (7 days ago, which would render as a
    // locale date string, not "Xh ago").
    expect(label).toMatch(/^viewed · 3h ago$/);
  });
});
