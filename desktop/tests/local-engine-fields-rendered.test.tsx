// @vitest-environment jsdom
// local-engine-fields-rendered.test.tsx — the five pieces of text main computes
// and the screens did not draw (T23, design §H / R3-24).
//
// WHY THIS FILE EXISTS. Every field below was already being produced by the
// backend and thrown away by the renderer, which is invisible in every other
// kind of test: types pass, main's own tests pass, and the user simply never
// finds out. Each guard therefore comes in a PAIR — the text appears when the
// field is set, and it is ABSENT when the field is not there at all. Absence,
// not zero: this feature already shipped a guard that passed because a timeout
// produced the same value as success.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent, act, screen, waitFor } from '@testing-library/react';
import { SizeLine, LocalModelRow } from '../src/renderer/components/LocalModelsSection';
import EngineCard from '../src/renderer/components/EngineCard';
import type { FitEstimate, InstalledLocalModel, StoredModelSettings } from '../src/shared/model-manager-types';

// The exact sentence the contract signs off (R8). It is written ONCE, in
// fit-estimator.ts; the renderer only passes it through. Hard-coded here so a
// reworded estimator has to come past this test.
const ADVICE = "Lower this model's context length in its Settings to shrink this.";

// A 4B-class model at the engine's 32k default: 2.4 GB of weights, 1.6 GB of
// context memory.
const MODEL_BYTES = 2_580_000_000;
const CONTEXT_BYTES = 1_744_830_464;

function quantWith(breakdown: Partial<NonNullable<FitEstimate['breakdown']>>, fit: FitEstimate['fit'] = 'tight') {
  return {
    totalSizeBytes: MODEL_BYTES,
    quant: 'UD-Q4_K_XL',
    fit: {
      fit,
      label: 'Will be tight — close other apps first',
      breakdown: { modelBytes: MODEL_BYTES, contextBytes: CONTEXT_BYTES, contextLength: 32768, ...breakdown },
    } as FitEstimate,
  };
}

