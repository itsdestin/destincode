// @vitest-environment jsdom
// attention-banner.test.tsx
// Covers the provider-config "Open Settings" affordance: the error bubble shows
// a jump-to-Model-Providers button ONLY when the provider error is a
// configuration problem (message contains "Settings → Providers", the phrase
// emitted by main/providers/provider-registry.ts) AND a handler is wired.

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';

import AttentionBanner from '../src/renderer/components/AttentionBanner';

// The literal message provider-registry throws when a provider has no API key.
const CONFIG_ERROR = 'OpenRouter needs an API key — add one in Settings → Providers.';
const RUNTIME_ERROR = 'upstream 502 from the provider';

function openSettingsButton(container: HTMLElement): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === 'Open Settings'
  ) as HTMLButtonElement | undefined ?? null;
}

describe('AttentionBanner — provider-config Open Settings jump', () => {
  afterEach(() => cleanup());

  it('shows "Open Settings" and fires the handler for a provider-config error', () => {
    const onOpenProviderSettings = vi.fn();
    const { container } = render(
      <AttentionBanner state="error" errorMessage={CONFIG_ERROR} onOpenProviderSettings={onOpenProviderSettings} />
    );
    const btn = openSettingsButton(container);
    expect(btn).not.toBeNull();
    fireEvent.click(btn!);
    expect(onOpenProviderSettings).toHaveBeenCalledTimes(1);
  });

  it('does NOT show the button for a generic runtime error', () => {
    const { container } = render(
      <AttentionBanner state="error" errorMessage={RUNTIME_ERROR} onOpenProviderSettings={vi.fn()} />
    );
    expect(openSettingsButton(container)).toBeNull();
  });

  it('does NOT show the button when no handler is wired (e.g. remote client)', () => {
    const { container } = render(
      <AttentionBanner state="error" errorMessage={CONFIG_ERROR} />
    );
    expect(openSettingsButton(container)).toBeNull();
  });
});

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | null {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => b.textContent?.trim() === text,
  ) as HTMLButtonElement | undefined ?? null;
}

describe('AttentionBanner — the stalled card', () => {
  afterEach(() => cleanup());

  it('says the provider MAY have stalled and never names a cause', () => {
    const { container } = render(<AttentionBanner state="stalled" stalledSince={Date.now() - 134_000} />);
    expect(container.textContent).toMatch(/may have stalled/i);
    expect(container.textContent).not.toMatch(/openrouter/i);
    expect(container.textContent).not.toMatch(/network|internet|connection/i);
  });

  it('counts UP from stalledSince', () => {
    const { container } = render(<AttentionBanner state="stalled" stalledSince={Date.now() - 134_000} />);
    expect(container.textContent).toMatch(/2m 14s/);
  });

  it('offers BOTH Retry and Stop, and fires each handler', () => {
    const onRetry = vi.fn();
    const onStop = vi.fn();
    const { container } = render(
      <AttentionBanner state="stalled" stalledSince={Date.now()} onRetry={onRetry} onStop={onStop} />,
    );
    const retry = buttonByText(container, 'Retry');
    const stop = buttonByText(container, 'Stop');
    expect(retry).not.toBeNull();
    expect(stop).not.toBeNull();
    fireEvent.click(retry!);
    fireEvent.click(stop!);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('renders as a destructive (red) card', () => {
    const { container } = render(<AttentionBanner state="stalled" stalledSince={Date.now()} />);
    expect(container.querySelector('.ring-\\[var\\(--destructive\\)\\]')).not.toBeNull();
  });
});
