// desktop/src/renderer/components/FolderSwitcher.tsx
// The session picker's folder dropdown. Per the 2026-07-09 project-sync UX
// spec this component ONLY picks: adding/importing/syncing projects moved to
// Project View, reached via the single "Manage projects…" footer entry.
// Each row carries a sync dot (green syncing / red problem / gray not in
// sync) whose tooltip holds the full plain-language phrase.
import React, { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useScrollFade } from '../hooks/useScrollFade';
import { useEscClose } from '../hooks/use-esc-close';
import { syncDotFor, type SyncStatusData } from './sync-dot-state';

interface SavedFolder {
  path: string;
  nickname: string;
  addedAt: number;
  exists: boolean;
  // Kept solely to mirror the FOLDERS_LIST IPC payload shape — rows arrive
  // with this flag, but nothing in this file reads it anymore (the sync dot
  // supersedes the old "synced project" managed badge).
  managed?: boolean;
}

interface Props {
  /** Currently selected folder path */
  value: string;
  /** Called when user selects a folder */
  onChange: (path: string) => void;
  /** Auto-select the first saved folder when value is empty (default: true) */
  autoSelect?: boolean;
  /** Opens Project View ("Manage projects…"). Omitted where Project View
   *  doesn't exist (the buddy window) — the footer row hides itself. */
  onManageProjects?: () => void;
}

// Dot colors: status colors are theme-independent by design-system rule.
// Red matches the app's existing #DD4444; green mirrors the SessionDot green.
const DOT_CLASS: Record<'green' | 'red' | 'gray', string> = {
  green: 'bg-[#44A05C]',
  red: 'bg-[#DD4444]',
  gray: 'bg-fg-faint',
};

