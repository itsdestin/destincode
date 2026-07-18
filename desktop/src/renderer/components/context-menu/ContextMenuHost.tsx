import React, { useEffect, useState } from 'react';
import { buildContextMenu, type MenuEntry } from './build-menu';
import { ContextMenu } from './ContextMenu';

// Single app-wide right-click host. Listens for `contextmenu` (capture) on the
// document, asks build-menu what (if anything) applies to the target, and — only
// when there's something actionable — suppresses the default menu and opens ours.
// Targets outside chat content / the composer are left untouched (terminal,
// settings, remote-browser native menu, etc.). Mounted once from App.

type MenuState = { x: number; y: number; entries: MenuEntry[] };

export function ContextMenuHost() {
  const [menu, setMenu] = useState<MenuState | null>(null);

  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      const entries = buildContextMenu(target);
      if (!entries) return; // not our surface — leave the default behavior alone
      e.preventDefault();
      setMenu({ x: e.clientX, y: e.clientY, entries });
    };
    document.addEventListener('contextmenu', onContextMenu, true);
    return () => document.removeEventListener('contextmenu', onContextMenu, true);
  }, []);

  if (!menu) return null;
  return <ContextMenu x={menu.x} y={menu.y} entries={menu.entries} onClose={() => setMenu(null)} />;
}
