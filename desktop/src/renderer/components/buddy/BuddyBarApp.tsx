import { useCallback, useEffect, useState } from 'react';
import { ThemeProvider } from '../../state/theme-context';

/**
 * Action-bar floater window (148×44, transparent). Sits directly below the
 * mascot. Three actions: screenshot the desktop, open the main app, hide the
 * buddy for this run. Replaces the old single-purpose BuddyCaptureApp.
 *
 * Visibility is CSS-driven (fade+rise) via the buddy:bar-state push — the
 * BrowserWindow itself stays shown so opacity can animate (Task 4 wires the
 * push; until then the bar renders visible whenever the window is shown).
 */
function BarButton({ label, onClick, busy, children }: {
  label: string;
  onClick: () => void;
  busy?: boolean;
  children: React.ReactNode; // the icon SVG
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      disabled={busy}
      className="buddy-bar-btn"
      // Suppress the pre-click focus so no focus ring flashes (same rationale
      // as the old capture button: frameless window, no keyboard nav).
      onMouseDown={(e) => e.preventDefault()}
      style={{
        width: 44,
        height: 44,
        padding: 0,
        borderRadius: '50%',
        border: '1px solid color-mix(in srgb, var(--edge) 60%, transparent)',
        cursor: busy ? 'default' : 'pointer',
        background: 'var(--panel)',
        color: 'var(--fg)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        // Inset highlight only — window is exactly button-height, an outer
        // shadow would clip at the window edge and read as a square halo.
        boxShadow: 'inset 0 1px 0 rgba(255, 255, 255, 0.18)',
        transition: 'transform 120ms ease, opacity 120ms ease',
        transform: busy ? 'scale(0.92)' : undefined,
        opacity: busy ? 0.7 : 1,
        outline: 'none',
        WebkitAppearance: 'none',
      }}
    >
      {children}
    </button>
  );
}

const ICON_PROPS = {
  width: 20, height: 20, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 1.8,
  strokeLinecap: 'round', strokeLinejoin: 'round',
  'aria-hidden': true,
} as const;

export function BuddyBarApp() {
  const [capturing, setCapturing] = useState(false);

  useEffect(() => {
    document.body.setAttribute('data-mode', 'buddy-bar');
  }, []);

  const onCapture = useCallback(async () => {
    if (capturing) return;
    setCapturing(true);
    try {
      await window.claude?.buddy?.captureDesktop?.();
    } finally {
      // Hold the pressed state ~150ms so the click is visibly acknowledged.
      setTimeout(() => setCapturing(false), 150);
    }
  }, [capturing]);

  const onOpenMain = useCallback(() => {
    window.claude?.buddy?.openMain?.();
  }, []);

  const onHide = useCallback(() => {
    window.claude?.buddy?.dismiss?.();
  }, []);

  return (
    <ThemeProvider>
      <div
        className="buddy-bar-root"
        style={{
          width: '100vw',
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 8,
          background: 'transparent',
        }}
      >
        <BarButton label="Screenshot desktop" onClick={onCapture} busy={capturing}>
          {/* camera */}
          <svg {...ICON_PROPS}>
            <path d="M4 8h3l2-2h6l2 2h3a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
        </BarButton>
        <BarButton label="Open YouCoded" onClick={onOpenMain}>
          {/* expand / open-in-window */}
          <svg {...ICON_PROPS}>
            <polyline points="15 3 21 3 21 9" />
            <polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="14" y2="10" />
            <line x1="3" y1="21" x2="10" y2="14" />
          </svg>
        </BarButton>
        <BarButton label="Hide buddy until restart" onClick={onHide}>
          {/* eye-off */}
          <svg {...ICON_PROPS}>
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <path d="M14.12 14.12a3 3 0 1 1-4.24-4.24" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        </BarButton>
      </div>
    </ThemeProvider>
  );
}