export default function FolderSwitcher({ value, onChange, autoSelect = true, onManageProjects }: Props) {
  const [folders, setFolders] = useState<SavedFolder[]>([]);
  const [open, setOpen] = useState(false);
  const [editingPath, setEditingPath] = useState<string | null>(null);
  const [editNickname, setEditNickname] = useState('');
  const [syncStatus, setSyncStatus] = useState<SyncStatusData | null>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // The dropdown panel is PORTALED to document.body (see render below), so it
  // needs its own ref for the outside-click check — it is no longer a DOM
  // child of wrapperRef.
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useScrollFade<HTMLDivElement>();
  // Fixed-position coordinates for the portaled dropdown, computed from the
  // trigger button's screen rect whenever the dropdown opens (and on resize).
  const [panelPos, setPanelPos] = useState<{ top: number; left: number; maxHeight: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const list = await (window as any).claude.folders.list();
      setFolders(list);
      // Auto-select the first folder (home) when no value is set
      if (autoSelect && !value && list.length > 0) {
        onChange(list[0].path);
      }
    } catch {}
  }, [value, onChange, autoSelect]);

  useEffect(() => { load(); }, [load]);

  // Fetch sync state when the dropdown opens. catch → null: on Android the
  // shim has no syncspaces handlers (30s reject) — rows simply render no dot.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (window as any).claude.syncSpaces.status()
      .then((s: SyncStatusData) => { if (!cancelled) setSyncStatus(s); })
      .catch(() => { if (!cancelled) setSyncStatus(null); });
    return () => { cancelled = true; };
  }, [open]);

  // Position the portaled dropdown under the trigger, clamped to the viewport.
  // WHY a portal + fixed positioning at all: this picker lives inside the
  // SessionStrip's new-session menu, whose rounded-corner containers use
  // overflow-hidden — an absolutely-positioned child gets CLIPPED at the menu
  // edges (cut-off icons, truncated list). Portaling to document.body lets the
  // dropdown float above the host menu instead of being squeezed inside it.
  // Must match the `w-72` Tailwind class on the panel div (288px = 18rem) —
  // if one changes, change the other, or the clamping math here silently
  // drifts from the panel's real rendered width.
  const PANEL_WIDTH = 288;
  const measure = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const margin = 8;
    const left = Math.min(
      Math.max(rect.left + rect.width / 2 - PANEL_WIDTH / 2, margin),
      window.innerWidth - PANEL_WIDTH - margin
    );
    const top = rect.bottom + 4;
    // Never extend past the viewport bottom — the panel scrolls instead.
    const maxHeight = Math.max(window.innerHeight - top - margin, 120);
    setPanelPos({ top, left, maxHeight });
  }, []);

  useLayoutEffect(() => {
    if (!open) { setPanelPos(null); return; }
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [open, measure]);

  // Close panel on outside click/tap. The panel is portaled, so "inside" means
  // inside the trigger wrapper OR inside the floating panel itself.
  useEffect(() => {
    if (!open) return;
    const handler = (e: Event) => {
      const t = e.target as Node;
      if (wrapperRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
      setEditingPath(null);
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
    };
  }, [open]);

  // Close panel on Escape — routed through the central useEscClose LIFO stack
  // so chat-passthrough preventDefault works consistently with other overlays.
  const handleEscClose = useCallback(() => {
    setOpen(false);
    setEditingPath(null);
  }, []);
  useEscClose(open, handleEscClose);

  // Focus nickname input when editing starts
  useEffect(() => {
    if (editingPath && editRef.current) {
      editRef.current.focus();
      editRef.current.select();
    }
  }, [editingPath]);

  const handleSelect = useCallback((path: string) => {
    onChange(path);
    setOpen(false);
    setEditingPath(null);
  }, [onChange]);

  const handleRemove = useCallback(async (e: React.MouseEvent, folderPath: string) => {
    e.stopPropagation();
    await (window as any).claude.folders.remove(folderPath);
    await load();
    // If we just removed the selected folder, clear selection
    if (value === folderPath) onChange('');
  }, [value, onChange, load]);

  const handleStartRename = useCallback((e: React.MouseEvent, folder: SavedFolder) => {
    e.stopPropagation();
    setEditingPath(folder.path);
    setEditNickname(folder.nickname);
  }, []);

  const handleFinishRename = useCallback(async () => {
    if (!editingPath || !editNickname.trim()) {
      setEditingPath(null);
      return;
    }
    await (window as any).claude.folders.rename(editingPath, editNickname.trim());
    await load();
    setEditingPath(null);
  }, [editingPath, editNickname, load]);

  // Find nickname for current value
  const currentFolder = folders.find(f => f.path === value);
  const displayLabel = currentFolder
    ? currentFolder.nickname
    : value
      ? value.replace(/\\/g, '/').split('/').pop() || value
      : 'Select folder...';

  return (
    <div ref={wrapperRef} className="relative">
      {/* Trigger button — shows current selection */}
      <button
        ref={triggerRef}
        onClick={() => setOpen(!open)}
        className="w-full text-left px-2.5 py-1.5 bg-inset border border-edge rounded-md text-xs text-fg-2 hover:border-edge transition-colors truncate flex items-center gap-1.5"
      >
        <svg className="w-3 h-3 shrink-0 text-fg-muted" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
        </svg>
        <span className="flex-1 truncate">{displayLabel}</span>
        <svg className={`w-3 h-3 shrink-0 text-fg-faint transition-transform ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {/* Full path hint below trigger */}
      {value && (
        <div className="mt-0.5 px-1 text-[10px] text-fg-faint truncate" title={value}>
          {value}
        </div>
      )}

      {/* Dropdown panel — uses .layer-surface for theme-driven background,
          border, shadow, and glassmorphism (blur/opacity from --panels-* vars).
          PORTALED to document.body with fixed positioning so the host menu's
          overflow-hidden can't clip it (see the WHY on `measure` above).
          zIndex 9001: the SessionStrip menu that hosts this picker is the
          documented z-[9000] exception (PITFALLS → Overlays) — a popover
          spawned FROM that menu must render above its own host. */}
      {open && panelPos && createPortal(
        <div
          ref={panelRef}
          className="layer-surface fixed w-72 overflow-hidden flex flex-col"
          style={{ top: panelPos.top, left: panelPos.left, maxHeight: panelPos.maxHeight, zIndex: 9001, animation: 'dropdown-in 120ms cubic-bezier(0.16, 1, 0.3, 1) both' }}
        >
          {/* Saved folders list — min-h-0 lets flexbox shrink the list first
              when the viewport-clamped panel height is tight. */}
          {folders.length > 0 && (
            <div ref={listRef} className="scroll-fade max-h-48 min-h-0">
              <div className="py-1">
              {folders.map((f) => {
                const isSelected = f.path === value;
                const isEditing = editingPath === f.path;
                const dot = syncDotFor(f.path, syncStatus);

                return (
                  <div
                    key={f.path}
                    onClick={() => !isEditing && handleSelect(f.path)}
                    className={`group/folder flex items-center gap-1.5 px-2.5 py-1.5 cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-accent/10 text-fg'
                        : f.exists
                          ? 'text-fg-2 hover:bg-inset hover:text-fg'
                          : 'text-fg-faint hover:bg-inset'
                    }`}
                  >
                    {/* Folder icon */}
                    <svg className={`w-3 h-3 shrink-0 ${f.exists ? 'text-fg-muted' : 'text-[#DD4444]/60'}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                    </svg>

                    {/* Nickname (editable) or display */}
                    <div className="flex-1 min-w-0">
                      {isEditing ? (
                        <input
                          ref={editRef}
                          value={editNickname}
                          onChange={(e) => setEditNickname(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleFinishRename();
                            if (e.key === 'Escape') setEditingPath(null);
                          }}
                          onBlur={handleFinishRename}
                          onClick={(e) => e.stopPropagation()}
                          className="w-full bg-inset border border-edge rounded-sm px-1 py-0.5 text-xs text-fg outline-none focus:border-accent"
                        />
                      ) : (
                        <>
                          <div className="text-xs truncate">{f.nickname}</div>
                          <div className="text-[10px] text-fg-faint truncate" title={f.path}>
                            {f.path}
                          </div>
                        </>
                      )}
                    </div>

                    {/* Stale warning */}
                    {!f.exists && !isEditing && (
                      <span className="text-[9px] text-[#DD4444]/80 shrink-0" title="Directory not found">
                        missing
                      </span>
                    )}

                    {/* Action buttons — visible on hover */}
                    {!isEditing && (
                      <div className="shrink-0 flex items-center gap-0.5 opacity-0 group-hover/folder:opacity-100 transition-opacity">
                        {/* Rename */}
                        <button
                          onClick={(e) => handleStartRename(e, f)}
                          className="w-5 h-5 flex items-center justify-center rounded-sm text-fg-faint hover:text-fg hover:bg-inset transition-colors"
                          title="Rename"
                        >
                          <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                          </svg>
                        </button>
                        {/* Remove */}
                        <button
                          onClick={(e) => handleRemove(e, f.path)}
                          className="w-5 h-5 flex items-center justify-center rounded-sm text-fg-faint hover:text-[#DD4444] hover:bg-inset transition-colors"
                          title="Remove from list"
                        >
                          <svg className="w-2.5 h-2.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                          </svg>
                        </button>
                      </div>
                    )}

                    {/* Selected check */}
                    {isSelected && !isEditing && (
                      <svg className="w-3 h-3 shrink-0 text-accent" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}

                    {/* Sync dot — green syncing / red problem / gray not in
                        sync; the tooltip carries the full phrase. Renders only
                        when syncSpaces.status() resolved (desktop). */}
                    {dot && !isEditing && (
                      <span
                        className={`w-2 h-2 rounded-full shrink-0 ${DOT_CLASS[dot.color]}`}
                        title={dot.label}
                        aria-label={dot.label}
                      />
                    )}
                  </div>
                );
              })}
              </div>
            </div>
          )}

          {/* Footer: the ONLY action — everything about adding/importing/
              syncing projects lives in Project View (spec decision 3). */}
          {onManageProjects ? (
            <div className="border-t border-edge">
              <button
                onClick={() => { setOpen(false); onManageProjects(); }}
                className="w-full px-2.5 py-2 text-xs text-fg-dim hover:bg-inset hover:text-fg transition-colors flex items-center justify-center gap-1.5"
              >
                Manage projects…
              </button>
            </div>
          ) : (
            // WHY: the main picker deliberately has no add actions (spec
            // decision 3 — Project View owns adding), but windows WITHOUT
            // Project View (the buddy window has no ArtifactProvider) need a
            // minimal escape hatch to add a folder — otherwise there is NO way
            // to add one there (a regression). This row renders ONLY when
            // onManageProjects is absent.
            <div className="border-t border-edge">
              <button
                onClick={async () => {
                  try {
                    const folder = await (window as any).claude.dialog.openFolder();
                    if (folder) {
                      await (window as any).claude.folders.add(folder);
                      await load();
                      onChange(folder);
                      setOpen(false);
                    }
                  } catch {
                    // Swallow: user cancel resolves to null (handled above);
                    // anything thrown here (e.g. dialog unavailable) is a no-op.
                  }
                }}
                className="w-full px-2.5 py-2 text-xs text-fg-dim hover:bg-inset hover:text-fg transition-colors flex items-center justify-center gap-1.5"
              >
                Browse for folder…
              </button>
            </div>
          )}
        </div>,
        document.body
      )}
    </div>
  );
}
