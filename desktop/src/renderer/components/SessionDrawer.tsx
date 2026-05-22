// SessionDrawer — slide-in panel listing artifacts collected during a session.
// Renders the artifact sidebar (list + detail pane) when drawerOpen is true.
// Task 6.1: scaffold only; layout integration (flex row next to chat) is Task 6.2.
// Task 6.3: back-button / ESC handling via useEscClose (same hook as modals/drawers)
// Task 6.4: conflict banner + controlled edit state lifted into ActiveArtifactView
import React, { useCallback, useEffect, useState } from 'react';
import { useArtifact } from '../state/ArtifactContext';
import { useEscClose } from '../hooks/use-esc-close';
import { getViewer } from './artifact-views/RendererRegistry';
import type { ArtifactViewProps } from './artifact-views/RendererRegistry';
import { BinaryFallback } from './artifact-views/BinaryFallback';
import type { ArtifactRecord } from '../../shared/artifacts/types';

interface Props {
  sessionId: string;
  projectRoot: string;
  projectId: string;
  projectName: string;
}

export function SessionDrawer({ sessionId, projectRoot, projectId, projectName }: Props) {
  const { state, dispatch } = useArtifact();
  const artifacts = state.sessionArtifacts[sessionId] ?? [];
  const active = artifacts.find((a) => a.id === state.activeArtifactId);
  const [content, setContent] = useState<string | null>(null);

  // Load file content whenever the active artifact changes.
  useEffect(() => {
    if (!active) { setContent(null); return; }
    let cancelled = false;
    (window.claude as any).artifacts.get(projectRoot, active.id).then((res: any) => {
      if (cancelled) return;
      if (res && res.ok) setContent(res.content ?? null);
    });
    return () => { cancelled = true; };
  }, [active?.id, projectRoot]);

  // Back-button / ESC handling (Task 6.3):
  // When an artifact is active, ESC/back goes to the list (clears active artifact).
  // When only the drawer is open (no active artifact), ESC/back closes the drawer.
  // useEscClose participates in the shared LIFO stack that also handles Android
  // hardware back (App.tsx wires useDismissTop to the android:back WebSocket event).
  const handleBack = useCallback(() => {
    if (state.activeArtifactId) {
      dispatch({ type: 'ACTIVE_ARTIFACT_CLEARED' });
    } else {
      dispatch({ type: 'DRAWER_CLOSED' });
    }
  }, [state.activeArtifactId, dispatch]);

  useEscClose(state.drawerOpen, handleBack);

  // Drawer is hidden when closed — returns null to avoid any layout footprint.
  if (!state.drawerOpen) return null;

  return (
    <aside className="w-[480px] h-full flex bg-panel border-l border-edge shrink-0">
      {/* Left column: artifact list */}
      <div className="w-[180px] border-r border-edge overflow-y-auto flex flex-col shrink-0">
        <div className="p-2 border-b border-edge font-semibold text-sm flex items-center justify-between shrink-0">
          <span>Artifacts ({artifacts.length})</span>
          <button
            className="text-fg-muted hover:text-fg px-1 text-base leading-none"
            onClick={() => dispatch({ type: 'DRAWER_CLOSED' })}
            title="Close drawer"
          >
            ×
          </button>
        </div>
        {artifacts.length === 0 ? (
          <div className="p-3 text-xs text-fg-muted">
            No artifacts yet. Files Claude writes or edits in this session will appear here.
          </div>
        ) : (
          artifacts.map((a) => (
            <ArtifactListItem
              key={a.id}
              artifact={a}
              isActive={state.activeArtifactId === a.id}
              onSelect={() => dispatch({ type: 'ACTIVE_ARTIFACT_SET', artifactId: a.id })}
            />
          ))
        )}
      </div>

      {/* Right column: file viewer */}
      <div className="flex-1 overflow-hidden">
        {active ? (
          <ActiveArtifactView
            artifact={active}
            content={content}
            projectRoot={projectRoot}
            projectId={projectId}
            projectName={projectName}
            sessionId={sessionId}
            onContentChange={setContent}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-fg-muted text-sm">
            Pick an artifact to view
          </div>
        )}
      </div>
    </aside>
  );
}

// ─── ArtifactListItem ────────────────────────────────────────────────────────

interface ListItemProps {
  artifact: ArtifactRecord;
  isActive: boolean;
  onSelect: () => void;
}

