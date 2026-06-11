// SessionDrawer — slide-in panel listing artifacts collected during a session.
// Renders the artifact sidebar (list + detail pane) when drawerOpen is true.
// Task 6.1: scaffold only; layout integration (flex row next to chat) is Task 6.2.
// Task 6.3: back-button / ESC handling via useEscClose (same hook as modals/drawers)
// Task 6.4: conflict banner + controlled edit state lifted into ActiveArtifactView
// Task 7.2: ActiveArtifactView extracted to artifact-views/ActiveArtifactView.tsx
//           so ProjectView can share the same component without duplication.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useArtifact } from '../state/ArtifactContext';
import { useTheme } from '../state/theme-context';
import { useEscClose } from '../hooks/use-esc-close';
import { ActiveArtifactView } from './artifact-views/ActiveArtifactView';
import type { ArtifactRecord } from '../../shared/artifacts/types';
import { categorizeArtifact } from '../../shared/artifacts/categorization';

interface Props {
  sessionId: string;
  projectRoot: string;
  projectId: string;
  projectName: string;
}

export function SessionDrawer({ sessionId, projectRoot, projectId, projectName }: Props) {
  const { state, dispatch } = useArtifact();
  const { hideCodeAndConfigs, setHideCodeAndConfigs, showDeletedArtifacts, setShowDeletedArtifacts } = useTheme();
  const allArtifacts = state.sessionArtifacts[sessionId] ?? [];

  // Existence check: ask main if each tracked artifact's file still exists on
  // disk. Artifacts whose file is gone are folded into the "deleted" UI state
  // alongside explicit delete versions. Re-runs when the tracker adds or
  // removes entries (allArtifacts.length).
  const [orphanIds, setOrphanIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    if (!state.drawerOpen || allArtifacts.length === 0 || !projectRoot) {
      setOrphanIds(new Set());
      return;
    }
    let cancelled = false;
    const ids = allArtifacts.map((a) => a.id);
    (window.claude as any).artifacts.checkExistence(projectRoot, ids)
      .then((res: any) => {
        if (cancelled || !res?.ok) return;
        setOrphanIds(new Set(res.missingIds ?? []));
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [state.drawerOpen, allArtifacts.length, projectRoot]);

  // Apply BOTH filters together — derive isDeleted from explicit delete status
  // OR missing-on-disk orphan signal, then hide deleted unless the user opted in.
  const artifacts = useMemo(() => {
    return allArtifacts.filter((a) => {
      if (hideCodeAndConfigs && categorizeArtifact(a.path) !== 'document') return false;
      const isDeleted = a.status === 'deleted' || orphanIds.has(a.id);
      if (isDeleted && !showDeletedArtifacts) return false;
      return true;
    });
  }, [allArtifacts, hideCodeAndConfigs, showDeletedArtifacts, orphanIds]);
  const hiddenCount = allArtifacts.length - artifacts.length;
  const deletedCount = useMemo(
    () => allArtifacts.filter((a) => a.status === 'deleted' || orphanIds.has(a.id)).length,
    [allArtifacts, orphanIds],
  );
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
    <aside className="w-[480px] h-full flex bg-inset shrink-0">
      {/* Left column: artifact list */}
      <div className="w-[180px] border-r border-edge overflow-y-auto flex flex-col shrink-0">
        <div className="border-b border-edge shrink-0">
          <div className="p-2 font-semibold text-sm flex items-center justify-between">
            <span>Artifacts ({artifacts.length})</span>
            <button
              className="text-fg-muted hover:text-fg px-1 text-base leading-none"
              onClick={() => dispatch({ type: 'DRAWER_CLOSED' })}
              title="Close drawer"
            >
              ×
            </button>
          </div>
          {/* Filter toggles — shared preferences, also appear in Project View.
              Hide code & configs defaults ON. Show deleted defaults OFF. */}
          <button
            type="button"
            className={`w-full text-left px-2 py-1.5 text-[11px] border-t border-edge-dim flex items-center justify-between transition-colors ${
              hideCodeAndConfigs ? 'bg-inset text-fg' : 'text-fg-muted hover:text-fg hover:bg-inset'
            }`}
            onClick={() => setHideCodeAndConfigs(!hideCodeAndConfigs)}
            title={hideCodeAndConfigs
              ? 'Showing Documents and Mockups only. Click to show all.'
              : 'Showing all files. Click to hide code & configs.'}
          >
            <span className="flex items-center gap-1.5">
              <span className="text-sm leading-none">{hideCodeAndConfigs ? '☑' : '☐'}</span>
              <span>Hide code &amp; configs</span>
            </span>
          </button>
          <button
            type="button"
            className={`w-full text-left px-2 py-1.5 text-[11px] border-t border-edge-dim flex items-center justify-between transition-colors ${
              showDeletedArtifacts ? 'bg-inset text-fg' : 'text-fg-muted hover:text-fg hover:bg-inset'
            }`}
            onClick={() => setShowDeletedArtifacts(!showDeletedArtifacts)}
            title={showDeletedArtifacts
              ? 'Including deleted files in the list. Click to hide them.'
              : `Hiding deleted files${deletedCount > 0 ? ` — ${deletedCount} hidden` : ''}. Click to include them.`}
          >
            <span className="flex items-center gap-1.5">
              <span className="text-sm leading-none">{showDeletedArtifacts ? '☑' : '☐'}</span>
              <span>Show deleted</span>
            </span>
            {!showDeletedArtifacts && deletedCount > 0 && (
              <span className="text-fg-muted">+{deletedCount}</span>
            )}
          </button>
        </div>
        {artifacts.length === 0 ? (
          <div className="p-3 text-xs text-fg-muted">
            {hideCodeAndConfigs && hiddenCount > 0
              ? <>No documents yet — {hiddenCount} code/config file{hiddenCount === 1 ? '' : 's'} hidden. Toggle off above to view all.</>
              : <>No artifacts yet. Files Claude writes or edits in this session will appear here.</>}
          </div>
        ) : (
          artifacts.map((a) => (
            <ArtifactListItem
              key={a.id}
              artifact={a}
              isActive={state.activeArtifactId === a.id}
              isDeleted={a.status === 'deleted' || orphanIds.has(a.id)}
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
  isDeleted: boolean;
  onSelect: () => void;
}

function ArtifactListItem({ artifact, isActive, isDeleted, onSelect }: ListItemProps) {
  // Glyph priority: ✕ deleted (explicit delete OR file gone), ◐ edited
  // (multiple versions), ● created/unmodified.
  const glyph = isDeleted ? '✕'
    : artifact.versions.length > 1 ? '◐'
    : '●';
  const relTime = formatRelativeTime(artifact.lastModified);
  const fileName = artifact.path.split('/').pop() ?? artifact.path;

  return (
    <button
      className={`w-full text-left px-2 py-2 hover:bg-inset border-b border-edge-dim transition-colors ${
        isActive ? 'bg-inset' : ''
      } ${isDeleted ? 'opacity-50' : ''}`}
      onClick={onSelect}
      title={isDeleted ? 'Deleted (file is no longer on disk)' : undefined}
    >
      <div className="flex items-center gap-1 min-w-0">
        <span className="text-fg-muted shrink-0 text-xs">{glyph}</span>
        <span className={`font-mono text-xs truncate flex-1 ${isDeleted ? 'line-through' : ''}`}>{fileName}</span>
      </div>
      <div className="text-[10px] text-fg-muted ml-3">{relTime}</div>
    </button>
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
