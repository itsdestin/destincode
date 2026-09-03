// WHY this exists: the chokidar project watcher (artifacts/project-watcher.ts)
// deliberately ignores dot-directories, so commits, checkouts and staging —
// which only touch .git/ — are invisible to it. This tiny fs.watch on the
// .git dir (HEAD + index live there) and .git/refs/heads keeps the git
// surface honest when the agent or a terminal moves git state underneath it.
// Same refcount model as project-watcher: N renderers x M roots.
import fs from 'fs';
import path from 'path';

export interface GitWatchEvent {
  repoRoot: string;
}

type Emit = (evt: GitWatchEvent) => void;

const DEBOUNCE_MS = 300;

// WHY a reconcile emit on subscribe: on macOS, fs.watch() RETURNS BEFORE THE
// WATCH IS ARMED. libuv hands the request to a CoreFoundation run loop on
// another thread, so anything that changes between the call and the arming is
// never reported — not late, never. Linux (inotify) and Windows
// (ReadDirectoryChangesW) arm inside the call and have no such window.
//
// Measured on a 3-core macOS CI runner under CPU contention, with
// scripts/diag/fswatch-probe.mjs (bare fs.watch, no app code): 4 of 200 changes
// written immediately after the call were lost, 0 of 200 when the write came
// 5ms later, 0 of 200 at 25ms — while Linux lost 0 of 200 at every gap. That is
// the whole of the recurring macOS CI failure in this file and in
// sync-spaces-engine, and it is a real defect in the app, not just in a test:
// a commit made in the instant after a project opens would go unnoticed.
//
// There is no "armed" event to wait for. fs.watch has none, and chokidar's
// 'ready' does not cover it either (that hypothesis was tested and disproven —
// see the investigation). So rather than trying to observe arming, we make
// missing the window harmless: subscribing schedules one event through the SAME
// debounce a real change uses. Consumers re-read git state, exactly as they
// would for a change they were told about, so a change lost to the window is
// still acted on. A real change arriving during the debounce coalesces into
// that one emit rather than adding to it.
//
// Unconditional rather than darwin-only on purpose: the cost is one extra git
// status read per subscribe, and platform-forked behaviour here would mean the
// path that matters is the one nobody runs locally.

interface Entry {
  watchers: fs.FSWatcher[];
  refs: Map<number, number>; // subscriberId -> refcount
  timer: ReturnType<typeof setTimeout> | null;
}

let emit: Emit | null = null;
const entries = new Map<string, Entry>();

export function initGitWatchers(cb: Emit): void {
  emit = cb;
}

// WHY: for a LINKED worktree (`git worktree add`), <repoRoot>/.git is not a
// directory — it's a file containing a single line `gitdir: <path>` pointing
// at <main-repo>/.git/worktrees/<name>/. HEAD and the index for that
// worktree live under THAT directory, not under <repoRoot>/.git itself, and
// refs/heads is shared and lives under the main repo's real .git (found via
// that dir's `commondir` file, which may itself be a relative path). Without
// this resolution, fs.watch would watch the plain gitdir FILE (never fires
// for a commit) and the refs/heads watch would throw on a path that doesn't
// exist there, leaving watchGit lying with {ok:true} on a dead watcher.
function resolveGitDirs(repoRoot: string): { gitDir: string; refsHeadsDir: string } | null {
  const dotGit = path.join(repoRoot, '.git');
  let stat: fs.Stats;
  try { stat = fs.statSync(dotGit); } catch { return null; }
  if (stat.isDirectory()) {
    return { gitDir: dotGit, refsHeadsDir: path.join(dotGit, 'refs', 'heads') };
  }
  if (!stat.isFile()) return null;
  let contents: string;
  try { contents = fs.readFileSync(dotGit, 'utf8'); } catch { return null; }
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(contents);
  if (!m) return null;
  const gitDir = path.isAbsolute(m[1]) ? m[1] : path.resolve(repoRoot, m[1]);
  if (!fs.existsSync(gitDir)) return null;
  // commondir holds the path (often relative, resolved against gitDir) to the
  // real .git that refs/heads lives under — shared across all linked worktrees.
  const commondirFile = path.join(gitDir, 'commondir');
  let commonDir = gitDir;
  try {
    const raw = fs.readFileSync(commondirFile, 'utf8').trim();
    commonDir = path.isAbsolute(raw) ? raw : path.resolve(gitDir, raw);
  } catch { /* no commondir -> this IS the main repo's gitdir (shouldn't happen for a file .git, but degrade gracefully) */ }
  return { gitDir, refsHeadsDir: path.join(commonDir, 'refs', 'heads') };
}

