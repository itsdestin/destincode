// ActiveArtifactView — shared component for viewing and editing a single artifact.
// Extracted from SessionDrawer.tsx (Task 7.2) so both SessionDrawer and ProjectView
// can use it identically without duplicating the edit state + conflict-detection logic.
import React, { useCallback, useEffect, useRef, useState, forwardRef, useImperativeHandle, Suspense } from 'react';
import { getViewer, getEditViewer } from './RendererRegistry';
import { ViewerErrorBoundary } from './ViewerErrorBoundary';
import type { ArtifactRecord } from '../../../shared/artifacts/types';
import { editTier } from '../../../shared/artifacts/editable-path-policy';
import { canonicalize } from '../../../shared/artifacts/canonicalize';
import { UnifiedDiff } from '../diff/UnifiedDiff';
import { openEditorSearch, revealLineIn } from './cm/editor-registry';
import { draftKey, stashDraft, takeDraft, clearDraft } from './draft-store';

// Confirm-tier wording (D5): name the actual consequence, per path family.
// Never a vague "are you sure" — the user should know what the file DOES.
function confirmMessage(canonPath: string): string {
  const base = canonPath.split('/').pop() ?? canonPath;
  if (base === '.envrc') {
    return 'direnv runs this file as shell commands when you enter the folder.\n\nEdit it anyway?';
  }
  if (base === '.env' || base.startsWith('.env.')) {
    return 'This file usually contains secrets like API keys and passwords.\n\nEdit it anyway?';
  }
  return 'This file configures Claude — settings and hooks here can run commands on your machine.\n\nEdit it anyway?';
}

// Surface the REAL save failure (error-message-standards): specific when we
// know the cause, the raw error string when we do not — never a guessed cause.
function saveErrorMessage(res: any): string {
  const err = res?.error;
  if (err === 'protected-path') {
    return 'This file is protected and cannot be edited in YouCoded — paths under .git, .youcoded, and credential folders can change what runs on your machine.';
  }
  if (err === 'needs-confirm') {
    return 'Editing this file needs an explicit confirmation. Leave and re-enter edit mode to confirm.';
  }
  return `Save failed: ${String(err ?? 'unknown error')}`;
}

// Imperative handle so an external chrome (the SessionDrawer header toolbar) can
// drive edit mode while ActiveArtifactView keeps owning the edit/save/conflict
// logic. Paired with onEditStateChange so the header re-renders on state change.
export interface ActiveArtifactHandle {
  isEditable: boolean;
  editing: boolean;
  /** True when edit mode holds changes not yet on disk — hosts must gate
   * selection/close behind the unsaved-changes prompt when set (D3). */
  dirty: boolean;
  startEdit(): void;
  /** Resolves true when the save landed — false means the pane is showing a
   * conflict or error and the caller should NOT proceed with navigation. */
  saveEdit(): Promise<boolean>;
  cancelEdit(): void;
  /** Route find-in-document into the CodeMirror search panel when the active
   * viewer is CM6 (its DOM is virtualized — ContentFindBar would silently
   * miss off-viewport matches). Returns true when handled. */
  openFind(): boolean;
  /** Scroll the code editor to a 1-indexed line (search jump-to-hit).
   * Retries briefly — the lazy CM6 chunk may still be mounting when a search
   * result opens a file. No-op for non-code viewers. */
  revealLine(line: number): void;
}

/** Metadata from the artifacts:get response that content alone cannot carry —
 * hosts thread it through so the pane can route binary files and render the
 * too-large notice instead of a blank viewer. */
export interface ArtifactContentInfo {
  binary?: boolean;
  tooLarge?: boolean;
  sizeBytes?: number;
}

export interface ActiveArtifactViewProps {
  artifact: ArtifactRecord;
  content: string | null;
  contentInfo?: ArtifactContentInfo | null;
  projectRoot: string;
  projectId: string;
  projectName: string;
  sessionId: string;
  onContentChange: (content: string | null) => void;
  // When true, the viewer hides its own Edit/Save/Cancel buttons — the host
  // (SessionDrawer) renders them in its header instead. ProjectView omits this.
  controlsInHeader?: boolean;
  // Fires whenever editability / edit-mode changes so the host header can update.
  onEditStateChange?: (s: { isEditable: boolean; editing: boolean }) => void;
}