function ArtifactListItem({ artifact, isActive, onSelect }: ListItemProps) {
  // Glyph: ☓ deleted, ◐ edited (multiple versions), ● created/unmodified
  const glyph = artifact.status === 'deleted' ? '☓'
    : artifact.versions.length > 1 ? '◐'
    : '●';
  const relTime = formatRelativeTime(artifact.lastModified);
  const fileName = artifact.path.split('/').pop() ?? artifact.path;

  return (
    <button
      className={`w-full text-left px-2 py-2 hover:bg-inset border-b border-edge-dim transition-colors ${
        isActive ? 'bg-inset' : ''
      }`}
      onClick={onSelect}
    >
      <div className="flex items-center gap-1 min-w-0">
        <span className="text-fg-muted shrink-0 text-xs">{glyph}</span>
        <span className="font-mono text-xs truncate flex-1">{fileName}</span>
      </div>
      <div className="text-[10px] text-fg-muted ml-3">{relTime}</div>
    </button>
  );
}

// ─── ActiveArtifactView ──────────────────────────────────────────────────────

interface ActiveArtifactViewProps {
  artifact: ArtifactRecord;
  content: string | null;
  projectRoot: string;
  projectId: string;
  projectName: string;
  sessionId: string;
  onContentChange: (content: string | null) => void;
}

function ActiveArtifactView({
  artifact, content, projectRoot, projectId, projectName, sessionId, onContentChange,
}: ActiveArtifactViewProps) {
  // Resolve the absolute path depending on artifact kind.
  const absolutePath = artifact.kind === 'internal'
    ? `${projectRoot}/${artifact.path}`
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

  // ── Conflict detection: watch for concurrent agent edits while in edit mode ──
  useEffect(() => {
    if (!editing) return;
    // artifacts.onChanged is optional — gracefully skip if IPC not wired yet
    const unsubFn = (window.claude as any).artifacts?.onChanged?.((evt: any) => {
      if (evt.projectRoot === projectRoot && evt.artifactId === artifact.id && evt.by === 'agent') {
        // Fetch the agent's version from disk to display in the conflict banner
        (window.claude as any).artifacts.get(projectRoot, artifact.id).then((res: any) => {
          if (res && res.ok) setConflict({ disk: res.content ?? '' });
        });
      }
    });
    return typeof unsubFn === 'function' ? unsubFn : undefined;
  }, [editing, artifact.id, projectRoot]);

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
      console.error('[SessionDrawer] artifacts.save failed', res);
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

  const resolveUseClaudes = useCallback(() => {
    if (!conflict) return;
    // Accept the agent's disk version: update UI content and exit edit mode
    onContentChange(conflict.disk);
    setDraft(conflict.disk);
    setEditing(false);
    setConflict(null);
  }, [conflict, onContentChange]);

  const viewSpec = getViewer(artifact.path);

  // Lazy-loaded viewers (PdfView, DocxView, XlsxView) are represented as
  // `{ lazy: () => import(...) }` in the Registry. For v1 simplicity we fall
  // back to BinaryFallback (opens externally). A proper React.lazy + Suspense
  // wiring is left for a later pass — the Registry API supports it, but wiring
  // it here requires Suspense boundary bookkeeping that's out of Task 6.1 scope.
  if (typeof viewSpec !== 'function') {
    // viewSpec is { lazy: LazyImporter } — not a component.
    const props: ArtifactViewProps = {
      path: artifact.path,
      content,
      absolutePath,
      isEditable: false,
    };
    return <BinaryFallback {...props} />;
  }

  const ViewerComponent = viewSpec;
  return (
    <div className="h-full flex flex-col">
      {/* Conflict banner — shown when agent edits the same file the user has open
          in edit mode. Three actions: keep draft, accept agent's version, or view
          a side-by-side diff. The diff is a simple two-column pre layout; a proper
          diff library (e.g. diff2html) is left for a later refinement pass. */}
      {conflict && (
        <div className="bg-yellow-100 dark:bg-yellow-900/30 text-yellow-900 dark:text-yellow-100 p-3 text-sm flex flex-wrap gap-x-3 gap-y-1 items-center border-b border-yellow-700/30 shrink-0">
          <span className="flex-1 min-w-0">⚠ Claude also edited this file.</span>
          <button className="underline hover:no-underline whitespace-nowrap" onClick={resolveKeepMine}>
            Keep mine
          </button>
          <button className="underline hover:no-underline whitespace-nowrap" onClick={resolveUseClaudes}>
            Use Claude's
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
            <div className="text-[10px] text-fg-muted mb-1 font-semibold uppercase tracking-wide">Claude's</div>
            <pre className="text-xs font-mono whitespace-pre-wrap text-fg">{conflict.disk}</pre>
          </div>
        </div>
      )}
      <div className="flex-1 overflow-hidden">
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
        />
      </div>
    </div>
  );
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatRelativeTime(iso: string): string {
  if (!iso) return '';
  const date = new Date(iso);
  const diff = (Date.now() - date.getTime()) / 1000; // seconds
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
