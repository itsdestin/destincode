import { useCallback, useState } from 'react';
import { ThemeMascot, WelcomeAppIcon } from '../Icons';

/**
 * Compact welcome screen for the buddy chat window — mirrors the main
 * app's no-active-session layout (mascot + "No Active Session" + New
 * Session button) but sized for 320×480 and with only the defaults path
 * (no expandable form — the main app owns the full form UX).
 *
 * Resume is surfaced as "Browse in main…" which focuses the main window
 * so the user can pick a session from its full ResumeBrowser — buddy is
 * too small to host a meaningful session browser.
 */
interface Props {
  /** Called with the newly-created session id after the user clicks New Session. */
  onSessionCreated: (sessionId: string) => void;
}

export function BuddyWelcome({ onSessionCreated }: Props) {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleNewSession = useCallback(async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      const defaults = await window.claude.defaults?.get?.();
      const cwd = defaults?.projectFolder;
      if (!cwd) {
        // Main app opens the expand form with a folder picker here; buddy
        // keeps things minimal and redirects the user to main instead of
        // reimplementing the picker in 320×480.
        setError('Set a default project folder in main first.');
        setCreating(false);
        return;
      }
      const info = await window.claude.session.create({
        name: basename(cwd),
        cwd,
        skipPermissions: defaults?.skipPermissions ?? false,
      });
      if (info?.id) {
        onSessionCreated(info.id);
      }
    } catch (e: any) {
      setError(e?.message ?? 'Could not start a session.');
      setCreating(false);
    }
  }, [creating, onSessionCreated]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        height: '100%',
        gap: 10,
        padding: '0 24px',
      }}
    >
      {/* 96 px to read as a character but still leave room for button */}
      <ThemeMascot variant="welcome" fallback={WelcomeAppIcon} className="w-24 h-24 text-fg-dim" />
      <p style={{ fontSize: 14, color: 'var(--fg-muted)', margin: 0 }}>No Active Session</p>
      <button
        onClick={handleNewSession}
        disabled={creating}
        className="panel-glass"
        style={{
          width: '100%',
          marginTop: 4,
          padding: '8px 16px',
          fontSize: 13,
          fontWeight: 500,
          borderRadius: 10,
          border: 'none',
          cursor: creating ? 'default' : 'pointer',
          background: 'var(--accent)',
          color: 'var(--on-accent)',
          opacity: creating ? 0.6 : 1,
        }}
      >
        {creating ? 'Starting…' : 'New Session'}
      </button>
      {error && (
        <p style={{ fontSize: 11, color: 'var(--fg-muted)', margin: 0, textAlign: 'center', lineHeight: 1.4 }}>
          {error}
        </p>
      )}
    </div>
  );
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
