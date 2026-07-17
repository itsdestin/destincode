import { useEffect, useState } from 'react';

export interface ActiveProject {
  id: string;
  name: string;
  path: string;
}

/**
 * Resolve the active project (id / name / path) for the artifact drawer's
 * in-place `save` IPC — it needs the project sidecar target for the session's
 * cwd. Lazy: only resolves when `enabled` and a `cwd` is available; returns
 * null until then. On any miss (no index, cwd not registered yet, IPC error)
 * it falls back to the raw cwd as the path, because the save handler treats
 * projectRoot as a filesystem path, not a registry key.
 *
 * Extracted from ChatView so the terminal-view panel overlay (TerminalRightSlot)
 * resolves the SAME target — both render SessionDrawer against one project.
 */
export function useActiveProject(cwd: string | undefined, enabled: boolean): ActiveProject | null {
  const [activeProject, setActiveProject] = useState<ActiveProject | null>(null);

  useEffect(() => {
    if (!enabled || !cwd) {
      setActiveProject(null);
      return;
    }
    let cancelled = false;
    (window.claude as any).artifacts.listProjectsIndex().then((res: any) => {
      if (cancelled) return;
      if (!res || !res.ok || !Array.isArray(res.projects)) {
        setActiveProject({ id: '', name: 'project', path: cwd });
        return;
      }
      // Normalize separators for comparison (Windows paths use backslashes).
      const normalizedCwd = cwd.replace(/\\/g, '/');
      const candidate = (res.projects as ActiveProject[]).find(
        (p) => p.path === cwd || p.path === normalizedCwd || p.path === normalizedCwd.toLowerCase(),
      );
      setActiveProject(candidate ?? { id: '', name: 'project', path: cwd });
    }).catch(() => {
      // IPC failure — still provide cwd so the drawer is not completely broken.
      if (!cancelled && cwd) setActiveProject({ id: '', name: 'project', path: cwd });
    });
    return () => { cancelled = true; };
  }, [cwd, enabled]);

  return activeProject;
}
