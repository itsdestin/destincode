import { useCallback, useEffect, useState } from 'react';
import FolderSwitcher from '../FolderSwitcher';
import { MODELS } from '../StatusBar';

// Same labels as App.tsx / BuddyWelcome — keep in sync if MODELS changes.
const MODEL_LABELS: Record<string, string> = {
  sonnet: 'Sonnet',
  'opus[1m]': 'Opus 1M',
  haiku: 'Haiku',
};

interface Props {
  /** Invoked with the new session id after session.create resolves. */
  onCreated: (sessionId: string) => void;
  /** User-initiated dismissal (Cancel button, Escape, click-away). */
  onCancel: () => void;
}

/**
 * Shared new-session form used by the buddy chat window in two places:
 *   1. BuddyWelcome expanded state (no active session)
 *   2. SessionPill dropdown's "+ New session…" expansion
 *
 * Keeps the fields + create logic in one place so the pill and welcome
 * screens can't drift. Restyled compact for 320 × 480 buddy dimensions.
 * Mirrors App.tsx:1594-1651 in field layout and defaults hydration.
 */
export function BuddyNewSessionForm({ onCreated, onCancel }: Props) {
  const [cwd, setCwd] = useState('');
  const [dangerous, setDangerous] = useState(false);
  const [model, setModel] = useState<string>('sonnet');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Hydrate defaults once on mount. We read lazily (not in a parent effect)
  // because the form is conditionally rendered and we only care about the
  // defaults *at the moment it opens*.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const defaults = await window.claude.defaults?.get?.();
        if (cancelled) return;
        setCwd(defaults?.projectFolder ?? '');
        setDangerous(defaults?.skipPermissions ?? false);
        setModel(defaults?.model ?? 'sonnet');
      } catch {
        // Defaults are best-effort — FolderSwitcher will still auto-select
        // the first known folder via its own load() on mount.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const submit = useCallback(async () => {
    if (creating) return;
    if (!cwd) {
      setError('Pick a project folder first.');
      return;
    }
    setCreating(true);
    setError(null);
    try {
      const info = await (window.claude.session.create as any)({
        name: 'New Session',
        cwd,
        skipPermissions: dangerous,
        model,
        provider: 'claude',
      });
      if (info?.id) onCreated(info.id);
    } catch (e: any) {
      setError(e?.message ?? 'Could not start a session.');
      setCreating(false);
    }
  }, [creating, cwd, dangerous, model, onCreated]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div>
        <label style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--fg-muted)', display: 'block', marginBottom: 4 }}>
          Project Folder
        </label>
        <FolderSwitcher value={cwd} onChange={setCwd} />
      </div>
      <div>
        <label style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--fg-muted)', display: 'block', marginBottom: 4 }}>
          Model
        </label>
        <div style={{ display: 'flex', gap: 4 }}>
          {MODELS.map((m) => (
            <button
              key={m}
              onClick={() => setModel(m)}
              style={{
                flex: 1,
                padding: '4px 4px',
                fontSize: 10,
                borderRadius: 6,
                border: 'none',
                cursor: 'pointer',
                background: model === m ? 'var(--accent)' : 'var(--inset)',
                color: model === m ? 'var(--on-accent)' : 'var(--fg-dim)',
                fontWeight: model === m ? 500 : 400,
              }}
            >
              {MODEL_LABELS[m] || m}
            </button>
          ))}
        </div>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <label style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--fg-muted)' }}>
          Skip Permissions
        </label>
        <button
          onClick={() => setDangerous(!dangerous)}
          style={{
            width: 32,
            height: 18,
            borderRadius: 999,
            border: 'none',
            cursor: 'pointer',
            background: dangerous ? '#DD4444' : 'var(--inset)',
            position: 'relative',
          }}
          aria-pressed={dangerous}
          aria-label="Skip permissions"
        >
          <span
            style={{
              position: 'absolute',
              top: 2,
              left: dangerous ? 'calc(100% - 16px)' : 2,
              width: 14,
              height: 14,
              borderRadius: '50%',
              background: '#fff',
              transition: 'left 150ms ease',
            }}
          />
        </button>
      </div>
      {dangerous && (
        <p style={{ fontSize: 10, color: '#DD4444', margin: 0 }}>
          Claude will execute tools without asking for approval.
        </p>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
        <button
          onClick={onCancel}
          disabled={creating}
          style={{
            padding: '6px 12px',
            fontSize: 12,
            borderRadius: 8,
            border: 'none',
            cursor: creating ? 'default' : 'pointer',
            background: 'var(--inset)',
            color: 'var(--fg-dim)',
          }}
        >
          Cancel
        </button>
        <button
          onClick={submit}
          disabled={creating}
          style={{
            flex: 1,
            padding: '6px 12px',
            fontSize: 12,
            fontWeight: 500,
            borderRadius: 8,
            border: 'none',
            cursor: creating ? 'default' : 'pointer',
            background: dangerous ? '#DD4444' : 'var(--accent)',
            color: dangerous ? '#fff' : 'var(--on-accent)',
            opacity: creating ? 0.6 : 1,
          }}
        >
          {creating ? 'Creating…' : dangerous ? 'Create (Dangerous)' : 'Create Session'}
        </button>
      </div>
      {error && (
        <p style={{ fontSize: 10, color: 'var(--fg-muted)', margin: 0, textAlign: 'center' }}>
          {error}
        </p>
      )}
    </div>
  );
}
