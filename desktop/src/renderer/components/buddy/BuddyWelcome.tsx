import { useCallback, useState } from 'react';
import { ThemeMascot, WelcomeAppIcon } from '../Icons';
import { BuddyNewSessionForm } from './BuddyNewSessionForm';

/**
 * Buddy empty-state — mirrors the main app's no-active-session screen
 * (mascot + "No Active Session" + New Session/Resume buttons). When the
 * user clicks New Session, we swap the CTA cluster for the shared
 * BuddyNewSessionForm (folder picker, model, skip-perms, create/cancel).
 * That form is also reused by SessionPill's dropdown so the two buddy
 * entry points cannot drift.
 */
interface Props {
  /** Called with the newly-created session id so BuddyChat can subscribe + set view. */
  onSessionCreated: (sessionId: string) => void;
}

export function BuddyWelcome({ onSessionCreated }: Props) {
  const [formOpen, setFormOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openResume = useCallback(() => {
    // Buddy is too small to host the full ResumeBrowser modal. Wiring a
    // peer-window "focus main + open resume" flow is a separate pass
    // (needs new IPC + App.tsx listener); for now surface a short hint
    // so the button reads as intentional rather than broken.
    setError('Open Resume from the main window for now.');
  }, []);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 10,
        padding: '0 16px',
      }}
    >
      {!formOpen ? (
        // Collapsed state — mirrors App.tsx:1652-1676
        <>
          <ThemeMascot variant="welcome" fallback={WelcomeAppIcon} className="w-24 h-24 text-fg-dim" />
          <p style={{ fontSize: 14, color: 'var(--fg-muted)', margin: 0 }}>No Active Session</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, width: '100%', marginTop: 4 }}>
            <button
              onClick={() => { setError(null); setFormOpen(true); }}
              className="panel-glass"
              style={{
                width: '100%',
                padding: '8px 16px',
                fontSize: 13,
                fontWeight: 500,
                borderRadius: 10,
                border: 'none',
                cursor: 'pointer',
                background: 'var(--accent)',
                color: 'var(--on-accent)',
              }}
            >
              New Session
            </button>
            <button
              onClick={openResume}
              className="panel-glass"
              style={{
                width: '100%',
                padding: '8px 16px',
                fontSize: 13,
                fontWeight: 500,
                borderRadius: 10,
                border: 'none',
                cursor: 'pointer',
                background: 'var(--inset)',
                color: 'var(--fg-dim)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <span>Resume Session</span>
            </button>
          </div>
          {error && (
            <p style={{ fontSize: 10, color: 'var(--fg-muted)', margin: 0, textAlign: 'center' }}>
              {error}
            </p>
          )}
        </>
      ) : (
        <div className="layer-surface" style={{ width: '100%', padding: 12 }}>
          <BuddyNewSessionForm
            onCreated={onSessionCreated}
            onCancel={() => setFormOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
