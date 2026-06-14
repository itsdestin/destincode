// ContextEditorOverlay — view/edit an agent-context file in the shared centered
// overlay (Task 4.4). Renders inside <ProjectDetailOverlay> and carries a
// blast-radius warning so the user understands the reach of an edit BEFORE
// saving: AMBER + a save-confirm step for global files (they affect every
// project on the device), neutral + direct-save for project files.
//
// Renderer-only: reads/writes via the already-allow-listed
// project:read-context-file / project:write-context-file IPC. Errors from the
// write path (the main-process allow-list can reject) surface inline rather
// than being swallowed.
import React, { useEffect, useState } from 'react';
import type { ContextFile } from '../../../shared/project-context-types';
import { ProjectDetailOverlay } from './ProjectDetailOverlay';

interface ContextEditorOverlayProps {
  project: { path: string };
  file: ContextFile;
  onClose: () => void;
}

export function ContextEditorOverlay({ project, file, onClose }: ContextEditorOverlayProps) {
  // content = the on-disk text (the "saved" baseline); draft = the editable copy.
  // Save is disabled while draft === content so we never write a no-op edit.
  const [content, setContent] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  // Inline confirm gate for global files — clicking Save first swaps the action
  // row to Confirm/Cancel (matches the prototype + is testable without a modal).
  const [confirming, setConfirming] = useState(false);
  const [copied, setCopied] = useState(false);

  const isGlobal = file.blastRadius === 'global';

  // Load the file content on open and whenever the target path changes. A
  // `cancelled` flag guards against a late response from a previous file
  // overwriting the current one (the overlay is keyed by absolutePath upstream,
  // but this is defensive).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setSaveError(null);
    setConfirming(false);
    (async () => {
      try {
        const res = await (window.claude as any).project.readContextFile(
          project.path, file.absolutePath,
        );
        if (cancelled) return;
        if (res && res.ok) {
          const text = res.content ?? '';
          setContent(text);
          setDraft(text);
        } else {
          setContent(null);
          setLoadError(res?.error || 'Could not read this file.');
        }
      } catch (e: any) {
        if (cancelled) return;
        setContent(null);
        setLoadError(e?.message || 'Could not read this file.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [project.path, file.absolutePath]);

  const dirty = content !== null && draft !== content;

  // Performs the actual write. For global files this only runs after the inline
  // confirm; for project files it runs directly from the Save click.
  const doSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      const res = await (window.claude as any).project.writeContextFile(
        project.path, file.absolutePath, draft,
      );
      if (res && res.ok) {
        // Success: close the overlay (simplest contract — Save disables again
        // would also be valid, but closing avoids a stale-on-screen editor).
        onClose();
        return;
      }
      // Surface the rejection reason; keep the overlay open with the draft intact.
      setSaveError(res?.error || 'Could not save this file.');
    } catch (e: any) {
      setSaveError(e?.message || 'Could not save this file.');
    } finally {
      setSaving(false);
      setConfirming(false);
    }
  };

  const handleSaveClick = () => {
    if (!dirty || saving) return;
    // Global files get a confirm step (blast-radius gate); project files save now.
    if (isGlobal) setConfirming(true);
    else doSave();
  };

  const handleReveal = () => {
    (window.claude as any).shell?.showItemInFolder?.(file.absolutePath);
  };

  const handleCopyPath = () => {
    navigator.clipboard?.writeText(file.absolutePath).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard unavailable — ignore */ });
  };

  return (
    <ProjectDetailOverlay title={file.label} onClose={onClose}>
      <div className="flex flex-col h-full min-h-0 p-3 gap-3">
        {/* Blast-radius banner — always visible at the top of the editor body.
            Global uses prototype inline colors so the amber warning reads
            clearly regardless of theme; project uses neutral theme tokens. */}
        {isGlobal ? (
          <div
            className="border rounded px-3 py-2 text-xs shrink-0"
            style={{ color: '#9a6a00', background: '#FFF6E5', borderColor: '#E8C170' }}
          >
            Editing a global file — this affects every project on this device.
          </div>
        ) : (
          <div className="bg-inset border border-edge rounded px-3 py-2 text-xs text-fg-2 shrink-0">
            This changes how Claude behaves across every session in this project.
          </div>
        )}

        {/* Body: loading / error / editor */}
        {loading ? (
          <div className="flex-1 min-h-0 flex items-center justify-center text-sm text-fg-muted">
            Loading…
          </div>
        ) : loadError ? (
          <div className="flex-1 min-h-0 flex items-center justify-center">
            <p className="text-sm text-red-500 max-w-md text-center">{loadError}</p>
          </div>
        ) : (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            spellCheck={false}
            className="flex-1 min-h-0 w-full resize-none font-mono text-xs leading-relaxed bg-inset border border-edge rounded p-3 text-fg focus:outline-none focus:ring-1 focus:ring-accent"
          />
        )}

        {/* Action row */}
        {!loadError && (
          <div className="flex items-center gap-2 shrink-0">
            {/* Reveal + Copy path — left cluster */}
            <button
              type="button"
              className="px-2.5 py-1.5 rounded-sm border border-edge text-xs text-fg-2 hover:bg-inset hover:text-fg transition-colors"
              onClick={handleReveal}
            >
              Reveal
            </button>
            <button
              type="button"
              className="px-2.5 py-1.5 rounded-sm border border-edge text-xs text-fg-2 hover:bg-inset hover:text-fg transition-colors"
              onClick={handleCopyPath}
            >
              {copied ? 'Copied' : 'Copy path'}
            </button>

            {/* Inline write error — surfaces the allow-list rejection reason. */}
            {saveError && (
              <span className="text-xs text-red-500 truncate">{saveError}</span>
            )}

            <div className="flex-1" />

            {/* Save / confirm cluster — right side. */}
            {confirming ? (
              <>
                <span className="text-xs text-fg-2 mr-1">
                  This affects every project on this device. Save anyway?
                </span>
                <button
                  type="button"
                  className="px-2.5 py-1.5 rounded-sm border border-edge text-xs text-fg-2 hover:bg-inset hover:text-fg transition-colors"
                  onClick={() => setConfirming(false)}
                  disabled={saving}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="px-3 py-1.5 rounded-sm bg-accent text-on-accent text-xs disabled:opacity-50 transition-colors"
                  onClick={doSave}
                  disabled={saving}
                >
                  {saving ? 'Saving…' : 'Confirm'}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="px-3 py-1.5 rounded-sm bg-accent text-on-accent text-xs disabled:opacity-50 transition-colors"
                onClick={handleSaveClick}
                disabled={!dirty || saving}
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            )}
          </div>
        )}
      </div>
    </ProjectDetailOverlay>
  );
}
