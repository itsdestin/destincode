// @vitest-environment jsdom
//
// Bug: when the drawer previews a past conversation, its own top bar still
// rendered (title-less, since no artifact is active) AND SessionPreviewPane
// drew a second header directly beneath it — title, subtitle, and its own ✕.
// Two headers, two close buttons, the top one blank. Destin: "two headers
// with x's is weird tho." The fix reuses the drawer's existing top bar for a
// preview exactly the way it's already used for an open file: the
// conversation title takes the filename's slot, and the bar's one ✕ is the
// only close control. This file pins that arrangement at the DRAWER level —
// SessionPreviewPane no longer takes title/onClose props at all, so those
// assertions can't live in its own test file anymore (see the note atop
// tests/session-preview-pane.test.tsx).
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ArtifactContext } from '../src/renderer/state/ArtifactContext';
import { initialArtifactState } from '../src/renderer/state/artifact-tracker';
import { COPY, providerLabel } from '../src/shared/chatsearch-refs';

// Same reason as session-drawer-session-scoped-labels.test.tsx: theme-context
// touches localStorage/matchMedia/queryLocalFonts on mount and doesn't export
// its raw Context, so mock the hook to the fields SessionDrawer reads.
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

// jsdom does not implement scrollIntoView; ConversationTranscript (rendered
// inside SessionPreviewPane) calls it to jump to the newest message.
beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});

afterEach(cleanup);

const SESSION = 'sess-preview';
const ROOT = '/home/u/proj';
const PREVIEW = { provider: 'claude' as const, id: 'abc', title: 'A conversation about the drawer' };

function stateWithPreview() {
  return {
    ...initialArtifactState,
    // sessionArtifacts must be a REAL (even empty) array here, not the
    // fallback `[]` SessionDrawer computes inline when the key is absent —
    // that fallback is a fresh literal every render, which starves the
    // orphan-check effect's dependency array and free-spins. The real app
    // never hits this: App.tsx/ChatView.tsx always dispatch
    // SESSION_ARTIFACTS_LOADED (seeding this key, even to []) before the
    // drawer can open. Mirror that precondition here rather than the
    // key-absent shape a real render never starts from.
    sessionArtifacts: { [SESSION]: [] },
    drawerOpenBySession: { [SESSION]: true },
    activeSessionPreviewBySession: { [SESSION]: PREVIEW },
  };
}

function mockWindowClaude() {
  (window as any).claude = {
    artifacts: { get: vi.fn(), checkExistence: vi.fn().mockResolvedValue({ ok: true, missingIds: [] }) },
    chatsearch: { read: vi.fn().mockResolvedValue({ ok: true, messages: [], hasMore: false }) },
  };
}

describe('SessionDrawer: one header for a previewed conversation', () => {
  it('shows the conversation title in the top bar and exactly one close control', async () => {
    mockWindowClaude();
    render(
      <ArtifactContext.Provider value={{ state: stateWithPreview(), dispatch: vi.fn() }}>
        <SessionDrawer sessionId={SESSION} projectRoot={ROOT} projectId="proj-1" projectName="proj" />
      </ArtifactContext.Provider>,
    );

    // Title occupies the same top-bar slot the filename does for a file.
    expect(await screen.findByText(PREVIEW.title)).toBeTruthy();

    // Exactly one close control on the whole pane — the drawer's, not a
    // second one from the pane. (Before the fix there were two: the drawer's
    // title-less bar plus the pane's own ✕.)
    expect(screen.getAllByTitle('Close')).toHaveLength(1);

    // The read-only/lane line the old pane header carried is still shown
    // somewhere (now a quiet caption inside the scroll area), just not as a
    // second header.
    expect(await screen.findByText(new RegExp(`Past conversation.*${providerLabel(PREVIEW.provider)}`))).toBeTruthy();
  });

  it('the ☰ list toggle and the bar layout work the same as they do for a file', async () => {
    mockWindowClaude();
    const { container } = render(
      <ArtifactContext.Provider value={{ state: stateWithPreview(), dispatch: vi.fn() }}>
        <SessionDrawer sessionId={SESSION} projectRoot={ROOT} projectId="proj-1" projectName="proj" />
      </ArtifactContext.Provider>,
    );
    await screen.findByText(PREVIEW.title);

    const list = container.querySelector('.drawer-list') as HTMLElement;
    expect(list.className).toContain('w-0'); // collapsed by default, same as a freshly-opened file

    fireEvent.click(screen.getByTitle('Show list'));
    expect(list.className).toContain('w-[210px]');
  });

  it('clicking the bar close button closes the whole drawer for a preview — same action a file\'s close performs', async () => {
    mockWindowClaude();
    const dispatch = vi.fn();
    render(
      <ArtifactContext.Provider value={{ state: stateWithPreview(), dispatch }}>
        <SessionDrawer sessionId={SESSION} projectRoot={ROOT} projectId="proj-1" projectName="proj" />
      </ArtifactContext.Provider>,
    );
    await screen.findByText(PREVIEW.title);

    fireEvent.click(screen.getByTitle('Close'));
    expect(dispatch).toHaveBeenCalledWith({ type: 'DRAWER_CLOSED', sessionId: SESSION });
  });

  it('falls back to the shared "Untitled conversation" copy when a referenced conversation has no title', async () => {
    mockWindowClaude();
    const state = {
      ...initialArtifactState,
      sessionArtifacts: { [SESSION]: [] }, // see stateWithPreview() comment above
      drawerOpenBySession: { [SESSION]: true },
      activeSessionPreviewBySession: { [SESSION]: { provider: 'native' as const, id: 'xyz', title: '' } },
    };
    render(
      <ArtifactContext.Provider value={{ state, dispatch: vi.fn() }}>
        <SessionDrawer sessionId={SESSION} projectRoot={ROOT} projectId="proj-1" projectName="proj" />
      </ArtifactContext.Provider>,
    );
    expect(await screen.findByText(COPY.untitled)).toBeTruthy();
  });
});
