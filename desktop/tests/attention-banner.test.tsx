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
