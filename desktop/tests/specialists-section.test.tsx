// @vitest-environment jsdom
/**
 * Fix pass (Task 10 review, finding 2) — Settings -> Specialists used to fire
 * TWO concurrent specialists:list calls on every mount: useSpecialistRoster's
 * own auto-load effect (no ensurePersonalFolder) and SpecialistsSection's own
 * separate mount effect (ensurePersonalFolder: true), racing each other —
 * whichever wrote the cache last won, a timing assumption rather than a
 * guarantee. Consolidated into the ONE auto-load effect the hook already
 * runs, now parameterized by ensurePersonalFolder (see useSpecialists.ts).
 * This pins: mounting the section issues exactly one specialists.list call,
 * carrying ensurePersonalFolder: true.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor, fireEvent, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import React from 'react';
import SpecialistsSection from '../src/renderer/components/SpecialistsSection';

afterEach(() => { cleanup(); delete (window as any).claude; });

function mockClaude(list: ReturnType<typeof vi.fn>) {
  (window as any).claude = {
    specialists: {
      list,
      getDelegatedModels: vi.fn().mockResolvedValue({ budget: null, frontier: null }),
      setDelegatedModel: vi.fn(),
    },
    // ModelPicker (rendered by the two tier rows) reads these on mount.
    providers: {
      list: vi.fn().mockResolvedValue([]),
      catalog: vi.fn().mockResolvedValue([]),
    },
    shell: { openPath: vi.fn() },
  };
}

describe('SpecialistsSection mount', () => {
  it('issues exactly one specialists.list call, ensuring the personal folder — not two racing calls', async () => {
    const list = vi.fn().mockResolvedValue({
      definitions: [], skipped: [], folders: { personal: '/p', claudeUser: '/c' },
    });
    mockClaude(list);

    render(<SpecialistsSection cwd="cwd-settings-mount-once" />);

    await waitFor(() => expect(list).toHaveBeenCalled());
    // Give a second, racing call a chance to land before asserting the count.
    await new Promise((r) => setTimeout(r, 30));
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({ cwd: 'cwd-settings-mount-once', ensurePersonalFolder: true });
  });

  // Task 10 review, fix pass 2 — the reachable broken state: the roster cache
  // is a module-level Map that lives for the renderer process, never cleared.
  // Settings genuinely unmounts/remounts on every open (the dialog returns
  // null when closed), so a SECOND mount for a cwd whose cache is already
  // 'ready' must still re-ensure — otherwise Open folder stays enabled (it's
  // gated on a computed path, not on the folder existing) and silently does
  // nothing for a folder that was never created, or was deleted and the
  // stale cache entry never noticed.
  it('re-ensures the personal folder on a second mount even though the cache is already warm', async () => {
    const list = vi.fn().mockResolvedValue({
      definitions: [], skipped: [], folders: { personal: '/p', claudeUser: '/c' },
    });
    mockClaude(list);
    const cwd = 'cwd-settings-remount-warm';

    const first = render(<SpecialistsSection cwd={cwd} />);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    first.unmount();

    render(<SpecialistsSection cwd={cwd} />);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(list).toHaveBeenLastCalledWith({ cwd, ensurePersonalFolder: true });
  });
});

describe('Open folder', () => {
  it('surfaces the real error string when shell.openPath resolves with one, instead of failing silently', async () => {
    const list = vi.fn().mockResolvedValue({
      definitions: [], skipped: [],
      folders: { personal: '/p', claudeUser: '/c' },
    });
    mockClaude(list);
    (window as any).claude.shell.openPath = vi.fn().mockResolvedValue('Access is denied.');

    render(<SpecialistsSection cwd="cwd-open-folder-fails" />);
    const button = await screen.findByRole('button', { name: 'Open folder' });
    fireEvent.click(button);

    await waitFor(() => expect(screen.getByText('Access is denied.')).toBeInTheDocument());
    expect((window as any).claude.shell.openPath).toHaveBeenCalledWith('/p');
  });

  it('shows nothing when shell.openPath resolves with the empty-string success value', async () => {
    const list = vi.fn().mockResolvedValue({
      definitions: [], skipped: [],
      folders: { personal: '/p', claudeUser: '/c' },
    });
    mockClaude(list);
    (window as any).claude.shell.openPath = vi.fn().mockResolvedValue('');

    render(<SpecialistsSection cwd="cwd-open-folder-succeeds" />);
    const button = await screen.findByRole('button', { name: 'Open folder' });
    fireEvent.click(button);

    await waitFor(() => expect((window as any).claude.shell.openPath).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
