// @vitest-environment jsdom
// Pins the fix for "UnsavedChangesDialog Escape also fires the app ESC cascade
// underneath" (ROADMAP 2026-07-22). The dialog used to register its own raw
// capture-phase window keydown listener with stopPropagation() — but
// stopPropagation cannot stop OTHER capture listeners on the same target, and
// the EscCloseProvider's handler is exactly that. One Esc press therefore
// cancelled the dialog AND popped the top of the shared Esc stack (closing a
// drawer/popup the user didn't ask to close). The fix routes the dialog's Esc
// through useEscClose so it joins the LIFO stack: one Esc = one close, topmost
// consumer wins. These tests fail against the old raw-listener code.
import React, { useRef } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, act, screen } from '@testing-library/react';
import { EscCloseProvider, useEscClose } from '../../src/renderer/hooks/use-esc-close';
import { useUnsavedGuard } from '../../src/renderer/components/artifact-views/UnsavedChangesDialog';

function pressEsc(): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => { window.dispatchEvent(ev); });
  return ev;
}

// Stands in for any already-open overlay underneath the dialog (drawer, popup…).
function UnderlyingPanel({ onClose }: { onClose: () => void }) {
  useEscClose(true, onClose);
  return null;
}

// Real host path: useUnsavedGuard with a dirty handle renders the real
// UnsavedChangesDialog once guard() is called with a pending navigation.
let openDialog: (action: () => void) => void = () => {};
function Host() {
  const handleRef = useRef({
    dirty: true,
    saveEdit: async () => true,
    cancelEdit: () => {},
  });
  const { guard, dialog } = useUnsavedGuard(handleRef as never, 'notes.md');
  openDialog = guard;
  return <>{dialog}</>;
}

describe('UnsavedChangesDialog Esc joins the shared esc-close stack', () => {
  it('one Esc cancels ONLY the dialog — the overlay underneath stays open', () => {
    const panelClose = vi.fn();
    const pendingAction = vi.fn();
    render(
      <EscCloseProvider>
        <UnderlyingPanel onClose={panelClose} />
        <Host />
      </EscCloseProvider>,
    );
    act(() => { openDialog(pendingAction); });
    expect(screen.getByText('Unsaved changes')).toBeTruthy();

    const ev = pressEsc();

    // The bug: the old raw listener left the dialog off the stack, so the
    // provider popped the underlying panel on the same keypress.
    expect(panelClose).not.toHaveBeenCalled();
    // Esc = Cancel: stay in the editor, do NOT run the pending navigation.
    expect(pendingAction).not.toHaveBeenCalled();
    expect(screen.queryByText('Unsaved changes')).toBeNull();
    // The stack consumed the event, so the chat PTY-interrupt passthrough
    // (which keys off defaultPrevented) won't also fire.
    expect(ev.defaultPrevented).toBe(true);
  });

  it('LIFO: second Esc then closes the underlying overlay', () => {
    const panelClose = vi.fn();
    render(
      <EscCloseProvider>
        <UnderlyingPanel onClose={panelClose} />
        <Host />
      </EscCloseProvider>,
    );
    act(() => { openDialog(() => {}); });

    pressEsc(); // pops the dialog
    expect(panelClose).not.toHaveBeenCalled();
    pressEsc(); // now the panel is topmost
    expect(panelClose).toHaveBeenCalledTimes(1);
  });
});
