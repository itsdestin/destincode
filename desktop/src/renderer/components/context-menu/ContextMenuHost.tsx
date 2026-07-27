import React, { useEffect, useState } from 'react';
import { buildContextMenu, type MenuEntry } from './build-menu';
import { ContextMenu } from './ContextMenu';
import { useReference } from '../../state/reference-context';

// Single app-wide right-click host. Listens for `contextmenu` (capture) on the
// document, asks build-menu what (if anything) applies to the target, and — only
// when there's something actionable — suppresses the default menu and opens ours.
// Targets outside chat content / the composer are left untouched (terminal,
// settings, remote-browser native menu, etc.). Mounted once from App.

type MenuState = { x: number; y: number; entries: MenuEntry[] };

// Issue C (final review): resolve the TRUE element under the pointer when the
// reference overlay's scrim (or any of its chrome — the trace svg, the
// lifted clone card, the cancel button) sits on top. `.reference-scrim` is a
// window-wide `pointer-events: auto` layer (ReferenceOverlay.tsx) rendered
// while a reference is held, so a plain `e.target` lookup during a
// right-click over a dimmed chat message always resolves to the SCRIM, not
// the message — and buildContextMenu's `.chat-scroll` ancestry gate then
// bails, because the scrim lives outside `.chat-scroll`. That silently killed
// spec §7's "second 'Ask about this' while one is held → replaces it" for
// chat. (Artifact references happened to keep working, but by accident: the
// lifted clone is pinned exactly over the source and cloneNode(true) copies
// the `data-artifact-viewer`/`data-doc-path` attributes onto it, so a
// right-click that lands on the CLONE resolves via that attribute check
// before build-menu.ts's `.chat-scroll` gate is ever reached. That's a
// coincidence of the artifact clone's markup, not something chat can lean
// on.) `elementsFromPoint` walks every element painted at this point,
// TOPMOST first, honoring real stacking order — so this finds whatever is
// genuinely under the cursor (the dimmed message, or the real artifact
// container beneath a clipped/pinned clone) instead of trusting `e.target`.
function resolveContextMenuTarget(e: MouseEvent): HTMLElement | null {
  const raw = e.target as HTMLElement | null;
  if (!raw) return null;
  // Fast path: no reference held (`.reference-scrim` isn't in the DOM at
  // all — ReferenceOverlay renders null) or the click landed somewhere
  // outside the overlay's chrome entirely. Leaves today's behavior
  // untouched byte-for-byte in the common case.
  if (!raw.closest('.reference-scrim')) return raw;
  const stack = document.elementsFromPoint(e.clientX, e.clientY);
  const real = stack.find((el) => !el.closest('.reference-scrim'));
  return (real as HTMLElement) ?? null;
}

export function ContextMenuHost() {
  const [menu, setMenu] = useState<MenuState | null>(null);
  // "Ask about this" now hands the menu a PendingReference instead of
  // dispatching the old composer-scaffold CustomEvent — see reference-context.tsx.
  const { setReference } = useReference();

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = resolveContextMenuTarget(e);
      if (!target) return;
      const entries = buildContextMenu(target, setReference);
      if (!entries) return; // not our surface — leave the default behavior alone
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, entries });
    };
    document.addEventListener('contextmenu', onContextMenu, true);
    return () => document.removeEventListener('contextmenu', onContextMenu, true);
    // setReference is useCallback-stable (reference-context.tsx), so listing it
    // here does not re-subscribe the listener on every render.
  }, [setReference]);

  if (!menu) return null;
  return <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />;
}
