// Footer data for the git surface. Fetches git:file-status for the open file
// and refreshes on BOTH change feeds: artifacts:changed (worktree edits, from
// the chokidar watcher) and git:changed (commits/checkouts/staging, from the
// .git watcher — the chokidar one ignores .git/ by design).
// On Android/remote every call rejects (unsupported) and the hook settles to
// null — the footer then renders exactly as it does today. Same graceful
// degradation as content search (FilesTab).
import { useEffect, useState } from 'react';
import type { GitFileStatusResult } from '../../shared/git-types';

export function useGitFileStatus(
  projectRoot: string,
  relPath: string | null,
  enabled: boolean,
): GitFileStatusResult | null {
  const [status, setStatus] = useState<GitFileStatusResult | null>(null);

  useEffect(() => {
    setStatus(null);
    if (!enabled || !relPath || !projectRoot) return;
    const api = (window as any).claude?.git;
    if (!api?.fileStatus) return;
    let alive = true;

    const refresh = () => {
      api.fileStatus(projectRoot, relPath)
        .then((r: GitFileStatusResult) => { if (alive) setStatus(r?.ok ? r : null); })
        .catch(() => { if (alive) setStatus(null); });
    };
    refresh();
    api.watch?.(projectRoot)?.catch?.(() => {});
    const offGit = api.onChanged?.(() => refresh()) ?? (() => {});
    const offArtifacts = (window as any).claude?.artifacts?.onChanged?.((evt: any) => {
      if (evt?.projectRoot === projectRoot) refresh();
    }) ?? (() => {});

    return () => {
      alive = false;
      offGit();
      offArtifacts();
      api.unwatch?.(projectRoot)?.catch?.(() => {});
    };
  }, [projectRoot, relPath, enabled]);

  return status;
}
