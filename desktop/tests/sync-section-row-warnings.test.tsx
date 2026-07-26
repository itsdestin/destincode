// @vitest-environment jsdom
// sync-section-row-warnings.test.tsx
// Regression test for the Settings → "Backup & Sync" row freezing on the
// warnings it read at APP LAUNCH (reported by Destin 2026-07-26).
//
// The row lives in SyncSection, which mounts with the app — DesktopSettings
// renders unconditionally inside the always-mounted, translate-hidden settings
// drawer — and fetches getSyncStatus() exactly once, 350ms in. That fetch lands
// ~35s BEFORE SyncService.runHealthCheck() finishes rewriting
// ~/.claude/.sync-warnings.json, so the row captures the PREVIOUS session's
// warnings and then never refetches: its status:data handler patched only the
// recency fields, and the popup's refreshStatus only auto-fires when the LEGACY
// .sync-marker epoch advances (a file that doesn't exist on a spaces-only
// install). Result: red "Sync Failing · 2" for the whole app run while the
// popup two clicks away reads green "All synced" off a fresh fetch.
//
// The fix takes warnings from the same authoritative 10s status:data push that
// App.tsx's gear danger-dot already uses (buildStatusData reads the warnings
// file every cycle). These tests pin BOTH directions — a push must be able to
// clear a stale warning AND raise a fresh one.

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, cleanup, waitFor } from '@testing-library/react';
import SyncSection from '../src/renderer/components/SyncPanel';

// Two danger warnings — the pair runHealthCheck leaves behind when a launch
// finds no network and no legacy backend (OFFLINE + PERSONAL_NOT_CONFIGURED),
// which is exactly what the reported row was showing.
const STALE_WARNINGS = [
  {
    code: 'OFFLINE', level: 'danger', title: 'No internet',
    body: "Can't reach the network.", dismissible: true, createdEpoch: 1,
  },
  {
    code: 'PERSONAL_NOT_CONFIGURED', level: 'danger', title: 'No sync configured',
    body: "Your backups aren't set up.", dismissible: false, createdEpoch: 1,
  },
];

function syncStatus(warnings: any[]) {
  return {
    backends: [],
    lastSyncEpoch: null,
    backupMeta: null,
    warnings,
    syncInProgress: false,
    syncingBackendId: null,
    syncedCategories: [],
    lastSyncByDevice: {},
  };
}

// A healthy spaces-only install: sync on, Personal provisioned and synced —
// the state that makes the popup's box read green "All synced".
function spacesStatus() {
  return {
    enabled: true,
    syncHub: 'connected',
    spaces: [{
      id: 'personal', root: '/home/u/YouCoded/Personal', kind: 'personal',
      state: 'active', remote: 'https://github.com/u/personal.git',
      lastSyncAt: Date.now(),
    }],
    recentEvents: [],
  };
}

// Captures the status:data subscriber so a test can push a cycle by hand.
let pushStatusData: ((data: any) => void) | null = null;

function installClaudeMock(warnings: any[]) {
  pushStatusData = null;
  (window as any).claude = {
    sync: { getStatus: vi.fn().mockResolvedValue(syncStatus(warnings)) },
    syncSpaces: {
      status: vi.fn().mockResolvedValue(spacesStatus()),
      onEvent: vi.fn().mockReturnValue(() => {}),
    },
    on: {
      statusData: vi.fn((cb: (d: any) => void) => { pushStatusData = cb; return cb; }),
    },
    off: vi.fn(),
  };
}

describe('Settings row — Backup & Sync warnings freshness', () => {
  beforeEach(() => { vi.useRealTimers(); });
  afterEach(() => { cleanup(); delete (window as any).claude; });

  it('shows the launch-time warnings before any push arrives', async () => {
    installClaudeMock(STALE_WARNINGS);
    const { container } = render(<SyncSection />);

    // The mount fetches are deferred 350ms past the settings slide-in.
    await waitFor(() => {
      expect(container.textContent).toContain('Sync Failing');
    }, { timeout: 3000 });
    expect(container.textContent).toContain('2');
  });

  it('clears the row when a status:data push reports the warnings are gone', async () => {
    installClaudeMock(STALE_WARNINGS);
    const { container } = render(<SyncSection />);

    await waitFor(() => {
      expect(container.textContent).toContain('Sync Failing');
    }, { timeout: 3000 });

    // runHealthCheck has since swept both codes and unlinked the file, so the
    // next 10s push carries an empty array — the row must follow it down.
    await act(async () => {
      pushStatusData!({ syncWarnings: [], lastSyncEpoch: null, syncInProgress: false });
    });

    expect(container.textContent).not.toContain('Sync Failing');
    expect(container.textContent).toContain('Last synced');
  });

  it('raises the row when a status:data push reports a NEW danger warning', async () => {
    installClaudeMock([]);
    const { container } = render(<SyncSection />);

    await waitFor(() => {
      expect(container.textContent).toContain('Last synced');
    }, { timeout: 3000 });

    await act(async () => {
      pushStatusData!({ syncWarnings: [STALE_WARNINGS[0]], lastSyncEpoch: null, syncInProgress: false });
    });

    expect(container.textContent).toContain('Sync Failing');
  });

  it('keeps the last-known warnings when a push omits the field entirely', async () => {
    // An older host (remote shim to a pre-fix desktop) sends no syncWarnings.
    // Absent must mean "no news", not "all clear" — same convention as the
    // other fields this handler patches.
    installClaudeMock(STALE_WARNINGS);
    const { container } = render(<SyncSection />);

    await waitFor(() => {
      expect(container.textContent).toContain('Sync Failing');
    }, { timeout: 3000 });

    await act(async () => {
      pushStatusData!({ lastSyncEpoch: null, syncInProgress: false });
    });

    expect(container.textContent).toContain('Sync Failing');
  });
});
