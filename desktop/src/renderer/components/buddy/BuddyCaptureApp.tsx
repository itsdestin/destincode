import { useCallback, useEffect, useState } from 'react';
import { ThemeProvider } from '../../state/theme-context';

/**
 * Capture-icon floater window (44×44, transparent). Sits directly below
 * the mascot whenever the chat is open. One click = "screenshot the
 * desktop and drop it into my chat's input bar as an attachment."
 *
 * The renderer is deliberately thin: the main process does the actual
 * hide/capture/restore dance and pushes the resulting file path to the
 * chat window on BUDDY_ATTACH_FILE. This component just invokes the IPC
 * and shows a brief "capturing…" state so the user gets feedback that
 * their click worked.
 */
function BuddyCaptureButton() {
  const [capturing, setCapturing] = useState(false);

  const onClick = useCallback(async () => {
    if (capturing) return;
    setCapturing(true);
    try {
      await (window as any).claude?.buddy?.captureDesktop?.();
    } finally {
      // Hold the capturing state for ~150 ms even on fast machines so the
      // click is acknowledged — without this the icon flashes back to
      // idle before the user's eye has registered the press.
      setTimeout(() => setCapturing(false), 150);
    }
  }, [capturing]);

  return (
    <button
      onClick={onClick}
      aria-label="Capture desktop"
      title="Capture desktop"
      disabled={capturing}
      style={{
        width: 44,
        height: 44,
        padding: 0,
        borderRadius: '50%',
        border: '1px solid color-mix(in srgb, var(--edge) 60%, transparent)',
        cursor: capturing ? 'default' : 'pointer',
        background: 'var(--panel)',
        color: 'var(--fg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Same floating drop shadow as the chat bubble so the icon reads
        // as part of the same surface cluster.
        boxShadow:
          'inset 0 1px 0 rgba(255, 255, 255, 0.18), 0 6px 18px rgba(0, 0, 0, 0.22)',
        transition: 'transform 120ms ease, opacity 120ms ease',
        transform: capturing ? 'scale(0.92)' : 'scale(1)',
        opacity: capturing ? 0.7 : 1,
      }}
    >
      {/* Simple camera glyph — viewBox 24×24 scaled to 20 px. Pure stroke
          so it tints with currentColor = var(--fg), matching the mascot
          theming pattern. */}
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M4 8h3l2-2h6l2 2h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
        <circle cx="12" cy="13" r="4" />
      </svg>
    </button>
  );
}

export function BuddyCaptureApp() {
  useEffect(() => {
    document.body.setAttribute('data-mode', 'buddy-capture');
  }, []);

  return (
    <ThemeProvider>
      <div
        style={{
          width: '100vw',
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          // Frameless transparent window — body/#root are forced transparent
          // via html[data-mode="buddy-capture"] rules in buddy.css.
          background: 'transparent',
        }}
      >
        <BuddyCaptureButton />
      </div>
    </ThemeProvider>
  );
}
