// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import StopButton from './StopButton';

// Mirrors the window.claude mocking idiom from InputBar.test.tsx — only the
// two IPC calls StopButton can actually reach are stubbed.
describe('StopButton', () => {
  beforeEach(() => {
    (window as any).claude = {
      native: { interrupt: vi.fn() },
      session: { sendInput: vi.fn() },
    };
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders nothing when not visible', () => {
    render(<StopButton sessionId="sess-1" provider="native" visible={false} />);
    expect(screen.queryByRole('button', { name: 'Stop generating' })).not.toBeInTheDocument();
  });

  it('renders when visible', () => {
    render(<StopButton sessionId="sess-1" provider="native" visible />);
    expect(screen.getByRole('button', { name: 'Stop generating' })).toBeInTheDocument();
  });

  it('calls native.interrupt for provider="native"', () => {
    render(<StopButton sessionId="sess-1" provider="native" visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }));
    expect((window as any).claude.native.interrupt).toHaveBeenCalledWith('sess-1');
    expect((window as any).claude.session.sendInput).not.toHaveBeenCalled();
  });

  it('sends a single ESC byte for provider="claude"', () => {
    render(<StopButton sessionId="sess-1" provider="claude" visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }));
    expect((window as any).claude.session.sendInput).toHaveBeenCalledWith('sess-1', '\x1b');
    expect((window as any).claude.native.interrupt).not.toHaveBeenCalled();
  });

  it('sends a single ESC byte when provider is undefined (defaults to CC path, same as the ESC handler)', () => {
    render(<StopButton sessionId="sess-1" visible />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop generating' }));
    expect((window as any).claude.session.sendInput).toHaveBeenCalledWith('sess-1', '\x1b');
  });
});
