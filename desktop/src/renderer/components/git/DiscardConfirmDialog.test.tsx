// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { DiscardConfirmDialog } from './DiscardConfirmDialog';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('DiscardConfirmDialog', () => {
  it('tracked copy states exactly what is restored and confirm fires', () => {
    const onConfirm = vi.fn();
    render(<DiscardConfirmDialog fileName="f.ts" willTrash={false} onConfirm={onConfirm} onCancel={() => {}} />);
    expect(screen.getByText(/Restore “f.ts” to its last committed state\?/)).toBeInTheDocument();
    expect(screen.getByText(/uncommitted edits to this file will be lost/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('never-committed copy says trash, not restore', () => {
    render(<DiscardConfirmDialog fileName="new.ts" willTrash onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/Move “new.ts” to the system trash\?/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete file' })).toBeInTheDocument();
  });

  it('cancel and Escape both close without confirming', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(<DiscardConfirmDialog fileName="f.ts" willTrash={false} onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
