// PTY-less exec (spec §2.3): none of the ConPTY 56-byte machinery applies —
// that is a CC-TUI constraint, not an exec constraint.
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { randomUUID } from 'crypto';
// `which` ships no type declarations and @types/which is not a dependency here.
// Kept as a static import (not require) so the module-mocking layer can reach it
// — that is what makes gitBashCandidates() unit-testable off-Windows.
// @ts-ignore
import * as which from 'which';
import { z } from 'zod';
import { defineTool } from './registry';
import { takeHeadLines, takeTailLines } from './truncate';
import type { ToolResultPayload } from './types';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;

/** Marker the shell prints after the user's command so we can read the final
 *  $PWD back out of stdout. Scoped-persistence (ROADMAP 2026-07-17): before
 *  this, every Bash call spawned fresh at the session root and `cd` silently
 *  evaporated, costing ~6 wasted tool calls in one observed session. */
const CWD_SENTINEL = '__YC_CWD__';

/** Strip CSI (colour, cursor) and OSC (window title, hyperlink) sequences.
 *
 *  WHY both an env hint AND a strip: NO_COLOR/FORCE_COLOR cover most tools, but
 *  not all honour them — a vitest run rendered as
 *  `[1m[30m[46m RUN [49m[39m[22m` in the 2026-08-01 review. That is noise in every
 *  test result the model reads, and it looks like corruption to a non-developer
 *  reading the transcript. */
export function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

export interface ShellInfo { cmd: string; args: string[]; label: string }

/** Every place Git Bash might live, best first. Two hardcoded Program Files
 *  paths were the ENTIRE search before 2026-07-19, so a scoop/choco user-scope
 *  install (%LOCALAPPDATA%\Programs\Git), a D:\Git install, or any non-default
 *  location silently fell through to PowerShell — even though `git --version`
 *  passed first-run's prerequisite check and git.exe was right there on PATH. */
function gitBashCandidates(): string[] {
  const out: string[] = [];
  // Claude Code's own documented escape hatch for exactly this problem. Users
  // who already set it for the CLI get correct detection here for free.
  if (process.env.CLAUDE_CODE_GIT_BASH_PATH) out.push(process.env.CLAUDE_CODE_GIT_BASH_PATH);
  // Derive from git.exe on PATH: <root>\cmd\git.exe -> <root>\bin\bash.exe.
  // This is the branch that rescues every non-default install location.
  const git = resolveOnPath('git');
  if (git) {
    // path.win32 explicitly, not `path`: this branch only runs on win32 (where
    // they are the same), and naming it lets the test suite exercise Windows
    // path shapes from a Linux/macOS runner — POSIX dirname() does not treat
    // a backslash as a separator, so `path` here would be untestable off-Windows.
    const root = path.win32.dirname(path.win32.dirname(git));
    out.push(path.win32.join(root, 'bin', 'bash.exe'));
    out.push(path.win32.join(root, 'usr', 'bin', 'bash.exe'));
  }
  out.push('C:/Program Files/Git/bin/bash.exe', 'C:/Program Files (x86)/Git/bin/bash.exe');
  // Last resort: bash on PATH — but NEVER System32\bash.exe. That is the WSL
  // launcher: it would run the command inside a Linux VM against a Windows cwd,
  // so every path the model passed would be wrong. Worse than PowerShell.
  const onPath = resolveOnPath('bash');
  if (onPath && !/[\\/]system32[\\/]/i.test(onPath)) out.push(onPath);
  return out;
}

/** `which`-based resolution, mirroring resolveCommand() in prerequisite-installer.
 *  Returns null (not the bare name) so callers can tell "found" from "guessing". */
function resolveOnPath(cmd: string): string | null {
  try {
    // Static import, not a runtime require(): require() escapes the module
    // mocking layer, which made this branch impossible to unit-test.
    return (which as any).sync(cmd, { nothrow: true }) || null;
  } catch {
    return null;
  }
}

/** Windows shell preference (spec §2.3): Git Bash when present (models write
 *  bash), else PowerShell — and the tool DESCRIPTION states which is live. */
