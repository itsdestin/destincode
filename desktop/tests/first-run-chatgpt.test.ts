// @vitest-environment jsdom
//
// Pins the first-run wizard's "Log in with ChatGPT" half (design
// docs/active/specs/2026-09-05-chatgpt-signin-backend-design.md §5, §8):
//
//   - FirstRunManager.handleChatGptLogin: the waiting line, then every outcome
//     of the browser round-trip — signed-in finishes setup exactly like the
//     Claude path; timed-out / cancelled / { error } put the buttons back with
//     one accurate line; a THROW from signIn() (port 1455 held, no keychain) is
//     folded into lastError verbatim (review R3-3 — both IPC handlers swallow
//     throws, so without this the button would silently do nothing).
//   - handleOpenRouterNotBuilt: the approved card's OpenRouter button must not
//     be silent (review R1-6).
//   - FirstRunView's completion path: a ChatGPT-only install remembers 'native'
//     as its runtime default and seeds the model picker with the plan's first
//     model only when the catalog already has one (review R2-12) — and never
//     blocks the hand-off to the app on the catalog.
//   - The ChatGPT button vanishes under the kill switch (chatgpt.supported).
//
// The late launch-time auth check (main.ts) is pinned elsewhere — not here.
import React from 'react';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup, waitFor, act } from '@testing-library/react';
import type { FirstRunState } from '../src/shared/first-run-types';
import { INITIAL_PREREQUISITES } from '../src/shared/first-run-types';

// FirstRunManager persists its state under ~/.claude/toolkit-state at every
// transition. Point homedir at a scratch directory so the test never reads or
// writes the real wizard state on this machine. The path is computed inside
// the factory (vi.mock is hoisted above every top-level const).
vi.mock('os', async (importOriginal) => {
  const real = await importOriginal<typeof import('os')>();
  const pathMod = await import('path');
  const home = pathMod.join(real.tmpdir(), `first-run-chatgpt-test-home-${process.pid}`);
  return { ...real, default: { ...real, homedir: () => home }, homedir: () => home };
});
vi.mock('../src/main/logger', () => ({ log: vi.fn() }));
// prerequisite-installer imports 'electron'; nothing in it is exercised here.
vi.mock('../src/main/prerequisite-installer', () => ({
  detectNode: vi.fn(), detectGit: vi.fn(), detectClaude: vi.fn(), detectAuth: vi.fn(),
  installNode: vi.fn(), installGit: vi.fn(), installClaude: vi.fn(),
  startOAuthLogin: vi.fn(), pollAuthStatus: vi.fn(), submitApiKey: vi.fn(),
  checkDiskSpace: vi.fn(), checkWindowsDevMode: vi.fn(), enableWindowsDevMode: vi.fn(),
}));

import { FirstRunManager, CHATGPT_FIRST_RUN_TIMEOUT_MS } from '../src/main/first-run';
import type { ChatGptSignInAuth } from '../src/main/first-run';
import FirstRunView from '../src/renderer/components/FirstRunView';

const SCRATCH_HOME = join(tmpdir(), `first-run-chatgpt-test-home-${process.pid}`);

// The two sentences ChatGptAuth.signIn() throws (chatgpt-auth.ts), copied so
// this file need not load the account machine (it imports 'electron').
const PORT_HELD =
  'Port 1455 is already in use on this computer, so YouCoded cannot receive the sign-in. ' +
  'Close the other program using it (often the Codex CLI) and try again.';
const NO_KEYCHAIN =
  'Secure key storage is not available on this system, so YouCoded cannot save API keys. (Your OS keychain/libsecret is required.)';

type Outcome = Awaited<ReturnType<ChatGptSignInAuth['waitForSignIn']>>;

/** A two-method stand-in for ChatGptAuth. `signIn` resolves true unless told
 *  to throw; `waitForSignIn` answers the scripted outcome. */
