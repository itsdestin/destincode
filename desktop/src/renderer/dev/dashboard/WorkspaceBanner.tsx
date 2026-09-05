import type { WorkspaceState } from './api';
import { Disclosure } from './Disclosure';

const TONE_DOT: Record<WorkspaceState['verdict']['tone'], string> = {
  ok: 'bg-green-500',
  warn: 'bg-amber-500',
  stale: 'bg-destructive',
};

function age(seconds: number | null): string {
  if (seconds === null) return 'never checked';
  if (seconds < 90) return 'checked just now';
  if (seconds < 3600) return `checked ${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400) return `checked ${Math.round(seconds / 3600)}h ago`;
  return `checked ${Math.round(seconds / 86400)}d ago`;
}

/** The first thing on the page, because it is the thing that silently governs
 *  every new session. `.claude/rules/`, CLAUDE.md, docs/MAP.md and scripts/ are
 *  read AND RUN from the shared checkout — a stale one hands the next session
 *  stale instructions and stale tooling, and nothing else on this machine says so.
 *  It has sat 175 commits behind for 31 hours without a word. */
export function WorkspaceBanner({ state, checking }: { state: WorkspaceState | null; checking: boolean }) {
  if (!state) {
    return (
      <div className="mb-3 flex items-center gap-2 rounded-lg border border-edge-dim bg-panel px-3 py-2">
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-fg-muted/40" />
        <span className="text-3xs text-fg-muted">Checking whether the workspace is up to date…</span>
      </div>
    );
  }

  const { verdict, workspace, repos } = state;
  const behindRepos = repos.filter((r) => (r.behind ?? 0) > 0);

  return (
    <div className="mb-3 rounded-lg border border-edge-dim bg-panel px-3 py-2">
      <div className="flex items-center gap-2">
        <span
          className={`h-2 w-2 shrink-0 rounded-full ${TONE_DOT[verdict.tone]} ${checking ? 'animate-pulse' : ''}`}
          aria-hidden="true"
        />
        <span className="text-sm text-fg">{verdict.headline}</span>
        <span className="flex-1" />
        <span className="shrink-0 text-3xs text-fg-faint">{age(workspace?.fetchAgeSeconds ?? null)}</span>
      </div>

      {/* The consequence, in words, not a git count. "38 behind" means nothing
          on its own; "new sessions are loading guidance that is 38 updates out of
          date" is the sentence that makes it worth acting on. */}
      <p className="mt-1 text-3xs leading-relaxed text-fg-muted">{verdict.detail}</p>

      {behindRepos.length > 0 && (
        <p className="mt-1 text-3xs text-fg-muted">
          Also behind: {behindRepos.map((r) => `${r.name} (${r.behind})`).join(', ')}
        </p>
      )}

      {verdict.tone === 'stale' && (
        <div className="mt-2">
          <Disclosure summary="What to do about it">
            {workspace?.blocking.length
              ? `These local files disagree with the incoming updates and are stopping the sync:\n`
                + `${workspace.blocking.map((f) => `  ${f}`).join('\n')}\n\n`
                + 'Ask Claude to check each one — usually they are leftovers of work that was\n'
                + 'already pushed from a worktree, and clearing them costs nothing. Then run\n'
                + '  bash setup.sh\n'
              : 'Nothing is blocking the update. Run:\n  bash setup.sh\n'}
          </Disclosure>
        </div>
      )}
    </div>
  );
}
