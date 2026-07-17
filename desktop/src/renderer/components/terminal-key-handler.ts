// Clipboard key handling for the terminal view (Ctrl/Cmd+C copy,
// Ctrl/Cmd+V paste). Extracted from TerminalView's mount effect so the
// double-paste regression (2026-07-16) stays pinned by
// tests/terminal-key-handler.test.ts.

// The slice of xterm's Terminal this handler needs — kept minimal so tests can
// fake it without constructing a real terminal.
export interface ClipboardTerminal {
  hasSelection(): boolean;
  getSelection(): string;
  paste(text: string): void;
}

/**
 * Build the handler passed to terminal.attachCustomKeyEventHandler().
 *
 * Ctrl+C copies the selection (if any) instead of sending SIGINT; Ctrl+C with
 * no selection falls through to xterm's default so users can still interrupt
 * a runaway process. Ctrl+V reads the system clipboard and pastes into the
 * PTY. Matches VS Code / Windows Terminal conventions. Shift+Ctrl variants
 * are left alone.
 */
export function createTerminalKeyHandler(terminal: ClipboardTerminal): (e: KeyboardEvent) => boolean {
  return (e: KeyboardEvent): boolean => {
    if (e.type !== 'keydown') return true;
    const mod = e.ctrlKey || e.metaKey;
    if (!mod || e.shiftKey || e.altKey) return true;
    const key = e.key.toLowerCase();
    if (key === 'c' && terminal.hasSelection()) {
      navigator.clipboard.writeText(terminal.getSelection()).catch(() => {});
      return false;
    }
    if (key === 'v') {
      // preventDefault is load-bearing: returning false only skips xterm's
      // OWN key processing — it does NOT stop the browser's native paste.
      // Without it, Chromium still fires a 'paste' event into xterm's hidden
      // textarea and xterm's paste listener writes the clipboard to the PTY a
      // second time, so every Ctrl+V pasted twice (2026-07-16). This custom
      // path must stay (macOS has no working paste shortcut without an Edit
      // menu role in Electron), so it becomes the ONLY path by suppressing
      // the native one.
      e.preventDefault();
      navigator.clipboard.readText().then((text) => {
        if (text) terminal.paste(text);
      }).catch(() => {});
      return false;
    }
    return true;
  };
}
