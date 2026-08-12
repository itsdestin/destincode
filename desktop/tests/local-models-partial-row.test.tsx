// @vitest-environment jsdom
// local-models-partial-row.test.tsx
// Pins the fix for the silent-no-op Resume bug: PartialRow.resume() used to
// swallow the quants() failure in an inner `catch {}` and skip the download
// via `if (opt)` — clicking Resume while Hugging Face was unreachable did
// NOTHING (no error, no state change). It must now render the real failure
// on the row's inline error line, like its siblings (QuantDownloadRow etc).

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act, screen } from '@testing-library/react';

import { PartialRow } from '../src/renderer/components/LocalModelsSection';
import type { DownloadProgress } from '../src/shared/model-manager-types';

// ── Mock helpers ───────────────────────────────────────────────────────────────

function setupModelsMock(overrides: Record<string, any> = {}) {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.claude = {
    models: {
      quants: vi.fn().mockResolvedValue([]),
      download: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      downloadCancel: vi.fn().mockResolvedValue(undefined),
      onDownloadProgress: vi.fn().mockReturnValue(() => {}),
      ...overrides,
    },
  };
  return (globalThis as any).window.claude.models;
}

const dl: DownloadProgress = {
  downloadId: 'dl-1',
  repo: 'unsloth/test-model-GGUF',
  quant: 'Q4_K_M',
  state: 'cancelled',
  receivedBytes: 1073741824,
  totalBytes: 4294967296,
  currentPart: 1,
  parts: 1,
};

function renderRow() {
  return render(
    <PartialRow
      dl={dl}
      quantOptsByKeyRef={{ current: {} }}
      onRefresh={vi.fn().mockResolvedValue(undefined)}
      setDownloads={vi.fn()}
    />
  );
}

async function clickResume() {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /resume/i }));
    await Promise.resolve();
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('PartialRow resume error surfacing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('surfaces the real quants() failure instead of silently no-oping', async () => {
    const models = setupModelsMock({
      quants: vi.fn().mockRejectedValue(new Error('Could not reach huggingface.co')),
    });

    renderRow();
    await clickResume();

    // The real error message reaches the row — not swallowed, not rephrased.
    expect(screen.getByText('Could not reach huggingface.co')).toBeTruthy();
    // And the download was never attempted.
    expect(models.download).not.toHaveBeenCalled();
    // The button recovered from its busy state for a retry.
    expect((screen.getByRole('button', { name: /resume/i }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('explains when the quant is no longer listed for the repo', async () => {
    // quants() answers fine but the partial's quant has vanished from the repo —
    // previously the other silent-no-op path through `if (opt)`.
    const models = setupModelsMock({
      quants: vi.fn().mockResolvedValue([
        { quant: 'Q8_0', description: '', files: ['a.gguf'], totalSizeBytes: 1, sha256ByFile: {}, fit: { fit: 'fits', label: 'Fits' } },
      ]),
    });

    renderRow();
    await clickResume();

    expect(screen.getByText(/no longer listed/i).textContent).toContain('Q4_K_M');
    expect(models.download).not.toHaveBeenCalled();
  });

  it('shows no error and starts the download when resume succeeds', async () => {
    const opt = { quant: 'Q4_K_M', description: '', files: ['m.gguf'], totalSizeBytes: 1, sha256ByFile: {}, fit: { fit: 'fits', label: 'Fits' } };
    const models = setupModelsMock({
      quants: vi.fn().mockResolvedValue([opt]),
    });

    renderRow();
    await clickResume();

    expect(models.download).toHaveBeenCalledWith(dl.repo, opt);
    expect(screen.queryByText(/could not|no longer/i)).toBeNull();
  });

  it('surfaces a download() throw (disk guard / already downloading)', async () => {
    const opt = { quant: 'Q4_K_M', description: '', files: ['m.gguf'], totalSizeBytes: 1, sha256ByFile: {}, fit: { fit: 'fits', label: 'Fits' } };
    setupModelsMock({
      quants: vi.fn().mockResolvedValue([opt]),
      download: vi.fn().mockRejectedValue(new Error('Not enough free disk space to download this model.')),
    });

    renderRow();
    await clickResume();

    expect(screen.getByText('Not enough free disk space to download this model.')).toBeTruthy();
  });
});