function fakeAuth(outcome: Outcome, opts: { throwOnSignIn?: string } = {}) {
  const signIn = vi.fn(async (_o?: { timeoutMs?: number }) => {
    if (opts.throwOnSignIn) throw new Error(opts.throwOnSignIn);
    return true;
  });
  const waitForSignIn = vi.fn(async () => outcome);
  // A token-shaped method the wizard must never reach for.
  const accessToken = vi.fn(async () => 'sk-secret-never-read');
  return { signIn, waitForSignIn, accessToken };
}

function managerAtAuth(): FirstRunManager {
  const m = new FirstRunManager();
  m.forceStep('AUTHENTICATE');
  return m;
}

function authPrereq(m: FirstRunManager) {
  return m.getState().prerequisites.find((p) => p.name === 'auth')!;
}

beforeEach(() => { rmSync(SCRATCH_HOME, { recursive: true, force: true }); });
afterEach(() => { rmSync(SCRATCH_HOME, { recursive: true, force: true }); });

describe('FirstRunManager.handleChatGptLogin', () => {
  it('shows the waiting line and marks auth in progress before the browser opens, with the 5-minute window', async () => {
    const m = managerAtAuth();
    let seen: FirstRunState | null = null;
    const auth = fakeAuth('cancelled');
    // Deep copy: getState() is a shallow copy whose prerequisites array is the
    // live one, and the outcome that follows mutates it.
    auth.signIn.mockImplementation(async () => { seen = JSON.parse(JSON.stringify(m.getState())); return true; });

    await m.handleChatGptLogin(auth);

    expect(seen).not.toBeNull();
    expect(seen!.authMode).toBe('chatgpt');
    expect(seen!.statusMessage).toBe('Waiting for you to sign in…');
    expect(seen!.prerequisites.find((p) => p.name === 'auth')!.status).toBe('installing');
    expect(auth.signIn).toHaveBeenCalledWith({ timeoutMs: 300_000 });
    expect(CHATGPT_FIRST_RUN_TIMEOUT_MS).toBe(300_000);
    // The scratch home really is where state went — not Destin's ~/.claude.
    expect(existsSync(join(SCRATCH_HOME, '.claude', 'toolkit-state', 'first-run-state.json'))).toBe(true);
  });

  it("signed-in → auth installed, launch-wizard emitted, COMPLETE, and authMode stays 'chatgpt' for the renderer", async () => {
    const m = managerAtAuth();
    const launched = vi.fn();
    m.on('launch-wizard', launched);
    const auth = fakeAuth('signed-in');

    await m.handleChatGptLogin(auth);

    const s = m.getState();
    expect(s.authComplete).toBe(true);
    expect(authPrereq(m).status).toBe('installed');
    expect(s.currentStep).toBe('COMPLETE');
    expect(s.authMode).toBe('chatgpt');
    expect(s.lastError).toBeUndefined();
    expect(launched).toHaveBeenCalledTimes(1);
    expect(auth.waitForSignIn).toHaveBeenCalledTimes(1);
    // Never a token: the wizard neither asks for one nor stores one.
    expect(auth.accessToken).not.toHaveBeenCalled();
    expect(JSON.stringify(s)).not.toContain('sk-secret');
  });

  it("timed-out → authMode 'none', 'Sign-in timed out. Try again?', auth failed, still on AUTHENTICATE", async () => {
    const m = managerAtAuth();
    await m.handleChatGptLogin(fakeAuth('timed-out'));
    const s = m.getState();
    expect(s.authMode).toBe('none');
    expect(s.lastError).toBe('Sign-in timed out. Try again?');
    expect(s.authComplete).toBe(false);
    expect(s.currentStep).toBe('AUTHENTICATE');
    expect(authPrereq(m).status).toBe('failed');
  });

  it("cancelled → 'Sign-in was cancelled.'", async () => {
    const m = managerAtAuth();
    await m.handleChatGptLogin(fakeAuth('cancelled'));
    const s = m.getState();
    expect(s.authMode).toBe('none');
    expect(s.lastError).toBe('Sign-in was cancelled.');
    expect(authPrereq(m).status).toBe('failed');
  });

  it('{ error } → that text, verbatim', async () => {
    const m = managerAtAuth();
    const text = 'YouCoded could not save the sign-in: the keychain vanished mid-flow';
    await m.handleChatGptLogin(fakeAuth({ error: text }));
    const s = m.getState();
    expect(s.authMode).toBe('none');
    expect(s.lastError).toBe(text);
    expect(authPrereq(m).status).toBe('failed');
    expect(authPrereq(m).error).toBe(text);
  });

  it('a throw from signIn() (port 1455 held) → lastError is the thrown sentence verbatim and the wait never starts (R3-3)', async () => {
    const m = managerAtAuth();
    const auth = fakeAuth('signed-in', { throwOnSignIn: PORT_HELD });
    await expect(m.handleChatGptLogin(auth)).resolves.toBeUndefined();
    const s = m.getState();
    expect(s.authMode).toBe('none');
    expect(s.lastError).toBe(PORT_HELD);
    expect(s.authComplete).toBe(false);
    expect(authPrereq(m).status).toBe('failed');
    expect(auth.waitForSignIn).not.toHaveBeenCalled();
  });

  it('a throw from signIn() (no keychain) → the store\'s own sentence, verbatim', async () => {
    const m = managerAtAuth();
    await m.handleChatGptLogin(fakeAuth('signed-in', { throwOnSignIn: NO_KEYCHAIN }));
    expect(m.getState().lastError).toBe(NO_KEYCHAIN);
    expect(m.getState().authMode).toBe('none');
  });
});

