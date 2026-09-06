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

  it('R8: the advice is the LAST thing in the bubble', () => {
    // The contract says the bubble "ends with" it. Moved above the memory
    // figure, every other assertion in this file still passed.
    render(<SizeLine q={quantWith({ advice: ADVICE })} />);
    openBubble();
    const rows = screen.getByText(ADVICE).parentElement as HTMLElement;
    expect((rows.lastElementChild as HTMLElement).textContent).toBe(ADVICE);
  });

  it('R1-25: hedges the RUNNING-MEMORY total too, not just the small print', () => {
    // 2.4 GB of weights + 1.6 GB of context = 4.0 GB. The total contains the
    // estimated term, so stating it exactly is the same fake precision one line
    // lower down — and the total is the number a user actually decides on.
    render(<SizeLine q={quantWith({ contextBytesIsUpperBound: true })} />);
    openBubble();
    expect(screen.getByText('up to 4.0 GB')).toBeTruthy();
    cleanup();
    render(<SizeLine q={quantWith({})} />);
    openBubble();
    expect(screen.getByText('4.0 GB')).toBeTruthy();
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

/** A models API whose reads and saves resolve only when the test says so, so the
 *  order two answers come back in can be driven deliberately. */
function deferredModels(firstRead: StoredModelSettings) {
  const reads: Array<{ resolve: (v: StoredModelSettings) => void; reject: (e: unknown) => void }> = [];
  const saves: Array<(v: StoredModelSettings) => void> = [];
  let readCount = 0;
  const models = {
    settings: vi.fn(() => {
      readCount += 1;
      // The first read resolves at once so the dialog can open; every later one
      // is held for the test.
      if (readCount === 1) return Promise.resolve(firstRead);
      return new Promise<StoredModelSettings>((resolve, reject) => { reads.push({ resolve, reject }); });
    }),
    setSettings: vi.fn(() => new Promise<StoredModelSettings>((resolve) => { saves.push(resolve); })),
    delete: vi.fn().mockResolvedValue(true),
    downloadCancel: vi.fn().mockResolvedValue(true),
    onDownloadProgress: vi.fn().mockReturnValue(() => {}),
  };
  (globalThis as any).window = (globalThis as any).window ?? {};
  (globalThis as any).window.claude = { models };
  return { models, reads, saves };
}

/** Open the dialog on a row whose models API is already installed. */
async function openDialog() {
  render(<LocalModelRow model={COMPLETE} onRefresh={async () => {}} />);
  await act(async () => { fireEvent.click(screen.getByLabelText(/^Settings for /)); });
  await waitFor(() => expect(screen.getByText('Context length')).toBeTruthy());
}

/** Mount the row with a stubbed models API and open its Settings dialog.
 *  `later`, when given, is what every fetch AFTER the first one answers — which
 *  is how a pending save landing in the background is driven. */
async function openSettings(settings: StoredModelSettings, later?: StoredModelSettings) {
  (globalThis as any).window = (globalThis as any).window ?? {};
  let calls = 0;
  (globalThis as any).window.claude = {
    models: {
      settings: vi.fn(async () => (later && calls++ > 0 ? later : settings)),
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

const LOAD_ERROR_TITLE = 'This model failed to load last time';

describe('a model’s settings dialog', () => {
  it('R26: shows why the model last failed to load, in the ENGINE’S own words', async () => {
    await openSettings({ ...SETTINGS, lastLoadError: 'error: invalid argument: --tempp' });
    // "last time": main clears this only on a SUCCESSFUL load, so the card
    // outlives the problem and must not claim the model is broken right now.
    expect(screen.getByText(LOAD_ERROR_TITLE)).toBeTruthy();
    // Verbatim. A paraphrase would send the user to fix something else.
    const line = screen.getByText('error: invalid argument: --tempp');
    expect(line).toBeTruthy();
    // Engine errors carry long unbroken paths; without this they overflow the
    // dialog and hide everything after them.
    expect(line.className).toContain('break-words');
  });

  it('R26: the load-error card is the FIRST thing in the dialog', async () => {
    // Its own WHY comment argues this at length — the extra-flags box that most
    // often causes it is behind a collapsed Advanced row, and a message under
    // that is a message nobody reads. Nothing enforced the position.
    await openSettings({ ...SETTINGS, lastLoadError: 'error: invalid argument: --tempp' });
    const body = screen.getByTestId('model-settings');
    const first = body.firstElementChild as HTMLElement;
    expect(first.textContent).toContain(LOAD_ERROR_TITLE);
  });

  it('R26: opens Advanced when the model failed to load, and leaves it shut otherwise', async () => {
    // The flags box lives inside Advanced. The card above still does NOT name
    // the flags as the cause — an unreadable file and a machine out of memory
    // arrive in exactly the same field.
    await openSettings({ ...SETTINGS, lastLoadError: "error: option '--tempp' not recognized in preset 'x'" });
    expect(screen.getByLabelText('Extra engine flags')).toBeTruthy();
    cleanup();
    await openSettings(SETTINGS);
    expect(screen.queryByLabelText('Extra engine flags')).toBeNull();
  });

  it('R26: shows no load-error card when the model has not failed', async () => {
    await openSettings(SETTINGS);
    expect(screen.queryByText(LOAD_ERROR_TITLE)).toBeNull();
  });

  it('§C2: says a saved change waits for the reply on screen', async () => {
    await openSettings({ ...SETTINGS, keepLoaded: true, pendingApply: true });
    expect(screen.getByText('Applies after the current reply.')).toBeTruthy();
  });

  it('§C2: says nothing about waiting once the change is in force', async () => {
    await openSettings({ ...SETTINGS, keepLoaded: true });
    expect(screen.queryByText('Applies after the current reply.')).toBeNull();
  });

  it('§C2: the waiting line CLEARS once the change lands, without closing the dialog', async () => {
    // There is no push channel for per-model settings, so the dialog re-asks.
    // Fetched once, it would sit there saying "Applies after the current reply"
    // for as long as it is open — the user closes it, reopens it, and concludes
    // the setting never stuck.
    await openSettings(
      { ...SETTINGS, keepLoaded: true, pendingApply: true },
      { ...SETTINGS, keepLoaded: true },
    );
    expect(screen.getByText('Applies after the current reply.')).toBeTruthy();
    await waitFor(
      () => expect(screen.queryByText('Applies after the current reply.')).toBeNull(),
      { timeout: 10_000, interval: 100 },
    );
  });

  it('§C2: re-asking main never wipes what the user is halfway through typing', async () => {
    // The poll re-reads every field. Seeded into the two text drafts on every
    // pass instead of once, a user typing a context length while a save is
    // pending watches it vanish under them two seconds later.
    await openSettings({ ...SETTINGS, contextLength: 8192, pendingApply: true });
    const box = screen.getByLabelText('Context length for this model') as HTMLInputElement;
    fireEvent.change(box, { target: { value: '4096' } });
    await new Promise((r) => setTimeout(r, 2600));
    expect((screen.getByLabelText('Context length for this model') as HTMLInputElement).value).toBe('4096');
  });

  it('§C2: a read already IN FLIGHT cannot undo the switch the user just flipped', async () => {
    // The bug the first version of the poll shipped. Refusing to START a read
    // during a save does nothing about one already in the air: it carries the
    // values main held BEFORE the save and lands after it. What the user saw —
    // "Keep loaded" turns on, flips itself off a moment later, then back on two
    // seconds after that. The setting saved perfectly; only the screen lied.
    const { reads, saves } = deferredModels({ ...SETTINGS, keepLoaded: false });
    await openDialog();
    // A poll goes out, and is still in the air…
    await waitFor(() => expect(reads.length).toBeGreaterThan(0), { timeout: 10_000, interval: 50 });
    // …when the user turns the switch on, and the save comes back first.
    await act(async () => { fireEvent.click(screen.getByLabelText('Keep loaded')); });
    await act(async () => { saves[0]({ ...SETTINGS, keepLoaded: true }); await Promise.resolve(); });
    expect(screen.getByLabelText('Keep loaded').getAttribute('aria-checked')).toBe('true');
    // Now the stale answer lands. It must be thrown away, not drawn.
    await act(async () => { reads[0].resolve({ ...SETTINGS, keepLoaded: false }); await Promise.resolve(); });
    expect(screen.getByLabelText('Keep loaded').getAttribute('aria-checked')).toBe('true');
  });

  it('§C2: two reads in the air, and the SLOWER one cannot win by finishing last', async () => {
    // Whenever a read takes longer than the poll interval there are two of them
    // outstanding, and order of arrival is not order of issue.
    const { reads } = deferredModels({ ...SETTINGS, keepLoaded: false });
    await openDialog();
    await waitFor(() => expect(reads.length).toBeGreaterThanOrEqual(2), { timeout: 10_000, interval: 50 });
    // The NEWER read answers first…
    await act(async () => { reads[1].resolve({ ...SETTINGS, keepLoaded: true }); await Promise.resolve(); });
    expect(screen.getByLabelText('Keep loaded').getAttribute('aria-checked')).toBe('true');
    // …and the older one, arriving late, is ignored.
    await act(async () => { reads[0].resolve({ ...SETTINGS, keepLoaded: false }); await Promise.resolve(); });
    expect(screen.getByLabelText('Keep loaded').getAttribute('aria-checked')).toBe('true');
  });

  it('§C2: one failed read does not leave a red line under a working dialog', async () => {
    // Before the poll this could not happen: the read failed and the dialog
    // stayed on the failure. Now the next read succeeds two seconds later and
    // draws the whole working dialog — with a stale "could not read" line under
    // it for as long as it is open.
    let calls = 0;
    (globalThis as any).window = (globalThis as any).window ?? {};
    (globalThis as any).window.claude = {
      models: {
        settings: vi.fn(async () => {
          calls += 1;
          if (calls === 1) throw new Error('Could not read this model’s settings.');
          return SETTINGS;
        }),
        setSettings: vi.fn().mockResolvedValue(SETTINGS),
        delete: vi.fn().mockResolvedValue(true),
        downloadCancel: vi.fn().mockResolvedValue(true),
        onDownloadProgress: vi.fn().mockReturnValue(() => {}),
      },
    };
    render(<LocalModelRow model={COMPLETE} onRefresh={async () => {}} />);
    await act(async () => { fireEvent.click(screen.getByLabelText(/^Settings for /)); });
    await waitFor(() => expect(screen.getByText('Could not read this model’s settings.')).toBeTruthy());
    await waitFor(
      () => expect(screen.queryByText('Could not read this model’s settings.')).toBeNull(),
      { timeout: 10_000, interval: 100 },
    );
    expect(screen.getByText('Context length')).toBeTruthy();
  });

  it('§C2: a save that FAILS does not freeze the dialog’s live values', async () => {
    // The suppression is released in a `finally`. Left set, one failed save
    // would stop every poll for as long as the dialog stayed open — and the
    // pending line and the load-error card are exactly what the poll is for.
    let calls = 0;
    (globalThis as any).window = (globalThis as any).window ?? {};
    (globalThis as any).window.claude = {
      models: {
        settings: vi.fn(async () => { calls += 1; return calls > 1 ? { ...SETTINGS, lastLoadError: 'error: out of memory' } : SETTINGS; }),
        setSettings: vi.fn().mockRejectedValue(new Error('Disk is full.')),
        delete: vi.fn().mockResolvedValue(true),
        downloadCancel: vi.fn().mockResolvedValue(true),
        onDownloadProgress: vi.fn().mockReturnValue(() => {}),
      },
    };
    await openDialog();
    await act(async () => { fireEvent.click(screen.getByLabelText('Keep loaded')); });
    await waitFor(() => expect(screen.getByText('Disk is full.')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('error: out of memory')).toBeTruthy(), { timeout: 10_000, interval: 100 });
    // …and the save failure is still on screen: it is the user's, not the
    // poll's, and a successful read must not wipe it.
    expect(screen.getByText('Disk is full.')).toBeTruthy();
  });

  it('§C2: no read is even ASKED FOR while a save is in flight', async () => {
    // The check inside the answer catches a read that was already in the air.
    // This is the other half: not starting one at all, so an answer that
    // predates the save's write cannot exist in the first place.
    const { models, saves, reads } = deferredModels({ ...SETTINGS, keepLoaded: false });
    await openDialog();
    const before = models.settings.mock.calls.length;
    await act(async () => { fireEvent.click(screen.getByLabelText('Keep loaded')); });
    await new Promise((r) => setTimeout(r, 2600));     // a poll tick passes
    expect(models.settings.mock.calls.length).toBe(before);
    // …and once the save lands, polling resumes.
    await act(async () => { saves[0]({ ...SETTINGS, keepLoaded: true }); await Promise.resolve(); });
    await waitFor(() => expect(models.settings.mock.calls.length).toBeGreaterThan(before), { timeout: 10_000, interval: 100 });
    expect(reads.length).toBeGreaterThan(0);
  });

  it('§C2: two overlapping saves — the first one finishing does not unblock the poll', async () => {
    // A flag, rather than a count, would have the first save's cleanup announce
    // that nothing is saving while the second is still in the air.
    const { models, saves } = deferredModels({ ...SETTINGS, keepLoaded: false });
    await openDialog();
    const before = models.settings.mock.calls.length;
    await act(async () => { fireEvent.click(screen.getByLabelText('Keep loaded')); });
    // A second, different save while the first is still in the air.
    const box = screen.getByLabelText('Context length for this model');
    await act(async () => { fireEvent.change(box, { target: { value: '8192' } }); fireEvent.blur(box); });
    expect(saves).toHaveLength(2);
    await act(async () => { saves[0]({ ...SETTINGS, keepLoaded: true }); await Promise.resolve(); });
    await new Promise((r) => setTimeout(r, 2600));
    expect(models.settings.mock.calls.length).toBe(before);
  });

  it('§C2: closing the dialog stops the polling, and a late answer changes nothing', async () => {
    const { reads, models } = deferredModels(SETTINGS);
    await openDialog();
    await waitFor(() => expect(reads.length).toBeGreaterThan(0), { timeout: 10_000, interval: 50 });
    cleanup();
    const after = models.settings.mock.calls.length;
    // A late answer to a closed dialog must not try to draw into it.
    await act(async () => { reads[0].resolve({ ...SETTINGS, lastLoadError: 'too late' }); await Promise.resolve(); });
    await new Promise((r) => setTimeout(r, 2600));
    expect(models.settings.mock.calls.length).toBe(after);
    expect(screen.queryByText('too late')).toBeNull();
  });

  it('§C2: a load error that arrives while the dialog is open reaches the user', async () => {
    // Same staleness, other field: a model fails on its next request, and a
    // dialog that read main once would never say so.
    await openSettings(SETTINGS, { ...SETTINGS, lastLoadError: 'error: out of memory' });
    expect(screen.queryByText(LOAD_ERROR_TITLE)).toBeNull();
    await waitFor(
      () => expect(screen.getByText('error: out of memory')).toBeTruthy(),
      { timeout: 10_000, interval: 100 },
    );
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
const OS_ERROR = "EACCES: permission denied, open '/home/d/.youcoded/engine/models.ini'";

describe('the engine card', () => {
  it('T7: says per-model settings are off, and QUOTES the reason it was given', async () => {
    mountEngine({ ...RUNNING, modelSettingsInForce: false, modelSettingsError: OS_ERROR });
    render(<EngineCard showDetails />);
    await waitFor(() => expect(screen.getByText(NOT_IN_FORCE)).toBeTruthy());
    // Both sentences, not just a fragment: what is happening, and that it is not
    // permanent. Deleting either one left every other assertion true.
    expect(screen.getByText(/Every model is running on the engine’s own settings\./)).toBeTruthy();
    expect(screen.getByText(/It tries again the next time the engine starts\./)).toBeTruthy();
    // The OS's own words. `engine-supervisor.ts` used to throw this away in a
    // bare catch, which left the card able to say only "something went wrong".
    const cause = screen.getByText(OS_ERROR);
    expect(cause).toBeTruthy();
    expect(cause.className).toContain('break-words');
    // A cause we HAVE is the specific+accurate shape — no Report bug / Diagnose.
    expect(screen.queryByText('Diagnose with Claude')).toBeNull();
  });

  it('T7: with NO reason available, stays non-committal and offers the two standard actions', async () => {
    // docs/error-message-standards.md: general is allowed, general with an
    // invented cause is not — and a general message with no next step is not
    // either.
    mountEngine({ ...RUNNING, modelSettingsInForce: false, modelSettingsError: null });
    render(<EngineCard showDetails />);
    await waitFor(() => expect(screen.getByText(NOT_IN_FORCE)).toBeTruthy());
    expect(screen.getByText('Report bug')).toBeTruthy();
    expect(screen.getByText('Diagnose with Claude')).toBeTruthy();
    expect(screen.getByText(/gave no reason we can show you/)).toBeTruthy();
  });

  it('T7: the two actions on the no-reason message actually DO something', async () => {
    // Wired to nothing, this is a general error with no next step — which the
    // standard disallows just as firmly as an invented cause. Making
    // "Diagnose with Claude" a no-op left every other assertion green.
    mountEngine({ ...RUNNING, modelSettingsInForce: false, modelSettingsError: null });
    render(<EngineCard showDetails />);
    await waitFor(() => expect(screen.getByText('Diagnose with Claude')).toBeTruthy());
    await act(async () => { fireEvent.click(screen.getByText('Diagnose with Claude')); });
    // The app's one bug-report surface opens — its own dialog title, which
    // nothing else on this card renders.
    await waitFor(() => expect(screen.getByText('Report a bug')).toBeTruthy());
  });

  it('T7: the message is NOT hidden behind the expanded details panel', async () => {
    // `showDetails` is false wherever the card sits outside Local models. Gated
    // on it, this message would never reach anyone who does not open that panel
    // — and it is about their models being silently ignored.
    mountEngine({ ...RUNNING, modelSettingsInForce: false, modelSettingsError: OS_ERROR });
    render(<EngineCard />);
    await waitFor(() => expect(screen.getByText(NOT_IN_FORCE)).toBeTruthy());
    expect(screen.getByText(OS_ERROR)).toBeTruthy();
    // …and the details really are collapsed, so this is not a false pass.
    expect(screen.queryByText('Advanced')).toBeNull();
  });

  it('T7: says nothing when those settings ARE in force', async () => {
    mountEngine({ ...RUNNING, modelSettingsInForce: true });
    render(<EngineCard showDetails />);
    await waitFor(() => expect(screen.getByText('Advanced')).toBeTruthy());
    expect(screen.queryByText(NOT_IN_FORCE)).toBeNull();
  });

  it('T7: says nothing when the engine is not running', async () => {
    // `undefined` is not `false`.
    mountEngine({ ...RUNNING, state: 'stopped' as const });
    render(<EngineCard showDetails />);
    await waitFor(() => expect(screen.getByText('Advanced')).toBeTruthy());
    expect(screen.queryByText(NOT_IN_FORCE)).toBeNull();
  });

  it('T7: says nothing when the engine IS running but the field is absent', async () => {
    // The hazard the three-state field was designed around, and the one case
    // the first version of these tests missed: written as `state === 'running'
    // && !modelSettingsInForce`, everything else here still passed. A remote or
    // Android client on an older desktop is exactly this — running, no answer —
    // and every one of those users would be told their settings are ignored.
    const { modelSettingsInForce, ...noAnswer } = { ...RUNNING, modelSettingsInForce: true };
    mountEngine(noAnswer);
    render(<EngineCard showDetails />);
    await waitFor(() => expect(screen.getByText('Advanced')).toBeTruthy());
    expect(screen.queryByText(NOT_IN_FORCE)).toBeNull();
    expect(screen.queryByText('Diagnose with Claude')).toBeNull();
  });

  it('§B: says a saved setting waits for the reply on screen', async () => {
    await renderAdvanced({ ...RUNNING, configApplyPending: true, configApplyWaitingForReply: true });
    expect(screen.getByTestId('engine-apply-pending').textContent).toContain('Applies after the current reply.');
  });

  it('§B: does NOT blame a reply when the machine is idle', async () => {
    // `configApplyPending` is true from the moment a change is queued, including
    // a restart on a machine with nothing running — where the change lands a
    // poll interval later and there is no reply anywhere in sight.
    await renderAdvanced({ ...RUNNING, configApplyPending: true, configApplyWaitingForReply: false });
    const line = screen.getByTestId('engine-apply-pending').textContent ?? '';
    expect(line).toContain('Applying now');
    expect(line).not.toContain('current reply');
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
