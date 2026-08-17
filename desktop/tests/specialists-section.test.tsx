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
import { render, cleanup, waitFor } from '@testing-library/react';
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
});