describe('FirstRunManager.handleOpenRouterNotBuilt', () => {
  it("answers the approved card's OpenRouter button with its one line (R1-6)", () => {
    const m = managerAtAuth();
    m.handleOpenRouterNotBuilt();
    const s = m.getState();
    expect(s.lastError).toBe('OpenRouter sign-in is coming in a later update.');
    expect(s.authMode).toBe('none');
    expect(s.currentStep).toBe('AUTHENTICATE');
  });
});

// ---------------------------------------------------------------------------
// FirstRunView — completion path and the kill-switch gate
// ---------------------------------------------------------------------------

// jsdom exposes no usable `localStorage` here (same as runtime-default.test.tsx),
// and RuntimeBinding writes the bare global, so stand up a Map-backed one.
beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true, writable: true,
    value: {
      getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
      clear: () => { store.clear(); },
    },
  });
});

function viewState(overrides: Partial<FirstRunState>): FirstRunState {
  return {
    currentStep: 'AUTHENTICATE',
    prerequisites: INITIAL_PREREQUISITES.map((p) => ({ ...p })),
    overallProgress: 72,
    statusMessage: 'Sign in to continue',
    authMode: 'none',
    authComplete: false,
    needsDevMode: false,
    ...overrides,
  };
}

/** Installs a window.claude with just what FirstRunView touches. */
function stubClaude(opts: {
  state: FirstRunState;
  catalog?: () => Promise<unknown>;
  chatgptSupported?: boolean;
}) {
  const firstRun = {
    getState: vi.fn(async () => opts.state),
    onStateChanged: vi.fn(() => () => {}),
    startAuth: vi.fn(), submitApiKey: vi.fn(), retry: vi.fn(), devModeDone: vi.fn(),
  };
  const catalog = vi.fn(opts.catalog ?? (async () => []));
  (window as any).claude = {
    firstRun,
    off: vi.fn(),
    providers: { catalog },
    ...(opts.chatgptSupported === undefined ? {} : { chatgpt: { supported: opts.chatgptSupported } }),
  };
  return { firstRun, catalog };
}

