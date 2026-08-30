// @vitest-environment jsdom
// A file whose only version in THIS session is 'delivered' is labelled
// "delivered" in the Session Drawer — not "viewed" (it is more than a view)
// and not "created" (it was not modified). Spec 2026-08-25 §4.2.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { ArtifactContext } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';
import type { ArtifactRecord } from '../src/shared/artifacts/types';

vi.mock('../src/renderer/state/theme-context', () => ({
  useTheme: () => ({
    hideCodeAndConfigs: false, setHideCodeAndConfigs: vi.fn(),
    showDeletedArtifacts: false, setShowDeletedArtifacts: vi.fn(),
    drawerWidth: 420, setDrawerWidth: vi.fn(), resetDrawerWidth: vi.fn(),
  }),
}));

import { SessionDrawer } from '../src/renderer/components/SessionDrawer';

afterEach(cleanup);

describe('SessionDrawer — delivered label', () => {
  it('labels a delivered-only file "delivered"', async () => {
    const artifact: ArtifactRecord = {
      id: 'a1', path: 'out/chart.png', kind: 'internal', absolutePath: null,
      lastModified: new Date().toISOString(), status: 'active',
      versions: [{ id: 'v1', ts: new Date().toISOString(), sessionId: 'sess', type: 'delivered', author: 'agent', toolUseId: 'toolu_1' }],
      comments: [], tags: [],
    };
    const state = {
      ...initialArtifactState,
      sessionArtifacts: { sess: [artifact] },
      drawerOpenBySession: { sess: true },
      activeArtifactBySession: {},
    };
    (window as any).claude = {
      artifacts: { get: vi.fn(), checkExistence: vi.fn().mockResolvedValue({ ok: true, missingIds: [] }), onChanged: undefined },
    };
    const { container } = render(
      <ArtifactContext.Provider value={{ state, dispatch: vi.fn() }}>
        <SessionDrawer sessionId="sess" projectRoot="/home/u/proj" cwd="/home/u/proj" projectId="proj-1" projectName="proj" />
      </ArtifactContext.Provider>,
    );
    // Read the label div directly (same approach as
    // session-drawer-session-scoped-labels.test.tsx). jsdom's `textContent`
    // concatenates sibling elements with NO separator — "chart.png" (the
    // filename span) runs straight into "delivered" (the label div) as one
    // unbroken run of letters, so a container-wide `\bdelivered\b` regex
    // never finds a word boundary before the "d" and always fails, pass or
    // fail state. Isolating the label div sidesteps that entirely; there is
    // only one row in this fixture so the class selector is unambiguous.
    // The list holds one frame while the on-disk check settles (the drawer no
    // longer paints rows it may be about to remove — see useMissingArtifacts),
    // so the row arrives on the next tick rather than synchronously.
    await waitFor(() => expect(container.querySelector('.text-3xs')).toBeTruthy());
    const label = container.querySelector('.text-3xs')?.textContent ?? '';
    expect(label).toMatch(/^delivered\b/);
    expect(label).not.toMatch(/^(created|viewed|edited)\b/);
  });
});