export function detectShell(): ShellInfo {
  if (process.platform !== 'win32') return { cmd: '/bin/bash', args: ['-c'], label: 'bash' };
  const gitBash = gitBashCandidates().find((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
  if (gitBash) return { cmd: gitBash, args: ['-c'], label: 'bash (Git Bash)' };
  // Loud, because this degrades the tool: no cwd persistence, and the model is
  // handed a shell its bash-shaped output does not fit. Silence here meant a
  // PowerShell fallback never appeared in a bug report (dev-tools.ts surfaces
  // it as the `harness shell` probe now).
  console.warn(
    '[harness/bash] Git Bash not found — falling back to PowerShell. ' +
      '`cd` will NOT persist between calls. Install Git for Windows, or set ' +
      'CLAUDE_CODE_GIT_BASH_PATH to your bash.exe.',
  );
  return { cmd: 'powershell.exe', args: ['-NoProfile', '-Command'], label: 'PowerShell' };
}

// LAZY + memoized, not module-load-time. First-run installs git via
// `winget install Git.Git` AFTER the app has started (main.ts -> ipc-handlers ->
// this module all import eagerly), so resolving at import pinned a brand-new
// Windows user to PowerShell for their whole first session even though the
// installer had just delivered bash.exe. Resolving on first USE — the earliest
// of buildAiTools() reading .description or an actual execute() — lands after
// first-run completes. Verified import chain: main.ts:8 -> ipc-handlers.ts:31.
let cachedShell: ShellInfo | null = null;
export function getShell(): ShellInfo {
  if (!cachedShell) cachedShell = detectShell();
  return cachedShell;
}
/** Test-only: drop the memo so a test can re-detect under a different platform. */
export function resetShellCache(): void {
  cachedShell = null;
}

/** Only the bash shells get cwd tracking. The PowerShell fallback would need a
 *  different sentinel AND an $LASTEXITCODE dance to preserve exit codes, and it
 *  only ever runs on Windows boxes without Git Bash — not worth the risk, so it
 *  stays stateless and the tool description says so. */
function tracksCwdFor(s: ShellInfo): boolean {
  return s.label.startsWith('bash');
}

/** Wrap the command so the shell prints its final $PWD without clobbering the
 *  exit code. Newline-separated (not `;`) so trailing `&`, `# comments`, and
 *  heredocs in the user's command don't turn into syntax errors. */
function withCwdProbe(command: string): string {
  // TRAILING newline is load-bearing: a background writer ('cmd &') can flush to
  // the pipe AFTER the sentinel, and without a terminator that text concatenates
  // onto the path — yielding a garbage cwd, a spurious reset notice, and output
  // silently dropped from the result. Verified 2026-07-18.
  // `pwd -W` is the MSYS/Git Bash builtin that prints a WINDOWS-style path
  // (C:/Users/...). Without it $PWD is /c/Users/... which path.resolve() on
  // Windows turns into C:\\c\\Users\\... — never inside ctx.cwd, so EVERY call
  // would emit a bogus reset notice. Invalid on Linux/macOS bash, where the
  // `|| pwd` fallback takes over (stderr suppressed so it can't reach output).
  return `${command}\n__yc_rc=$?\nprintf '\\n${CWD_SENTINEL}%s\\n' "$(pwd -W 2>/dev/null || pwd)"\nexit $__yc_rc`;
}

/** Split the sentinel back off the combined stdout+stderr. Returns the text the
 *  model should see and the reported cwd (null when the command exited early,
 *  timed out, or was killed — all cases where cwd simply doesn't change). */
function extractCwd(out: string): { text: string; cwd: string | null } {
  const at = out.lastIndexOf(`\n${CWD_SENTINEL}`);
  if (at === -1) return { text: out, cwd: null };
  const after = out.slice(at + 1 + CWD_SENTINEL.length);
  const nl = after.indexOf('\n');
  const reported = (nl === -1 ? after : after.slice(0, nl)).trim();
  const rest = nl === -1 ? '' : after.slice(nl + 1);
  return { text: out.slice(0, at) + rest, cwd: reported || null };
}

/** Containment check for the scope guard. realpath both sides so a symlinked
 *  workspace root doesn't read as "outside itself". */
function isInside(root: string, candidate: string): boolean {
  const real = (p: string) => {
    // .native FIRST: plain realpathSync does NOT expand Windows 8.3 short names.
    // ctx.cwd arrives short (C:\Users\RUNNER~1\...) while `pwd -W` may report the
    // SAME directory long (C:\Users\runneradmin\...), so startsWith() judged a
    // plain `cd sub` "outside the workspace" and the scope guard reverted EVERY
    // cd on Windows — persistence looked broken and each call emitted a bogus
    // reset notice. .native canonicalizes both sides via GetFinalPathNameByHandle.
    // Confirmed on windows-latest 2026-07-19 (short/long forms observed side by side).
    try {
      return fs.realpathSync.native(p);
    } catch {
      /* not on disk (yet) — fall back */
    }
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  const r = real(root);
  const c = real(candidate);
  return c === r || c.startsWith(r + path.sep);
}

/** Built per-read so it reflects the LAZILY resolved shell (see getShell). A
 *  module-level string would bake in whatever was detected at import — i.e.
 *  "PowerShell" for a user whose git arrived during first-run. */
function bashDescription(): string {
  const s = getShell();
  return (
    `Run a shell command (${s.label} on this machine). ` +
    (tracksCwdFor(s)
      ? 'The working directory PERSISTS between calls: a `cd` carries to your next Bash call. ' +
        'Changing directory outside the workspace root is reverted (you get a reset notice). ' +
        // Fix (2026-08-10 review): 5 of 5 reviewing models flagged this asymmetry as a
        // trap even though it was already documented — buried in a longer sentence
        // wasn't enough. Its own labeled sentence states it plainly: cwd survives
        // between calls, nothing else about the shell does.
        'ASYMMETRY: only the working directory persists. Environment variables, aliases, ' +
        'and shell functions do NOT carry to your next call (e.g. `export FOO=bar` here is ' +
        'gone by your next call) — every call is a fresh shell that inherits your `cd` and ' +
        'nothing else. ' +
        'Note that the other tools (Read/Edit/Write/Glob/Grep) resolve relative paths from the ' +
        'workspace root, NOT from this shell directory — prefer absolute paths with them. '
      : 'Each call starts fresh in the workspace directory — `cd` does NOT carry to the next call, ' +
        'so use absolute paths or chain with `cd X && ...` in one command. Environment variables ' +
        'never carry over either. ') +
    // Fix (2026-08-10 review, Claim 7): verified against a real transcript — this
    // runs plain `bash -c`, no `set -e`/`pipefail` injected. `false; echo hi` reports
    // exit 0 because the LAST command decides the code, same as typing the chain into
    // a real terminal. Not a bug (Claude Code's own Bash tool works the same way);
    // stated here so it stops getting re-reported as one.
    'No `set -e`: a multi-command chain (`a; b; c`) reports the LAST command\'s exit code, ' +
    'so an earlier failure in the middle can be silently absorbed — use `&&` between commands, ' +
    'or check intermediate results yourself, when that matters. ' +
    // Fix (2026-08-10 review): cap tightened from ~28,000 to ~4,000 chars — reviewers
    // measured a `seq 1 20000` costing ~7k tokens of pure noise, "more expensive than
    // everything else combined." The visible slice shrank; nothing is lost — the full
    // output is always saved to disk when it overflows, path included in the result.
    'Output over ~4,000 chars shows only the first and last ~50 lines; the FULL output is ' +
    'then always saved to a file, with its path in the result — read that file (e.g. with ' +
    'the Read tool) or re-run the ORIGINAL command piped through head/tail/grep rather than ' +
    'guessing from the truncated preview; do not just re-run the same command hoping for more. ' +
    // Fix (2026-08-10 review): 3 of 5 models found the old `exit ?` timeout marker
    // opaque. A timeout now reports exit 124 (matching `timeout(1)` and Codex CLI) —
    // stated here so the model recognizes it without guessing.
    'Long-running commands time out (default 2 minutes, max 10 via `timeout`); a timeout ' +
    'force-kills the process (SIGKILL) and is reported as exit 124.'
  );
}

// Where Bash spills full output that doesn't fit inline (2026-08-10 review —
// see the recommendation in
// docs/active/investigations/2026-08-10-harness-output-truncation-prior-art.md).
// Session-scoped (each session gets its own subfolder) so one conversation's
// spill files are easy to reason about in isolation, but all rooted under one
// parent so the retention sweep below can walk every session's leftovers —
// including ones from sessions that ended long ago — in a single pass.
function spillRoot(): string {
  return path.join(os.tmpdir(), 'youcoded-harness-bash-output');
}
function spillDirFor(sessionId: string): string {
  // Never trust sessionId as a path segment verbatim — strip anything that
  // isn't alnum/dash/underscore so a pathological id can't escape spillRoot().
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, '_') || 'unknown';
  return path.join(spillRoot(), safe);
}

// WHY a module-level once-flag, not a timer (2026-08-10 review — OpenCode's
// precedent is a 7-day TTL swept hourly): a spill-to-file design that never
// cleans up is a slow disk leak, real in every surveyed design that adds this
// affordance without a retention policy (even Claude Code's docs don't state
// one). We have no scheduler primitive here worth adding a dependency for, so
// instead sweep once per process lifetime, on the first spill this process
// ever writes — for a long-running desktop app that lands close enough to
// OpenCode's cadence without a timer that outlives every session.
const SPILL_TTL_MS = 7 * 24 * 60 * 60 * 1000;
let sweepScheduled = false;
function sweepOldSpillFilesOnce(): void {
  if (sweepScheduled) return;
  sweepScheduled = true;
  const root = spillRoot();
  const cutoff = Date.now() - SPILL_TTL_MS;
  fs.promises
    .readdir(root, { withFileTypes: true })
    .then(async (sessionDirs) => {
      for (const d of sessionDirs) {
        if (!d.isDirectory()) continue;
        const sessDir = path.join(root, d.name);
        let files: string[] = [];
        try {
          files = await fs.promises.readdir(sessDir);
        } catch {
          continue;
        }
        for (const f of files) {
          const fp = path.join(sessDir, f);
          try {
            const st = await fs.promises.stat(fp);
            if (st.mtimeMs < cutoff) await fs.promises.unlink(fp);
          } catch {
            // Best-effort: a file that vanished mid-sweep, or that we can't
            // stat/unlink for permission reasons, isn't worth failing the
            // whole sweep over — it'll be retried next process launch.
          }
        }
        // Tidy up an emptied session dir too, so orphaned folders don't pile up.
        try {
          const remaining = await fs.promises.readdir(sessDir);
          if (remaining.length === 0) await fs.promises.rmdir(sessDir);
        } catch {
          /* best-effort */
        }
      }
    })
    .catch(() => {
      /* spillRoot() doesn't exist yet (first spill ever on this machine) — nothing to sweep */
    });
}

export const BashTool = defineTool({
  name: 'Bash',
  // Placeholder: the real text comes from the getter installed below, which
  // resolves the shell on first read (harness-session.ts buildAiTools()).
  description: '',
  // Compact form for small local models (simplified presentation, spec §4.2).
  // MERGE RECONCILIATION: stays a plain static string rather than joining the
  // lazy-getter dance — it names no shell, so there is nothing to resolve.
  shortDescription: 'Run a shell command and return its output.',
  inputSchema: z.object({
    command: z.string(),
    timeout: z.number().int().optional().describe('Timeout in milliseconds'),
    description: z.string().optional().describe('One line: what this command does'),
  }),
  caps: { maxChars: 30_000 },
  // Static fallback for composeNotice's no-bounds branch (Task 19): Bash's own
  // visible budget (HEAD_CHARS_TARGET + TAIL_CHARS_TARGET = 4,000 chars, see
  // execute() below) keeps its own `bounds` the sole authority in the common
  // case, but the reset notice + metadata trailer embed ctx.cwd TWICE and sit
  // OUTSIDE that budget — an extreme workspace root path could in theory still
  // push the pipeline cap (30k) past its limit while `truncated` stays false.
  // This is generic advice for that now-rarer edge case, not a copy of the
  // per-call `bounds.moreHint` built in execute() (which names the real spill
  // path and can't be known statically).
  moreHint: 'pipe through head -n 100, tail -n 100, or wc -l to narrow it',
  permissionSubject: (a) => a.command,
  async execute(args, ctx) {
    const timeout = Math.min(args.timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    // A tracked dir can be deleted out from under us (rm -rf, worktree remove);
    // falling back to the root beats spawning into ENOENT.
    const tracked = ctx.shellCwd;
    const startCwd =
      tracked && tracked !== ctx.cwd && fs.existsSync(tracked) && fs.statSync(tracked).isDirectory() ? tracked : ctx.cwd;
    // Skip the probe when the command's last line would ABSORB ours: a trailing
    // line-continuation, or a dangling `&&`/`||`/`|` (which swallows the
    // `__yc_rc=$?` line, so a FAILED command would exit 0 — verified 2026-07-18).
    // Such commands are malformed anyway; skipping restores the plain behavior.
    const shell = getShell();
    const probe = tracksCwdFor(shell) && !/(\\|&&|\|\||\|)\s*$/.test(args.command);
    return new Promise((resolve) => {
      // spawn() throws SYNCHRONOUSLY when the shell path or startCwd has a
      // non-directory prefix (e.g. a stale/deleted tracked cwd that raced past
      // the existsSync check above). That throw fires before the 'error' handler
      // at the bottom of this executor can attach, so catch it here — otherwise
      // it escapes to defineTool as a bare `Bash failed: spawn <CODE>`.
      let child;
      try {
        child = spawn(shell.cmd, [...shell.args, probe ? withCwdProbe(args.command) : args.command], {
          cwd: startCwd,
          windowsHide: true,
          // Ask tools to emit plain output rather than stripping it after the fact
          // where possible — cleaner, and it keeps byte counts honest.
          env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
        });
      } catch (e: any) {
        resolve({ text: `Failed to start shell: ${e?.message ?? e} (shell=${shell.cmd}; cwd=${startCwd})`, isError: true });
        return;
      }
      // Bounded head + rolling tail + an UNCONDITIONAL byte counter.
      //
      // WHY this replaced a flat 200KB accumulator (2026-08-06): the old buffer
      // retained 200KB only for defineTool to cut it to 30k, and — worse — the
      // truncation notice reported the CAPPED buffer's length as the original
      // size. A 5MB command was announced as "204800 chars total", a number
      // nothing had measured. Counting every chunk whether or not we keep it makes
      // the reported total true.
      //
      // WHY independent head/tail buffers, not one accumulator with overflow
      // (2026-08-10 review, cap tightened ~28,000 -> ~4,000 chars — reviewers
      // measured a `seq 1 20000` costing ~7k tokens of pure noise, "more
      // expensive than everything else combined"): the OLD single-accumulator
      // design ("fill head, then overflow into a rolling tail") had a real gap —
      // if total output stayed under the head cap but exceeded the LINE budget
      // (many short lines), the tail buffer would never receive anything, losing
      // "how it ended" entirely. `headBuf` (grows once, stops at its cap, never
      // shrinks) and `tailBuf` (a rolling window of the last N raw chars,
      // ALWAYS fed regardless of whether headBuf is still filling) are now two
      // independent, unconditionally-maintained buffers — each is simply "the
      // true first ~4,000 chars" and "the true last ~4,000 chars" of whatever
      // has streamed so far, which also eliminates the old "dead zone" bug
      // class outright rather than just shrinking it.
      const HEAD_RETAIN_CHARS = 4_000; // margin over the 2,000-char visible target below, so a line-aware trim always has real lines to choose from
      const TAIL_RETAIN_CHARS = 4_000;
      const HEAD_CHARS_TARGET = 2_000;
      const HEAD_LINES_TARGET = 50;
      const TAIL_CHARS_TARGET = 2_000;
      const TAIL_LINES_TARGET = 50;
      let headBuf = '';
      let tailBuf = '';
      let totalChars = 0;
      let totalNewlines = 0;
      // Separate uncapped 4KB tail purely for the cwd sentinel: a chatty command
      // ("cd sub && <huge output>") would otherwise push the sentinel out of the
      // retained text and silently lose the cd.
      let probeTail = '';
      // Full-output spill (2026-08-10 review: 4 of 5 surveyed harnesses with a
      // real cap pair a small visible slice with a mandatory disk spill — see
      // docs/active/investigations/2026-08-10-harness-output-truncation-prior-art.md).
      // Started the MOMENT headBuf can no longer capture everything (inside
      // cap() below), not lazily at finish() — by finish() any un-retained
      // middle content is already gone from memory, so waiting would spill an
      // incomplete file. spillDirFor/sweepOldSpillFilesOnce are declared at
      // module scope, above BashTool.
      let spillStream: fs.WriteStream | null = null;
      let spillPath: string | null = null;
      let spillError: string | null = null;
      const startSpill = () => {
        try {
          const dir = spillDirFor(ctx.sessionId);
          fs.mkdirSync(dir, { recursive: true });
          sweepOldSpillFilesOnce();
          spillPath = path.join(dir, `bash-${Date.now()}-${randomUUID()}.txt`);
          spillStream = fs.createWriteStream(spillPath);
          spillStream.on('error', (e) => {
            spillError = e.message;
          });
          // Backfill with everything captured so far — headBuf is complete up to
          // this exact instant (nothing has been dropped yet), so the file
          // starts with zero gap. ANSI-stripped so the spilled file reads the
          // same clean way the visible slice does.
          spillStream.write(stripAnsi(headBuf));
        } catch (e: any) {
          spillError = e?.message ?? String(e);
          spillStream = null;
          spillPath = null;
        }
      };
      const cap = (s: string) => {
        totalChars += s.length;
        for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) === 10) totalNewlines++;
        if (headBuf.length < HEAD_RETAIN_CHARS) {
          const room = HEAD_RETAIN_CHARS - headBuf.length;
          if (s.length <= room) {
            headBuf += s;
          } else {
            headBuf += s.slice(0, room);
            // headBuf just became full and can never capture anything past this
            // point — the earliest moment we KNOW the middle will be lost from
            // memory, so start the spill now rather than at finish(), by which
            // point the un-retained middle is already gone.
            if (!spillStream && !spillError) startSpill();
            spillStream?.write(stripAnsi(s.slice(room)));
          }
        } else {
          if (!spillStream && !spillError) startSpill();
          spillStream?.write(stripAnsi(s));
        }
        tailBuf = (tailBuf + s).slice(-TAIL_RETAIN_CHARS);
        if (probe) probeTail = (probeTail + s).slice(-4096);
      };
      child.stdout.on('data', (d) => cap(String(d)));
      child.stderr.on('data', (d) => cap(String(d)));
      let done = false;
      // `timedOut` distinguishes a SIGKILL-on-timeout result from a normal
      // non-zero exit (2026-08-10 review: 3 of 5 models found the old `exit ?`
      // opaque; Opus wanted to know whether the process died cleanly or was
      // force-killed — "matters when deciding whether a partial write may have
      // been left behind"). Codex CLI's approach, adopted here: a sentinel exit
      // code (124, matching `timeout(1)`) + a typed flag + explicit prose, all
      // three at once rather than picking one.
      const finish = (prefix: string, isError: boolean, code?: number | null, timedOut?: boolean) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        ctx.signal.removeEventListener('abort', onAbort);

        const totalLines = totalNewlines + 1;
        // The ONLY authoritative truncation decision: if the true total exceeds
        // what head+tail can EVER cover (their combined budgets), something in
        // the middle is unavoidably elided — no heuristic, just arithmetic.
        const truncated = totalChars > HEAD_CHARS_TARGET + TAIL_CHARS_TARGET || totalLines > HEAD_LINES_TARGET + TAIL_LINES_TARGET;

        let notice = '';
        // Bytes consumed by the probe's OWN generated sentinel line — harness
        // plumbing, not command output. Subtracted from the reported total so a
        // command that printed exactly N bytes is announced as N, not
        // N-plus-however-long-the-cwd-path-happens-to-be.
        let sentinelOverhead = 0;
        let reportedCwd: string | null = null;
        let resetTo: string | null = null;

        if (probe) {
          // The sentinel is always the LAST thing printed (withCwdProbe), so it
          // always lives in whichever buffer holds the true tail: tailBuf when
          // truncated (headBuf can't see it — it stopped growing long ago), or
          // headBuf when not (headBuf holds 100% of the output in that case,
          // sentinel included — see the cap() invariant: totalChars <=
          // HEAD_RETAIN_CHARS implies headBuf never dropped a single char).
          const sentinelSource = truncated ? tailBuf : headBuf;
          const parsed = extractCwd(sentinelSource);
          sentinelOverhead = sentinelSource.length - parsed.text.length;
          if (truncated) tailBuf = parsed.text;
          else headBuf = parsed.text;
          const reported = parsed.cwd ?? extractCwd(probeTail).cwd;
          if (reported && path.resolve(reported) !== path.resolve(startCwd)) {
            if (isInside(ctx.cwd, reported)) {
              reportedCwd = path.resolve(reported);
              ctx.setShellCwd?.(reportedCwd);
            } else {
              // Scope guard: don't let the session wander out of the workspace,
              // and TELL the model — a silent revert is the exact failure mode
              // the Claude Code issues (#35058 et al.) complain about.
              ctx.setShellCwd?.(ctx.cwd);
              resetTo = ctx.cwd;
              notice = `\nShell cwd was reset to ${ctx.cwd} (${reported} is outside the workspace).`;
            }
          }
        }

        const trueTotal = totalChars - sentinelOverhead;
        let body: string;
        // `shown` measured pre-ANSI-strip (same currency as `totalChars`, which
        // accumulated raw chunks including colour codes) — mixing currencies here
        // was a real bug: a coloured run printed "showing 21491 of 117000 bytes"
        // where 117000 counted escape sequences 21491 did not.
        let preAnsiShown: number;
        let outputPath: string | undefined;
        let moreHintText: string | undefined;

        if (truncated) {
          const headResult = takeHeadLines(headBuf, HEAD_CHARS_TARGET, HEAD_LINES_TARGET);
          const tailResult = takeTailLines(tailBuf, TAIL_CHARS_TARGET, TAIL_LINES_TARGET);
          preAnsiShown = headResult.chars + tailResult.chars;
          const elidedLines = Math.max(0, totalLines - headResult.lines - tailResult.lines);
          body = `${stripAnsi(headResult.text)}\n[...]\n${stripAnsi(tailResult.text)}`;

          if (spillStream && spillPath) {
            outputPath = spillPath;
          } else if (!spillError) {
            // truncated=true but the streaming trigger in cap() never fired —
            // only possible when totalChars <= HEAD_RETAIN_CHARS (the LINE
            // budget alone tripped `truncated`), which by the same invariant
            // means headBuf/tailBuf both hold the complete, gap-free output.
            // Write it out now instead of leaving the model with no file.
            try {
              const dir = spillDirFor(ctx.sessionId);
              fs.mkdirSync(dir, { recursive: true });
              sweepOldSpillFilesOnce();
              const p = path.join(dir, `bash-${Date.now()}-${randomUUID()}.txt`);
              fs.writeFileSync(p, stripAnsi(tailBuf));
              outputPath = p;
            } catch (e: any) {
              spillError = e?.message ?? String(e);
            }
          }

          // Fix: never claim a spill succeeded when it did not — a fabricated
          // path would be a misleading result (see the project's error-message
          // standards). Honest either way: name the real path, or say plainly
          // that the save failed and why.
          const linesPart = `${elidedLines} line${elidedLines === 1 ? '' : 's'} elided`;
          moreHintText = outputPath
            ? `${linesPart} — full output saved to ${outputPath}. Read that file (e.g. with the Read tool), or pipe the ORIGINAL command through head/tail/grep to narrow it.`
            : `${linesPart} — full output could NOT be saved to disk (${spillError ?? 'unknown error'}); pipe the ORIGINAL command through head/tail/grep to narrow it instead.`;
        } else {
          preAnsiShown = headBuf.length;
          body = stripAnsi(headBuf);
          // Nothing to keep — this call's spill (if the streaming trigger ever
          // somehow started one, which the truncated=false arithmetic above
          // guarantees it did not) would be a wasted file; there is none here.
        }

        // ONE metadata line, always. Four of five reviewing models independently
        // asked for this (2026-08-01): file tools resolve relative paths from the
        // workspace root while Bash resolves from its own persistent cwd, and with
        // no cwd echoed back the only safe habit was prefixing every single call
        // with `cd <root> &&`. This line costs ~15 tokens and removes that ritual.
        // It ABSORBS the old `(exit code N)` prefix rather than adding to it.
        const effectiveCwd = resetTo ?? reportedCwd ?? startCwd;
        const meta = [`cwd: ${effectiveCwd}`, `exit ${code ?? '?'}`];
        // Fix: label matches what's actually counted — UTF-16 code units (JS
        // string .length), never real UTF-8 byte counts. Calling that "bytes"
        // was wrong for any multi-byte output: 60,000 CJK characters (180,000
        // real UTF-8 bytes) were reported as "60005 bytes".
        if (truncated) meta.push(`${trueTotal} chars output, showing ${preAnsiShown}`);
        // Fix: when a command exits with genuinely no output (e.g. `exit 3`),
        // `${prefix}${body}` was '' — trimming that and prepending the metadata
        // line produced a result that STARTED with a blank line and said nothing
        // happened, silently dropping the original "(no output, exit N)" fallback
        // text when this block was rewritten around the metadata line. `(no
        // output)` restores that signal without duplicating `exit N`, which the
        // metadata line below already states.
        const combined = `${prefix}${body}`.trim() || '(no output)';
        const text = (combined + notice).trim() + `\n[${meta.join(' · ')}]`;
        const payload: ToolResultPayload & { truncated: boolean; outputPath?: string; timedOut: boolean } = {
          text,
          isError,
          truncated,
          outputPath,
          timedOut: !!timedOut,
          bounds: truncated
            ? {
                shown: preAnsiShown,
                total: trueTotal,
                unit: 'chars' as const,
                moreHint: moreHintText!,
              }
            : undefined,
        };
        // Flush the spill file to disk before resolving — otherwise the model
        // could Read the path from the notice before the write stream's buffer
        // has actually landed on disk.
        if (spillStream && !(spillStream as fs.WriteStream).destroyed) {
          (spillStream as fs.WriteStream).end(() => resolve(payload));
        } else {
          resolve(payload);
        }
      };
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(
          `Command timed out after ${timeout}ms. The process was force-killed (SIGKILL) — if it was mid-write to a file, that write may be incomplete.\n`,
          true,
          124,
          true,
        );
      }, timeout);
      // Interrupt kills the child (spec §2.1 interrupt-mid-tool ruling) and
      // resolves NOW — we can't wait for 'close', because on Windows a surviving
      // grandchild (e.g. bash → node) keeps the stdout pipe open, so 'close'
      // would never fire and the turn would hang.
      const onAbort = () => {
        child.kill('SIGKILL');
        finish('Canceled: the user interrupted this operation.\n', true);
      };
      ctx.signal.addEventListener('abort', onAbort, { once: true });
      // If the signal already fired before we attached (once:true won't replay), kill now.
      if (ctx.signal.aborted) onAbort();
      // Async spawn failure (the path Windows takes for a bad cwd): name the
      // shell + cwd actually used, not just Node's bare `spawn <cmd> <CODE>` —
      // same diagnosability contract as the sync catch above.
      child.on('error', (err) => finish(`Failed to start shell: ${err.message} (shell=${shell.cmd}; cwd=${startCwd})\n`, true));
      // WHY no exit-code prefix here anymore: the metadata line above now states
      // `exit N` for every result, so a leading "(exit code N)" duplicated the
      // same fact in two places. The timeout/abort handlers keep their prefixes —
      // those are messages, not exit codes.
      child.on('close', (code) => finish('', code !== 0, code));
    });
  },
});

// Installed AFTER defineTool because that helper spreads its input ({...def}),
// and a spread EVALUATES getters — declaring this inline would freeze the text
// at import, defeating the lazy resolve. buildAiTools() reads .description once
// per session (harness-session.ts), which is the moment we want detection.
Object.defineProperty(BashTool, 'description', {
  get: bashDescription,
  enumerable: true,
  configurable: true,
});