export const ActiveArtifactView = forwardRef<ActiveArtifactHandle, ActiveArtifactViewProps>(function ActiveArtifactView({
  artifact, content, contentInfo, projectRoot, projectId, projectName, sessionId, onContentChange,
  controlsInHeader = false, onEditStateChange,
}, ref) {
  // Resolve the absolute path depending on artifact kind. Forward slashes
  // throughout — a backslash projectRoot + '/' + relative path yields a mixed-
  // separator string that looks broken in copy-path/reveal on Windows.
  const absolutePath = artifact.kind === 'internal'
    ? `${projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')}/${artifact.path.replace(/\\/g, '/')}`
    : (artifact.absolutePath ?? artifact.path);

  // Renderer MIRROR of the D5 write policy — main enforces the real boundary
  // in artifacts:save; this only hides the Edit affordance so the UI never
  // offers an action main would refuse. (Main resolves symlinks first, so a
  // mirror miss here fails safe: the save is still rejected.)
  const tier = editTier(canonicalize(absolutePath, null));
  // D4: ANY text file is editable — the old md/markdown/txt allowlist is gone.
  // Not editable when: policy-denied, sniffed binary, over the size cap, or
  // content has not resolved (null = loading/orphan — the §2.2 truncation guard).
  const isEditable = content !== null && tier !== 'denied'
    && !contentInfo?.binary && !contentInfo?.tooLarge;

  // ── Task 6.4: controlled edit state (lifted from MarkdownView) ──
  // Owning edit state here lets the conflict banner read/reset it without
  // requiring a refactor of each individual viewer component.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content ?? '');
  // conflict.disk holds the on-disk version when a concurrent write is detected
  const [conflict, setConflict] = useState<{ disk: string } | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  // Surfaced save failures — replaces the old console-only error path (§2.4).
  const [saveError, setSaveError] = useState<string | null>(null);
  // Optimistic-concurrency token from artifacts:get, round-tripped into save as
  // baseMtimeMs so a save over a changed file is rejected instead of silently
  // clobbering it (spec §12.9). null = no token yet → save runs unguarded.
  const mtimeRef = useRef<number | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Mirrors for the unmount stash below — cleanup closures must read the
  // CURRENT values, not the ones captured when the effect last ran.
  const stateRef = useRef({ editing: false, draft: '', content: null as string | null });
  stateRef.current = { editing, draft, content };
  // A stashed draft waiting for content to resolve before it re-enters edit
  // mode (restoring before the fetch lands would fight the draft-reset effect).
  const pendingRestoreRef = useRef<ReturnType<typeof takeDraft>>(undefined);
  const firstRunRef = useRef(true);

  // Reset draft when content reloads from disk (e.g. artifact selection changes)
  useEffect(() => {
    setDraft(content ?? '');
    setConflict(null);
    setShowDiff(false);
    // Draft-stash restoration (draft-store.ts): an unguarded unmount (games
    // panel, view toggle, Project View, pill click, …) stashed the dirty
    // draft; the file is open again, so hand it back — edit mode, draft, and
    // concurrency token — once real content has resolved.
    const pending = pendingRestoreRef.current;
    if (pending && content !== null) {
      pendingRestoreRef.current = undefined;
      setDraft(pending.draft);
      mtimeRef.current = pending.mtimeMs;
      setEditing(true);
    }
  }, [content, artifact.id]);

  // Fix: leave edit mode when the user switches to a DIFFERENT file. Edit mode
  // used to survive the switch (only the draft reset), so file B opened in the
  // editor holding whatever draft state file A left behind. Now that the host
  // nulls content before re-reading, a save clicked during that gap would write
  // an empty draft over the file — exiting edit mode closes that window.
  useEffect(() => {
    setEditing(false);
    setSaveError(null);
    mtimeRef.current = null; // token belongs to the previous file
    const key = draftKey(projectRoot, artifact.id);
    pendingRestoreRef.current = takeDraft(key);
    // On the FIRST mount content may already be resolved (host kept it warm),
    // in which case the content effect above has already run this commit and
    // will not run again — restore immediately. On artifact SWITCHES content
    // is about to be nulled + refetched by the host, so restoring now would
    // apply the draft against the previous file's stale content; the content
    // effect picks the pending entry up when the right bytes land.
    if (firstRunRef.current) {
      firstRunRef.current = false;
      const pending = pendingRestoreRef.current;
      if (pending && stateRef.current.content !== null) {
        pendingRestoreRef.current = undefined;
        setDraft(pending.draft);
        mtimeRef.current = pending.mtimeMs;
        setEditing(true);
      }
    }
    return () => {
      // THE SAFETY NET: unmounting (or switching away) while dirty stashes
      // the draft instead of discarding it. Guarded paths never reach here
      // dirty — Discard runs cancelEdit first; unguarded paths (any layout
      // change that unmounts the drawer) degrade to draft-survives.
      const cur = stateRef.current;
      if (cur.editing && cur.content !== null && cur.draft !== cur.content) {
        stashDraft(key, { draft: cur.draft, mtimeMs: mtimeRef.current });
      }
    };
  }, [artifact.id, projectRoot]);

  // ── React to on-disk changes (external writes, saves from other windows) ──
  // Runs regardless of edit mode — the old version gated on `editing` AND
  // filtered on by === 'agent', which nothing ever emitted, so the banner was
  // unreachable dead code and read mode always showed stale content (spec §2.1).
  // Now: clean viewer → silently refetch; dirty editor → raise the conflict
  // banner with the disk version. `by` is deliberately ignored: a 'user' save
  // from another window needs exactly the same handling as an 'external' write.
  const dirty = editing && content !== null && draft !== content;
  useEffect(() => {
    // artifacts.onChanged is optional — gracefully skip if IPC not wired yet
    const unsubFn = (window.claude as any).artifacts?.onChanged?.((evt: any) => {
      if (evt.projectRoot !== projectRoot || evt.artifactId !== artifact.id) return;
      if (evt.kind === 'remove') return; // orphan handling is the host's concern
      (window.claude as any).artifacts.get(projectRoot, artifact.id).then((res: any) => {
        if (!res || !res.ok || res.orphan) return;
        if (typeof res.mtimeMs === 'number') mtimeRef.current = res.mtimeMs;
        const disk = res.content ?? '';
        if (dirty) {
          if (disk !== draft) setConflict({ disk });
        } else if (disk !== content) {
          // Refetch path: updating host content also resets the (clean) draft.
          onContentChange(disk);
        }
      });
    });
    return typeof unsubFn === 'function' ? unsubFn : undefined;
  }, [artifact.id, projectRoot, dirty, draft, content, onContentChange]);

  // ── Edit lifecycle callbacks (passed down to MarkdownView as controlled props) ──
  const handleStartEdit = useCallback(() => {
    // Confirm-tier paths get one deliberate click BEFORE editing starts, not a
    // surprise refusal at save time (D5 — mistake-prevention, not security; the
    // hard boundary is main's).
    if (tier === 'needs-confirm' && !window.confirm(confirmMessage(canonicalize(absolutePath, null)))) {
      return;
    }
    // Refresh from disk on entering edit mode: picks up staleness the watcher
    // may have missed AND captures the concurrency token the save round-trips.
    (window.claude as any).artifacts.get(projectRoot, artifact.id).then((res: any) => {
      if (res && res.ok && !res.orphan && !res.tooLarge && typeof res.content === 'string') {
        if (typeof res.mtimeMs === 'number') mtimeRef.current = res.mtimeMs;
        if (res.content !== content) onContentChange(res.content);
      }
    }).catch(() => { /* stale content + no token — save falls back to unguarded */ });
    setEditing(true);
    setConflict(null);
    setSaveError(null);
  }, [tier, absolutePath, projectRoot, artifact.id, content, onContentChange]);

  // opts.force: skip the concurrency token — the deliberate "Keep mine"
  // overwrite. Shaped as an options object so accidental event-object args
  // (onClick={handleSave}) can never read as force=true.
  const handleSave = useCallback(async (opts?: { force?: boolean }): Promise<boolean> => {
    // The §2.2 empty-file guarantee: while content is null (the fetch
    // transient, an orphan, a binary file) there is NOTHING valid to save — a
    // write here would truncate the file to the placeholder draft. This is the
    // single highest-risk regression in the workstream; keep it hard-blocked.
    if (content === null) return false;
    const saveOpts: { baseMtimeMs?: number; confirmed?: boolean } = {};
    if (!opts?.force && mtimeRef.current !== null) saveOpts.baseMtimeMs = mtimeRef.current;
    if (tier === 'needs-confirm') saveOpts.confirmed = true; // dialog shown at startEdit
    const res = await (window.claude as any).artifacts.save(
      projectRoot, projectId, projectName, artifact.id, draft, sessionId, saveOpts
    );
    if (res && res.ok) {
      if (typeof res.mtimeMs === 'number') mtimeRef.current = res.mtimeMs;
      clearDraft(draftKey(projectRoot, artifact.id));
      onContentChange(draft);
      setEditing(false);
      setConflict(null);
      setSaveError(null);
      return true;
    }
    if (res && res.error === 'conflict') {
      // Disk moved under the token — surface the conflict UI instead of
      // silently clobbering whatever was written (spec §12.9).
      const disk = await (window.claude as any).artifacts.get(projectRoot, artifact.id);
      if (disk && disk.ok && !disk.orphan) {
        if (typeof disk.mtimeMs === 'number') mtimeRef.current = disk.mtimeMs;
        setConflict({ disk: disk.content ?? '' });
      } else {
        setSaveError('Save failed: the file changed on disk and could not be re-read.');
      }
      return false;
    }
    setSaveError(saveErrorMessage(res));
    return false;
  }, [projectRoot, projectId, projectName, artifact.id, draft, sessionId, onContentChange, tier, content]);

  const handleCancel = useCallback(() => {
    clearDraft(draftKey(projectRoot, artifact.id));
    setDraft(content ?? '');
    setEditing(false);
    setConflict(null);
    setSaveError(null);
  }, [content, projectRoot, artifact.id]);

  // ── Conflict resolution actions ──
  const resolveKeepMine = useCallback(() => {
    // Deliberate force-overwrite: "Keep mine" MEANS clobber what is on disk,
    // so the concurrency token is skipped by design.
    handleSave({ force: true });
  }, [handleSave]);

  const resolveUseDisk = useCallback(() => {
    if (!conflict) return;
    // Accept whatever is on disk: update UI content and exit edit mode. The
    // action says "disk", not "Claude" — a watcher cannot know WHO wrote the
    // file (git checkout, formatter, another editor), and naming Claude would
    // be a guessed cause in a user-facing string (spec §8.2).
    clearDraft(draftKey(projectRoot, artifact.id));
    onContentChange(conflict.disk);
    setDraft(conflict.disk);
    setEditing(false);
    setConflict(null);
  }, [conflict, onContentChange, projectRoot, artifact.id]);

  // Expose edit control to the host header (SessionDrawer).
  useImperativeHandle(ref, () => ({
    isEditable,
    editing,
    dirty,
    startEdit: handleStartEdit,
    saveEdit: () => handleSave(),
    cancelEdit: handleCancel,
    openFind: () => openEditorSearch(rootRef.current),
    revealLine: (line: number) => {
      // Retry across a few frames: the editor is a lazy chunk and mounts in an
      // effect, so it may not be registered yet when the host calls this right
      // after opening the file.
      let attempts = 0;
      const tryReveal = () => {
        if (revealLineIn(rootRef.current, line)) return;
        if (attempts++ < 20) setTimeout(tryReveal, 50);
      };
      tryReveal();
    },
  }), [isEditable, editing, dirty, handleStartEdit, handleSave, handleCancel]);

  // Desktop app-quit / window-close guard while dirty (D3). Android never
  // fires beforeunload usefully — its back navigation goes through the
  // useEscClose stack in the hosts instead.
  useEffect(() => {
    if (!dirty) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  // Notify the host whenever editability / edit-mode changes so its header
  // can swap the pencil ↔ save/cancel icons.
  useEffect(() => {
    onEditStateChange?.({ isEditable, editing });
  }, [isEditable, editing, onEditStateChange]);

  // The Registry returns a real component for every type (heavy viewers —
  // pdf/docx/xlsx — are React.lazy, so they're code-split but still rendered
  // here). The <Suspense> boundary below resolves the lazy chunk transparently.
  // Read mode routes by file type; EDIT mode always routes to an actual
  // editor component — most read viewers (HtmlView iframe, CsvView grid) have
  // no edit UI, so "Edit" on those files used to render nothing.
  const ViewerComponent = editing
    ? getEditViewer(artifact.path)
    : getViewer(artifact.path, {
        // Only assert text when a get response actually sniffed the bytes —
        // absent info keeps the registry's conservative extension routing.
        textHint: contentInfo ? contentInfo.binary === false : undefined,
      });

  // Over the artifacts:get size cap: the content was deliberately not served
  // (a multi-MB string would block main + renderer, spec §2.3/§4.2). Offer the
  // OS default app instead of a broken editor.
  if (contentInfo?.tooLarge) {
    const mb = contentInfo.sizeBytes ? (contentInfo.sizeBytes / (1024 * 1024)).toFixed(1) : '?';
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 text-sm text-fg-muted p-6 text-center">
        <div>
          This file is {mb} MB — too large to open in the artifact pane.
        </div>
        <button
          className="underline hover:no-underline text-fg-2"
          onClick={() => (window.claude as any).shell?.openPath?.(absolutePath)}
        >
          Open in default app
        </button>
      </div>
    );
  }
  return (
    <div ref={rootRef} className="h-full flex flex-col">
      {/* Conflict banner — shown when the file changes on disk while the user
          has UNSAVED edits. Three actions: keep draft, accept the disk version,
          or view a real unified diff (shared UnifiedDiff renderer). */}
      {conflict && (
        // Theme-independent amber (matches ContextEditorOverlay's blast-radius
        // banner — the house pattern for warnings). The previous `dark:` variants
        // followed the OS color scheme, NOT the active YouCoded theme (the app
        // themes via data-theme, not a .dark class), so the banner could render
        // light-mode colors under a dark theme.
        <div
          className="p-3 text-sm flex flex-wrap gap-x-3 gap-y-1 items-center border-b shrink-0"
          style={{ color: '#9a6a00', background: '#FFF6E5', borderColor: '#E8C170' }}
        >
          <span className="flex-1 min-w-0 font-medium">This file changed on disk while you were editing.</span>
          <button className="underline hover:no-underline whitespace-nowrap" onClick={resolveKeepMine}>
            Keep mine
          </button>
          <button className="underline hover:no-underline whitespace-nowrap" onClick={resolveUseDisk}>
            Use disk version
          </button>
          <button
            className="underline hover:no-underline whitespace-nowrap"
            onClick={() => setShowDiff((v) => !v)}
          >
            {showDiff ? 'Hide diff' : 'View diff'}
          </button>
        </div>
      )}
      {/* Save-failure banner — the real error, inline, dismissible. Replaces
          the old console-only failure path where a failed save looked identical
          to a successful one (§2.4). Theme-independent like the conflict banner. */}
      {saveError && (
        <div
          className="p-3 text-sm flex flex-wrap gap-x-3 gap-y-1 items-center border-b shrink-0"
          style={{ color: '#8a1f1f', background: '#FDECEC', borderColor: '#E5A0A0' }}
        >
          <span className="flex-1 min-w-0">{saveError}</span>
          <button className="underline hover:no-underline whitespace-nowrap" onClick={() => setSaveError(null)}>
            Dismiss
          </button>
        </div>
      )}
      {/* Real unified diff (jsdiff via the shared UnifiedDiff — same renderer as
          the tool cards). Direction: disk → draft, i.e. what "Keep mine" would
          change on disk. Replaces the old two-<pre> columns, which were not a
          diff at all (spec §6.2). */}
      {showDiff && conflict && (
        <div className="border-b border-edge shrink-0 overflow-auto max-h-[40%] p-2">
          <div className="text-3xs font-medium text-fg-muted tracking-wider uppercase mb-1">
            What keeping yours changes (disk → your draft)
          </div>
          <UnifiedDiff oldStr={conflict.disk} newStr={draft} />
        </div>
      )}
      <div className="flex-1 overflow-hidden">
        {/* Boundary catches lazy chunk-load failures + viewer render crashes
            (Suspense alone can't — lazy() THROWS its rejection). Keyed by
            artifact so switching files retries with a clean slate. */}
        <ViewerErrorBoundary key={artifact.id} path={artifact.path}>
        <Suspense fallback={<div className="flex items-center justify-center h-full text-fg-muted text-sm">Loading viewer…</div>}>
          <ViewerComponent
            path={artifact.path}
            content={content}
            absolutePath={absolutePath}
            isEditable={isEditable}
            editing={editing}
            draft={draft}
            onDraftChange={setDraft}
            onStartEdit={handleStartEdit}
            onSaveEdit={handleSave}
            onCancelEdit={handleCancel}
            hideControls={controlsInHeader}
          />
        </Suspense>
        </ViewerErrorBoundary>
      </div>
    </div>
  );
});
