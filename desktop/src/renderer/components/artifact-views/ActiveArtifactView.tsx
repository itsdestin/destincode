// ActiveArtifactView — shared component for viewing and editing a single artifact.
// Extracted from SessionDrawer.tsx (Task 7.2) so both SessionDrawer and ProjectView
// can use it identically without duplicating the edit state + conflict-detection logic.
import React, { useCallback, useEffect, useState, forwardRef, useImperativeHandle, Suspense } from 'react';
import { getViewer } from './RendererRegistry';
import { ViewerErrorBoundary } from './ViewerErrorBoundary';
import type { ArtifactRecord } from '../../../shared/artifacts/types';

// Imperative handle so an external chrome (the SessionDrawer header toolbar) can
// drive edit mode while ActiveArtifactView keeps owning the edit/save/conflict
// logic. Paired with onEditStateChange so the header re-renders on state change.
export interface ActiveArtifactHandle {
  isEditable: boolean;
  editing: boolean;
  startEdit(): void;
  saveEdit(): void;
  cancelEdit(): void;
}

export interface ActiveArtifactViewProps {
  artifact: ArtifactRecord;
  content: string | null;
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
  artifact, content, projectRoot, projectId, projectName, sessionId, onContentChange,
  controlsInHeader = false, onEditStateChange,
}, ref) {
  // Resolve the absolute path depending on artifact kind. Forward slashes
  // throughout — a backslash projectRoot + '/' + relative path yields a mixed-
  // separator string that looks broken in copy-path/reveal on Windows.
  const absolutePath = artifact.kind === 'internal'
    ? `${projectRoot.replace(/\\/g, '/').replace(/\/+$/, '')}/${artifact.path.replace(/\\/g, '/')}`
    : (artifact.absolutePath ?? artifact.path);

  const ext = artifact.path.split('.').pop()?.toLowerCase() ?? '';
  // Only plaintext formats support inline editing in v1.
  const isEditable = ext === 'md' || ext === 'markdown' || ext === 'txt';

  // ── Task 6.4: controlled edit state (lifted from MarkdownView) ──
  // Owning edit state here lets the conflict banner read/reset it without
  // requiring a refactor of each individual viewer component.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(content ?? '');
  // conflict.disk holds the agent's version when a concurrent write is detected
  const [conflict, setConflict] = useState<{ disk: string } | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  // Reset draft when content reloads from disk (e.g. artifact selection changes)
  useEffect(() => {
    setDraft(content ?? '');
    setConflict(null);
    setShowDiff(false);
  }, [content, artifact.id]);

  // Fix: leave edit mode when the user switches to a DIFFERENT file. Edit mode
  // used to survive the switch (only the draft reset), so file B opened in the
  // editor holding whatever draft state file A left behind. Now that the host
  // nulls content before re-reading, a save clicked during that gap would write
  // an empty draft over the file — exiting edit mode closes that window.
  useEffect(() => {
    setEditing(false);
  }, [artifact.id]);

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
    setEditing(true);
    setConflict(null);
  }, []);

  const handleSave = useCallback(async () => {
    const res = await (window.claude as any).artifacts.save(
      projectRoot, projectId, projectName, artifact.id, draft, sessionId
    );
    if (res && res.ok) {
      onContentChange(draft);
      setEditing(false);
      setConflict(null);
    } else {
      console.error('[ActiveArtifactView] artifacts.save failed', res);
    }
  }, [projectRoot, projectId, projectName, artifact.id, draft, sessionId, onContentChange]);

  const handleCancel = useCallback(() => {
    setDraft(content ?? '');
    setEditing(false);
    setConflict(null);
  }, [content]);

  // ── Conflict resolution actions ──
  const resolveKeepMine = useCallback(() => {
    // Save the user's current draft over the agent's version
    handleSave();
  }, [handleSave]);

  const resolveUseDisk = useCallback(() => {
    if (!conflict) return;
    // Accept whatever is on disk: update UI content and exit edit mode. The
    // action says "disk", not "Claude" — a watcher cannot know WHO wrote the
    // file (git checkout, formatter, another editor), and naming Claude would
    // be a guessed cause in a user-facing string (spec §8.2).
    onContentChange(conflict.disk);
    setDraft(conflict.disk);
    setEditing(false);
    setConflict(null);
  }, [conflict, onContentChange]);

  // Expose edit control to the host header (SessionDrawer).
  useImperativeHandle(ref, () => ({
    isEditable,
    editing,
    startEdit: handleStartEdit,
    saveEdit: handleSave,
    cancelEdit: handleCancel,
  }), [isEditable, editing, handleStartEdit, handleSave, handleCancel]);

  // Notify the host whenever editability / edit-mode changes so its header
  // can swap the pencil ↔ save/cancel icons.
  useEffect(() => {
    onEditStateChange?.({ isEditable, editing });
  }, [isEditable, editing, onEditStateChange]);

  // The Registry returns a real component for every type (heavy viewers —
  // pdf/docx/xlsx — are React.lazy, so they're code-split but still rendered
  // here). The <Suspense> boundary below resolves the lazy chunk transparently.
  const ViewerComponent = getViewer(artifact.path);
  return (
    <div className="h-full flex flex-col">
      {/* Conflict banner — shown when the file changes on disk while the user
          has UNSAVED edits. Three actions: keep draft, accept the disk version,
          or view a side-by-side diff. The diff is a simple two-column pre layout;
          a proper diff library (e.g. jsdiff) is left for a later refinement pass. */}
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
      {/* Side-by-side diff: left = user draft, right = agent's disk version */}
      {showDiff && conflict && (
        <div className="grid grid-cols-2 gap-0 border-b border-edge shrink-0 overflow-auto max-h-[40%]">
          <div className="p-2 border-r border-edge overflow-auto">
            <div className="text-[10px] text-fg-muted mb-1 font-semibold uppercase tracking-wide">Mine</div>
            <pre className="text-xs font-mono whitespace-pre-wrap text-fg">{draft}</pre>
          </div>
          <div className="p-2 overflow-auto">
            <div className="text-[10px] text-fg-muted mb-1 font-semibold uppercase tracking-wide">On disk</div>
            <pre className="text-xs font-mono whitespace-pre-wrap text-fg">{conflict.disk}</pre>
          </div>
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
