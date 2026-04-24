// @vitest-environment jsdom
// context-popup.test.tsx — tests for the StatusBar context chip popup.

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import ContextPopup from '../src/renderer/components/ContextPopup';

afterEach(cleanup);

function renderPopup(overrides: Partial<React.ComponentProps<typeof ContextPopup>> = {}) {
  const onClose = vi.fn();
  const onDispatch = vi.fn();
  const defaults: React.ComponentProps<typeof ContextPopup> = {
    open: true,
    onClose,
    sessionId: 'sess-1',
    contextPercent: 72,
    contextTokens: 143_200,
    onDispatch,
  };
  const props = { ...defaults, ...overrides };
  return { ...render(<ContextPopup {...props} />), onClose, onDispatch };
}

describe('ContextPopup — main view', () => {
  it('renders title, percent, tokens, and the high-band hint', () => {
    renderPopup({ contextPercent: 72, contextTokens: 143_200 });
    expect(screen.getByText('Context')).toBeInTheDocument();
    expect(screen.getByText('72%')).toBeInTheDocument();
    expect(screen.getByText(/143,200 tokens remaining/)).toBeInTheDocument();
    expect(screen.getByText(/Plenty of room/i)).toBeInTheDocument();
  });

  it('shows the mid-band hint between 20% and 60%', () => {
    renderPopup({ contextPercent: 35 });
    expect(screen.getByText(/Getting tight/i)).toBeInTheDocument();
  });

  it('shows the low-band hint under 20%', () => {
    renderPopup({ contextPercent: 8 });
    expect(screen.getByText(/Very low/i)).toBeInTheDocument();
  });

  it('omits the tokens line when contextTokens is null', () => {
    renderPopup({ contextTokens: null });
    expect(screen.queryByText(/tokens remaining/)).toBeNull();
  });

  it('returns null when open is false', () => {
    const { container } = renderPopup({ open: false });
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});