describe('FirstRunView completion path (authMode chatgpt)', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    delete (window as any).claude;
  });

  it("writes youcoded-runtime-default='native' and the chatgpt binding when the catalog has a chatgpt row", async () => {
    const { catalog } = stubClaude({
      state: viewState({ currentStep: 'COMPLETE', authMode: 'chatgpt', authComplete: true }),
      catalog: async () => [
        { id: 'claude-x', providerId: 'anthropic', label: 'Claude' },
        { id: 'gpt-5-codex', providerId: 'chatgpt', label: 'GPT-5 Codex' },
        { id: 'gpt-5-mini', providerId: 'chatgpt', label: 'GPT-5 mini' },
      ],
    });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    await waitFor(() => expect(localStorage.getItem('youcoded-last-binding')).not.toBeNull());
    expect(localStorage.getItem('youcoded-runtime-default')).toBe('native');
    // The FIRST chatgpt row, not the first row of any provider.
    expect(JSON.parse(localStorage.getItem('youcoded-last-binding')!)).toEqual({ providerId: 'chatgpt', modelId: 'gpt-5-codex' });
    expect(catalog).toHaveBeenCalledTimes(1);
  });

  it('writes only the runtime key when the catalog has no chatgpt row yet (the refresh may still be in flight)', async () => {
    const { catalog } = stubClaude({
      state: viewState({ currentStep: 'COMPLETE', authMode: 'chatgpt', authComplete: true }),
      catalog: async () => [{ id: 'claude-x', providerId: 'anthropic', label: 'Claude' }],
    });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    await waitFor(() => expect(catalog).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(localStorage.getItem('youcoded-runtime-default')).toBe('native');
    expect(localStorage.getItem('youcoded-last-binding')).toBeNull();
  });

  it('still hands off to the app when the catalog rejects — the runtime key is written, nothing throws', async () => {
    const onComplete = vi.fn();
    stubClaude({
      state: viewState({ currentStep: 'COMPLETE', authMode: 'chatgpt', authComplete: true }),
      catalog: async () => { throw new Error('provider registry not ready'); },
    });
    render(React.createElement(FirstRunView, { onComplete }));

    await waitFor(() => expect(localStorage.getItem('youcoded-runtime-default')).toBe('native'));
    expect(localStorage.getItem('youcoded-last-binding')).toBeNull();
    // The existing 1.5 s hand-off timer is untouched by the catalog failure.
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1), { timeout: 4000 });
  });

  it('writes neither key for a completion through Claude (authMode oauth) — existing users see no change', async () => {
    const { catalog } = stubClaude({
      state: viewState({ currentStep: 'COMPLETE', authMode: 'oauth', authComplete: true }),
      catalog: async () => [{ id: 'gpt-5-codex', providerId: 'chatgpt', label: 'GPT-5 Codex' }],
    });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    await waitFor(() => expect(screen.getByText("You're all set.")).toBeTruthy());
    await act(async () => { await Promise.resolve(); });
    expect(localStorage.getItem('youcoded-runtime-default')).toBeNull();
    expect(localStorage.getItem('youcoded-last-binding')).toBeNull();
    expect(catalog).not.toHaveBeenCalled();
  });
});

describe('FirstRunView — the ChatGPT button and the kill switch', () => {
  afterEach(() => {
    cleanup();
    delete (window as any).claude;
  });

  it('hides "Log in with ChatGPT" when chatgpt.supported is false; the other two plans stay', async () => {
    stubClaude({ state: viewState({}), chatgptSupported: false });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    await waitFor(() => expect(screen.getByText('Log in with Claude')).toBeTruthy());
    expect(screen.queryByText('Log in with ChatGPT')).toBeNull();
    expect(screen.getByText('Log in with OpenRouter')).toBeTruthy();
  });

  it('hides it when the chatgpt namespace is missing entirely (old preload, remote shim)', async () => {
    stubClaude({ state: viewState({}) });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    await waitFor(() => expect(screen.getByText('Log in with Claude')).toBeTruthy());
    expect(screen.queryByText('Log in with ChatGPT')).toBeNull();
  });

  it('shows it when chatgpt.supported is true, and the click starts the chatgpt auth mode', async () => {
    const { firstRun } = stubClaude({ state: viewState({}), chatgptSupported: true });
    render(React.createElement(FirstRunView, { onComplete: vi.fn() }));

    const button = await screen.findByText('Log in with ChatGPT');
    button.click();
    expect(firstRun.startAuth).toHaveBeenCalledWith('chatgpt');
  });
});
