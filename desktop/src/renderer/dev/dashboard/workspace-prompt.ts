import type { WorkspaceState } from './api';

/** The prompt a fresh conversation gets when the workspace is behind.
 *
 *  WHY a prompt rather than a "Sync now" button: the blocking files are the whole
 *  problem, and deciding what to do with each one is a judgement. Usually they are
 *  leftovers of work already pushed from a worktree and discarding them costs
 *  nothing — but "usually" is not "always", and this session found two that were
 *  genuinely another session's unpushed work. A button that resolved that for you
 *  would eventually throw away the one that mattered.
 *
 *  It carries the counts so the reader can re-check them rather than trust them. */
export function buildWorkspacePrompt(state: WorkspaceState): string {
  const w = state.workspace;
  if (!w) return 'The dev dashboard could not find a git repo at the workspace root. Please look into why.';

  if (w.fetchFailed) {
    return (
      'The dev dashboard could not check whether my youcoded-dev workspace is up to date — '
      + 'the fetch from GitHub failed.\n\n'
      + 'Please find out why (offline? credentials? remote renamed?) and tell me in plain terms '
      + 'whether my workspace is currently behind.\n'
    );
  }

  const behindRepos = state.repos.filter((r) => (r.behind ?? 0) > 0);
  const alsoBehind = behindRepos.length
    ? `\nAlso behind: ${behindRepos.map((r) => `${r.name} (${r.behind})`).join(', ')}.\n`
    : '';

  const blockers = w.blocking.length
    ? `\n${w.blocking.length} local file(s) are blocking the update — these are files I have `
      + 'changed here that the incoming commits also touch:\n'
      + `${w.blocking.map((f) => `  ${f}`).join('\n')}\n\n`
      + 'For EACH one, check whether the local copy actually contains anything the remote does '
      + 'not already have. Most of the time it is residue from work that was already pushed from '
      + 'a worktree, and clearing it loses nothing — but not always, so check rather than assume, '
      + 'and tell me before discarding anything that is genuinely only here.\n'
    : '\nNothing is blocking the update.\n';

  return (
    `My youcoded-dev workspace is ${w.behind} commit(s) behind origin, so new Claude sessions are `
    + 'loading guidance, rules and scripts that are out of date.\n'
    + `${blockers}${alsoBehind}`
    + `\nThere are also ${w.dirty} uncommitted file(s) in the workspace overall; the ones listed `
    + 'above are the subset that actually block a pull.\n\n'
    + 'Please get the workspace synced (bash setup.sh once the blockers are resolved), and tell me '
    + 'in plain terms what was in the way and what you did with it.\n'
  );
}
