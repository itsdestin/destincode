// @vitest-environment jsdom
// engine-card-update.test.tsx
// Pins the ONLY route an already-installed engine has to a newer pinned build.
//
// WHY this test exists (2026-08-27): bumping ENGINE_VERSION upgrades nobody on
// its own. EngineAcquisition.installed() falls back to any complete install it
// finds, so an existing b-number keeps serving forever, and the "Install" button
// is hidden the moment ANY engine is present. A user whose model needs a newer
// llama.cpp (qwen4exp did) had no way to get one from the UI. If this test goes
// red, a pin bump has silently become a no-op again.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup, waitFor, fireEvent } from '@testing-library/react';
import EngineCard from '../src/renderer/components/EngineCard';

function mountClaude(status: Record<string, unknown>, install = vi.fn(async () => status)) {
  (globalThis as any).window.claude = {
    engine: {
      status: vi.fn(async () => status),
      install,
      restart: vi.fn(async () => status),
      onInstallProgress: vi.fn(() => () => {}),
      onStatusChanged: vi.fn(() => () => {}),
    },
    models: { setBackend: vi.fn(async () => {}) },
  };
  return install;
}

const installed = (version: string, pinned: string) => ({
  installed: true,
  installedVersion: version,
  pinnedVersion: pinned,
  backend: 'vulkan',
  state: 'stopped' as const,
  cacheDir: '/cache',
  contextSize: 32768,
});

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

describe('EngineCard — engine update route', () => {
  beforeEach(() => { vi.restoreAllMocks(); });
  afterEach(() => { cleanup(); });

  it('offers Update when the installed engine is older than the pinned one', async () => {
    mountClaude(installed('b9992', 'b10665'));
    const { getByText } = render(<EngineCard />);
    await flush();
    await waitFor(() => expect(getByText('Update')).toBeTruthy());
    // The copy must say what the update is FOR — a bare version number tells a
    // non-developer nothing about whether they need it.
    expect(getByText(/won't load/i)).toBeTruthy();
  });

  it('Update calls engine.install(), which fetches the PINNED build', async () => {
    const install = mountClaude(installed('b9992', 'b10665'));
    const { getByText } = render(<EngineCard />);
    await flush();
    await waitFor(() => expect(getByText('Update')).toBeTruthy());
    await act(async () => { fireEvent.click(getByText('Update')); });
    expect(install).toHaveBeenCalledTimes(1);
  });

  it('offers nothing when the installed engine already matches the pin', async () => {
    mountClaude(installed('b10665', 'b10665'));
    const { queryByText } = render(<EngineCard />);
    await flush();
    expect(queryByText('Update')).toBeNull();
    expect(queryByText('Install')).toBeNull();
  });

  it('still shows Install — not Update — when nothing is installed', async () => {
    mountClaude({
      installed: false, installedVersion: null, pinnedVersion: 'b10665',
      backend: null, state: 'not-installed' as const, cacheDir: '/cache', contextSize: 32768,
    });
    const { getByText, queryByText } = render(<EngineCard />);
    await flush();
    await waitFor(() => expect(getByText('Install')).toBeTruthy());
    expect(queryByText('Update')).toBeNull();
  });
});
