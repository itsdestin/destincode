// @vitest-environment jsdom
// use-provider-type.test.tsx — the renderer's provider-type lookup (Sign in
// with ChatGPT, design §4.9 / review R3-4, 2026-09-05).
//
// WHY: the status bar's plan chips and the /usage card decide whose windows a
// native session spends through this hook. It used to cache the provider and
// catalog lists ONCE per page and never let go, so a session started right
// after signing in to ChatGPT showed no chips until the app reloaded. And it
// resolved by model id alone, which two providers can share (models.dev's
// openai list carries the plan's ids). Three rules pinned here:
//   - the cache invalidates on a ChatGPT status transition (via the card) and
//     after a provider write (via ProvidersSection), and mounted hooks re-read;
//   - a miss for a real id earns exactly ONE refetch, then stays quiet;
//   - among rows sharing an id, the 'chatgpt' row wins (interim rule until
//     the session carries its own providerType).
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, screen, act, waitFor, cleanup, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('../src/renderer/hooks/use-provider-type', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/renderer/hooks/use-provider-type')>();
  // A call-through spy: the card and ProvidersSection must CALL it, and the
  // hook tests need the real behaviour behind it.
  return { ...real, invalidateProviderTypeCache: vi.fn(real.invalidateProviderTypeCache) };
});

import { useModelProviderType, resolveProviderType, invalidateProviderTypeCache } from '../src/renderer/hooks/use-provider-type';
import ModelProvidersSection from '../src/renderer/components/ModelProvidersPopup';
import ProvidersSection from '../src/renderer/components/ProvidersSection';

const invalidateSpy = invalidateProviderTypeCache as unknown as ReturnType<typeof vi.fn>;

const chatgptProvider = { id: 'chatgpt', type: 'chatgpt', label: 'ChatGPT', ready: true, builtIn: true, enabled: true, hasKey: true };
const openaiProvider = { id: 'p-openai', type: 'openai', label: 'My key', ready: true, builtIn: false, enabled: true, hasKey: true };

let providers: any[] = [];
let catalog: any[] = [];
const list = vi.fn(async () => providers);
const catalogFn = vi.fn(async () => catalog);

beforeEach(() => {
  providers = [];
  catalog = [];
  list.mockClear();
  catalogFn.mockClear();
  invalidateSpy.mockClear();
  // Each test starts from an empty cache — the module is shared across them.
  invalidateProviderTypeCache();
  invalidateSpy.mockClear();
  (window as any).localStorage = {
    _s: {} as Record<string, string>,
    getItem(k: string) { return this._s[k] ?? null; },
    setItem(k: string, v: string) { this._s[k] = v; },
    removeItem(k: string) { delete this._s[k]; },
  };
  (window as any).claude = {
    native: { supported: true },
    providers: { list, catalog: catalogFn, upsert: vi.fn(async () => 'p-openai'), remove: vi.fn(async () => true), setKey: vi.fn(async () => true), test: async () => ({ ok: true, message: 'ok' }) },
    models: { installed: async () => [], curated: async () => [], onDownloadProgress: () => () => {} },
    engine: { status: async () => null, onInstallProgress: () => () => {}, onStatusChanged: () => () => {} },
    on: { statusData: () => () => {} },
    off: () => {},
    firstRun: { getState: async () => ({ authMode: 'oauth', currentStep: 'COMPLETE' }) },
    search: { list: async () => [] },
    shell: { openExternal: () => {} },
    chatgpt: { supported: true, status: vi.fn(async () => ({ state: 'signed-out' })), signIn: vi.fn(async () => true), signOut: vi.fn(async () => true), cancelSignIn: vi.fn(async () => true) },
  };
});
afterEach(() => cleanup());