/** Hover the dotted number to open the breakdown bubble. */
function openBubble() {
  fireEvent.mouseEnter(screen.getByLabelText(/is made of$/));
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('the size breakdown bubble', () => {
  it('R8: ends with the estimator’s advice when the verdict carries one', () => {
    render(<SizeLine q={quantWith({ advice: ADVICE })} />);
    openBubble();
    expect(screen.getByText(ADVICE)).toBeTruthy();
  });

  it('R8: has NO advice line when the estimator sent none', () => {
    render(<SizeLine q={quantWith({}, 'fits')} />);
    openBubble();
    // The bubble really is open — otherwise "no advice" would pass for a bubble
    // that never rendered anything at all.
    expect(screen.getByText('Model file')).toBeTruthy();
    expect(screen.queryByText(ADVICE)).toBeNull();
  });

  it('R1-25: says "up to" for the context share when it is an upper bound', () => {
    render(<SizeLine q={quantWith({ contextBytesIsUpperBound: true })} />);
    openBubble();
    expect(screen.getByText('includes up to 1.6 GB for a 32k context')).toBeTruthy();
  });

  it('R1-25: states the context share exactly when it is a reading', () => {
    render(<SizeLine q={quantWith({})} />);
    openBubble();
    expect(screen.getByText('includes 1.6 GB for a 32k context')).toBeTruthy();
    expect(screen.queryByText(/up to/)).toBeNull();
  });
});

// ── A model's own Settings dialog ────────────────────────────────────────────

const COMPLETE: InstalledLocalModel = {
  id: 'gemma-4-E4B-it-UD-Q4_K_XL', sizeBytes: MODEL_BYTES,
  quant: 'UD-Q4_K_XL', quantDescription: 'Balanced', parts: 1, status: 'complete',
  partsPresent: 1, totalSizeBytes: MODEL_BYTES, repo: 'unsloth/gemma-4-E4B-it-GGUF',
};

const SETTINGS: StoredModelSettings = {
  contextLength: null, keepLoaded: false, gpuLayers: 'auto', extraFlags: '', memoryWarningDismissed: null,
};

/** Mount the row with a stubbed models API and open its Settings dialog. */
async function openSettings(settings: StoredModelSettings) {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.claude = {
    models: {
      settings: vi.fn().mockResolvedValue(settings),
      setSettings: vi.fn().mockResolvedValue(settings),
      delete: vi.fn().mockResolvedValue(true),
      downloadCancel: vi.fn().mockResolvedValue(true),
      onDownloadProgress: vi.fn().mockReturnValue(() => {}),
    },
  };
  render(<LocalModelRow model={COMPLETE} onRefresh={async () => {}} />);
  await act(async () => { fireEvent.click(screen.getByLabelText(/^Settings for /)); });
  // The dialog fetches asynchronously; nothing below is meaningful until the
  // settings have landed and the rows exist.
  await waitFor(() => expect(screen.getByText('Context length')).toBeTruthy());
}

describe('a model’s settings dialog', () => {
  it('R26: shows why the model last failed to load, in the ENGINE’S own words', async () => {
    await openSettings({ ...SETTINGS, lastLoadError: 'error: invalid argument: --tempp' });
    expect(screen.getByText('This model did not load')).toBeTruthy();
    // Verbatim. A paraphrase would send the user to fix something else.
    expect(screen.getByText('error: invalid argument: --tempp')).toBeTruthy();
  });

  it('R26: shows no load-error card when the model has not failed', async () => {
    await openSettings(SETTINGS);
    expect(screen.queryByText('This model did not load')).toBeNull();
  });

  it('§C2: says a saved change waits for the reply on screen', async () => {
    await openSettings({ ...SETTINGS, keepLoaded: true, pendingApply: true });
    expect(screen.getByText('Applies after the current reply.')).toBeTruthy();
  });

  it('§C2: says nothing about waiting once the change is in force', async () => {
    await openSettings({ ...SETTINGS, keepLoaded: true });
    expect(screen.queryByText('Applies after the current reply.')).toBeNull();
  });
});

// ── The engine card ──────────────────────────────────────────────────────────

const RUNNING = {
  installed: true, installedVersion: 'b10665', pinnedVersion: 'b10665',
  backend: 'vulkan', state: 'running' as const, cacheDir: '/cache', contextSize: 32768,
  speed: { speculative: true, compressCache: true },
};

function mountEngine(status: Record<string, unknown>) {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.claude = {
    engine: {
      status: vi.fn(async () => status),
      install: vi.fn(async () => status),
      restart: vi.fn(async () => status),
      setContext: vi.fn(async () => status),
      setConfig: vi.fn(async () => status),
      onInstallProgress: vi.fn(() => () => {}),
      onStatusChanged: vi.fn(() => () => {}),
    },
    models: { setBackend: vi.fn(async () => {}) },
  };
}

/** Render the card with its details and open Advanced, where the settings live. */
async function renderAdvanced(status: Record<string, unknown>) {
  mountEngine(status);
  render(<EngineCard showDetails />);
  await waitFor(() => expect(screen.getByText('Advanced')).toBeTruthy());
  await act(async () => { fireEvent.click(screen.getByText('Advanced')); });
  await waitFor(() => expect(screen.getByTestId('engine-advanced')).toBeTruthy());
}

const NOT_IN_FORCE = 'Each model’s own settings are off right now';

describe('the engine card', () => {
  it('T7: says per-model settings are off when the engine started without them', async () => {
    mountEngine({ ...RUNNING, modelSettingsInForce: false });
    render(<EngineCard showDetails />);
    await waitFor(() => expect(screen.getByText(NOT_IN_FORCE)).toBeTruthy());
    expect(screen.getByText(/running on the engine’s own settings/)).toBeTruthy();
  });

  it('T7: says nothing when those settings ARE in force', async () => {
    mountEngine({ ...RUNNING, modelSettingsInForce: true });
    render(<EngineCard showDetails />);
    await waitFor(() => expect(screen.getByText('Advanced')).toBeTruthy());
    expect(screen.queryByText(NOT_IN_FORCE)).toBeNull();
  });

  it('T7: says nothing when nobody has answered the question', async () => {
    // `undefined` is not `false`. A stopped engine, or a main too old to answer,
    // must not be reported to the user as "your settings are being ignored".
    mountEngine({ ...RUNNING, state: 'stopped' as const });
    render(<EngineCard showDetails />);
    await waitFor(() => expect(screen.getByText('Advanced')).toBeTruthy());
    expect(screen.queryByText(NOT_IN_FORCE)).toBeNull();
  });

  it('§B: says a saved setting waits for the reply on screen', async () => {
    await renderAdvanced({ ...RUNNING, configApplyPending: true });
    expect(screen.getByTestId('engine-apply-pending').textContent).toContain('Applies after the current reply.');
  });

  it('§B: says nothing about waiting when nothing is pending', async () => {
    await renderAdvanced(RUNNING);
    expect(screen.queryByTestId('engine-apply-pending')).toBeNull();
  });

  it('§B: shows the REAL failure when applying a saved setting went wrong', async () => {
    await renderAdvanced({ ...RUNNING, configApplyError: 'EACCES: permission denied, open ’/home/d/.youcoded/engine/models.ini’' });
    expect(screen.getByText(/EACCES: permission denied/)).toBeTruthy();
  });

  it('§B: shows no failure line when applying went fine', async () => {
    await renderAdvanced({ ...RUNNING, configApplyError: null });
    expect(screen.queryByText(/EACCES/)).toBeNull();
  });

  it('draws the speed switches from the status, and NOT from a copy of the defaults', async () => {
    // The card used to fall back to a hardcoded { speculative: true,
    // compressCache: true } — a third copy of a default written down twice in
    // main. It is gone: a status with no `speed` now shows no switches rather
    // than two switches asserting an ON state nobody reported.
    await renderAdvanced({ ...RUNNING, speed: { speculative: false, compressCache: true } });
    expect(screen.getByLabelText('Speculative decoding').getAttribute('aria-checked')).toBe('false');
    expect(screen.getByLabelText('Compress context memory').getAttribute('aria-checked')).toBe('true');

    cleanup();
    const { speed, ...noSpeed } = RUNNING;
    await renderAdvanced(noSpeed);
    expect(screen.queryByLabelText('Speculative decoding')).toBeNull();
    expect(screen.queryByLabelText('Compress context memory')).toBeNull();
  });
});