export function watchGit(repoRoot: string, subscriberId: number): { ok: boolean } {
  let entry = entries.get(repoRoot);
  if (!entry) {
    const dirs = resolveGitDirs(repoRoot);
    if (!dirs) return { ok: false };
    const { gitDir, refsHeadsDir } = dirs;
    const created: Entry = { watchers: [], refs: new Map(), timer: null };
    const fire = () => {
      // Debounce: one commit touches index, HEAD and a ref within milliseconds.
      if (created.timer) clearTimeout(created.timer);
      created.timer = setTimeout(() => {
        created.timer = null;
        emit?.({ repoRoot });
      }, DEBOUNCE_MS);
    };
    // WHY: fs.watch's FSWatcher is an EventEmitter, and it emits 'error' (not
    // just throw) when its watched target vanishes out from under it — repo
    // deleted, `git worktree remove`, or anything else that surgeries .git
    // while we're subscribed. An EventEmitter with zero 'error' listeners
    // throws an uncaught exception that crashes the whole Electron main
    // process. Tear this root's entry down the same way unwatch/drop do, so
    // the app self-heals: the next watchGit() for this root goes back
    // through resolveGitDirs above and correctly reports {ok:false}.
    const onWatcherError = () => {
      // Guard against a stale watcher's error arriving after this entry was
      // already replaced (e.g. a fresh watchGit() re-created it) — only tear
      // down if we're still the current entry for this root.
      if (entries.get(repoRoot) === created) closeEntry(repoRoot, created);
    };
    // Watching the DIRECTORIES catches create/replace of direct children —
    // git rewrites HEAD/index atomically via rename, which a file-watch loses.
    // gitDir (HEAD + index) and refsHeadsDir (branch ref updates) may be two
    // different directories for a linked worktree — see resolveGitDirs above.
    for (const target of [gitDir, refsHeadsDir]) {
      try {
        const watcher = fs.watch(target, fire);
        watcher.on('error', onWatcherError);
        created.watchers.push(watcher);
      } catch {
        // refs/heads may not exist yet in a repo with no commits — HEAD watch
        // still covers the state change when the first commit creates it.
      }
    }
    if (created.watchers.length === 0) return { ok: false };
    entries.set(repoRoot, created);
    // Close the macOS arming window — see DEBOUNCE_MS above. Must come after
    // the entry is registered, so an unwatch during the debounce can cancel it.
    fire();
    entry = created;
  }
  entry.refs.set(subscriberId, (entry.refs.get(subscriberId) ?? 0) + 1);
  return { ok: true };
}

function closeEntry(repoRoot: string, entry: Entry): void {
  if (entry.timer) clearTimeout(entry.timer);
  for (const w of entry.watchers) w.close();
  entries.delete(repoRoot);
}

export function unwatchGit(repoRoot: string, subscriberId: number): void {
  const entry = entries.get(repoRoot);
  if (!entry) return;
  const n = (entry.refs.get(subscriberId) ?? 0) - 1;
  if (n > 0) entry.refs.set(subscriberId, n);
  else entry.refs.delete(subscriberId);
  if (entry.refs.size === 0) closeEntry(repoRoot, entry);
}

export function dropGitSubscriber(subscriberId: number): void {
  for (const [root, entry] of entries) {
    if (entry.refs.delete(subscriberId) && entry.refs.size === 0) closeEntry(root, entry);
  }
}

export function closeAllGitWatchers(): void {
  for (const [root, entry] of entries) closeEntry(root, entry);
}