describe('invalidation', () => {
  it('re-reads the lists and updates a mounted hook once the plan appears', async () => {
    const { result } = renderHook(() => useModelProviderType('gpt-5.6'));
    // Empty lists: the id is a miss → one initial load plus the one refetch.
    await waitFor(() => expect(catalogFn).toHaveBeenCalledTimes(2));
    expect(result.current).toBeNull();

    // The user signs in: the plan's rows now exist.
    providers = [chatgptProvider];
    catalog = [{ id: 'gpt-5.6', providerId: 'chatgpt', label: 'GPT-5.6' }];
    act(() => { invalidateProviderTypeCache(); });
    await waitFor(() => expect(result.current).toBe('chatgpt'));
    expect(catalogFn).toHaveBeenCalledTimes(3);
    expect(resolveProviderType('gpt-5.6')).toBe('chatgpt');
  });

  it('is triggered by the ChatGPT card on a status transition', async () => {
    const status = (window as any).claude.chatgpt.status as ReturnType<typeof vi.fn>;
    status.mockResolvedValueOnce({ state: 'waiting' });
    status.mockResolvedValue({ state: 'signed-in', email: 'd@example.com', plan: 'free', usage: null });
    render(<ModelProvidersSection autoOpen />);
    // First read → 'waiting' (a mount, not a transition: no invalidation yet).
    expect(await screen.findByText('Waiting for the browser…')).toBeInTheDocument();
    expect(invalidateSpy).not.toHaveBeenCalled();
    // The 1 s poll sees 'signed-in' → a transition → the cache is dropped.
    expect(await screen.findByText('Signed in as d@example.com', {}, { timeout: 3000 })).toBeInTheDocument();
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it('is triggered by the card after a sign-out resolves', async () => {
    const status = (window as any).claude.chatgpt.status as ReturnType<typeof vi.fn>;
    status.mockResolvedValue({ state: 'signed-in', email: 'd@example.com', plan: 'plus', usage: null });
    render(<ModelProvidersSection autoOpen />);
    const signOut = await screen.findByText('Sign out');
    status.mockResolvedValue({ state: 'signed-out' });
    fireEvent.click(signOut);
    expect(await screen.findByText('Not signed in')).toBeInTheDocument();
    expect((window as any).claude.chatgpt.signOut).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalled();
  });

  it('is triggered by ProvidersSection after a successful upsert', async () => {
    providers = [openaiProvider];
    render(<ProvidersSection />);
    const toggle = await screen.findByLabelText('Enable My key');
    fireEvent.click(toggle);
    await waitFor(() => expect((window as any).claude.providers.upsert).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalledTimes(1));
  });

  it('is NOT triggered when the write fails', async () => {
    providers = [openaiProvider];
    (window as any).claude.providers.upsert = vi.fn(async () => { throw new Error('nope'); });
    render(<ProvidersSection />);
    fireEvent.click(await screen.findByLabelText('Enable My key'));
    expect(await screen.findByText('nope')).toBeInTheDocument();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe('a miss refetches exactly once', () => {
  it('reads the lists twice for an unknown id, then stops', async () => {
    const { result, rerender } = renderHook(({ id }) => useModelProviderType(id), { initialProps: { id: 'no-such-model' } });
    await waitFor(() => expect(catalogFn).toHaveBeenCalledTimes(2));
    expect(result.current).toBeNull();
    // Re-rendering, re-mounting and re-resolving must not read again.
    rerender({ id: 'no-such-model' });
    const again = renderHook(() => useModelProviderType('no-such-model'));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(again.result.current).toBeNull();
    expect(catalogFn).toHaveBeenCalledTimes(2);
  });

  it('does not refetch for a null id (a Claude Code session)', async () => {
    renderHook(() => useModelProviderType(null));
    await waitFor(() => expect(catalogFn).toHaveBeenCalledTimes(1));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(catalogFn).toHaveBeenCalledTimes(1);
  });
});

describe('a shared model id', () => {
  it("resolves to the ChatGPT plan's row when one exists", async () => {
    providers = [openaiProvider, chatgptProvider];
    catalog = [
      { id: 'gpt-5.5', providerId: 'p-openai', label: 'GPT-5.5' },
      { id: 'gpt-5.5', providerId: 'chatgpt', label: 'GPT-5.5' },
    ];
    const { result } = renderHook(() => useModelProviderType('gpt-5.5'));
    await waitFor(() => expect(result.current).toBe('chatgpt'));
    expect(resolveProviderType('gpt-5.5')).toBe('chatgpt');
  });

  it('falls back to the first row when no ChatGPT row shares the id', async () => {
    providers = [openaiProvider];
    catalog = [{ id: 'gpt-5.5', providerId: 'p-openai', label: 'GPT-5.5' }];
    const { result } = renderHook(() => useModelProviderType('gpt-5.5'));
    await waitFor(() => expect(result.current).toBe('openai'));
  });
});
