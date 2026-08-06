import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as childProcess from 'child_process';

// Spy on child_process.spawn so the Grep cwd regression test can assert the
// exact options the tool passes. `importActual` keeps the REAL implementation —
// the search genuinely runs; we only observe the call. (Mocking process.cwd()
// does NOT work as a pin: Node's spawn reads the inherited cwd via the native
// binding, not the JS process.cwd() we could stub — verified 2026-07-17.)
const spawnSpy = vi.fn();
vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return {
    ...actual,
    spawn: (...args: any[]) => {
      spawnSpy(...args);
      return (actual.spawn as any)(...args);
    },
  };
});
import { ReadTool, readSizeError, MAX_READ_BYTES } from '../src/main/harness/tools/read';
import { WriteTool } from '../src/main/harness/tools/write';
import { EditTool } from '../src/main/harness/tools/edit';
import { BashTool } from '../src/main/harness/tools/bash';
import { GlobTool } from '../src/main/harness/tools/glob';
import { GrepTool, resolveRgPath } from '../src/main/harness/tools/grep';
import { TodoWriteTool } from '../src/main/harness/tools/todo-write';
import type { ToolContext } from '../src/main/harness/tools/types';

// Each test gets a fresh tmp sandbox + fresh ToolContext (readRegistry/todos maps),
// so read-before-edit state never leaks between cases.
let dir: string;
let ctx: ToolContext;

function makeCtx(cwd: string, signal?: AbortSignal): ToolContext {
  return {
    sessionId: 'test',
    cwd,
    signal: signal ?? new AbortController().signal,
    readRegistry: new Map(),
    todos: [],
  };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-tools-'));
  ctx = makeCtx(dir);
});
afterEach(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe('Read', () => {
  it('returns numbered lines', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'alpha\nbravo\ncharlie\n');
    const r = await ReadTool.execute({ file_path: 'a.txt' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('     1\talpha');
    expect(r.text).toContain('     2\tbravo');
    expect(r.text).toContain('     3\tcharlie');
  });

  it('paging trailer appears when more lines remain (offset/limit)', async () => {
    const lines = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n');
    fs.writeFileSync(path.join(dir, 'big.txt'), lines);
    const r = await ReadTool.execute({ file_path: 'big.txt', offset: 1, limit: 5 }, ctx);
    expect(r.text).toContain('     1\tline1');
    expect(r.text).toContain('     5\tline5');
    expect(r.text).not.toContain('line6');
    expect(r.text).toMatch(/use offset=6 to continue/);
  });

  it('refuses binary files', async () => {
    fs.writeFileSync(path.join(dir, 'bin'), Buffer.from([0x41, 0x00, 0x42]));
    const r = await ReadTool.execute({ file_path: 'bin' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('binary file');
  });

  it('registers the file in readRegistry', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
    await ReadTool.execute({ file_path: 'a.txt' }, ctx);
    // canonicalize lower-cases the whole path on win32
    const key = process.platform === 'win32'
      ? path.resolve(dir, 'a.txt').replace(/\\/g, '/').toLowerCase()
      : path.resolve(dir, 'a.txt');
    expect(ctx.readRegistry.has(key)).toBe(true);
  });

  it('size guard refuses files over MAX_READ_BYTES with an actionable message', () => {
    // Unit-test the exact refusal branch without writing a 50 MB fixture.
    expect(readSizeError(1000, 'small.log')).toBeNull();
    expect(readSizeError(MAX_READ_BYTES, 'edge.log')).toBeNull();
    const msg = readSizeError(MAX_READ_BYTES + 1, 'huge.log');
    expect(msg).toBeTruthy();
    expect(msg).toContain('huge.log');
    expect(msg).toContain('limit 50 MB');
    expect(msg).toMatch(/Grep|head\/tail/);
  });

  it('trailer line count is honest for a file ending in \\n (no phantom line)', async () => {
    fs.writeFileSync(path.join(dir, 't.txt'), 'a\nb\nc\n'); // 3 real lines, trailing \n
    const r = await ReadTool.execute({ file_path: 't.txt', offset: 1, limit: 2 }, ctx);
    // 3 total, not 4 — the phantom empty split element is dropped.
    expect(r.text).toContain('of 3 lines —');
    expect(r.text).not.toContain('of 4');
  });

  it('offset past EOF returns a friendly message, not empty text', async () => {
    fs.writeFileSync(path.join(dir, 't.txt'), 'a\nb\nc\n');
    const r = await ReadTool.execute({ file_path: 't.txt', offset: 99 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('offset 99 is past the end of the file (3 lines)');
  });

  it('Read declares bounds with an offset hint when a page is partial', async () => {
    const f = path.join(dir, 'big.txt');
    fs.writeFileSync(f, Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n'));
    const r = await ReadTool.execute({ file_path: f, offset: 1, limit: 20 }, ctx);
    expect(r.text).toContain('[showing 20 of 100 lines — use offset=21 to continue]');
  });

  it('Read declares no bounds when the whole file fits', async () => {
    const f = path.join(dir, 'small.txt');
    fs.writeFileSync(f, 'a\nb\nc');
    const r = await ReadTool.execute({ file_path: f }, ctx);
    expect(r.text).not.toContain('[showing');
  });
});

describe('Edit', () => {
  it('rejects an edit without a prior Read', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
    const r = await EditTool.execute({ file_path: 'a.txt', old_string: 'hello', new_string: 'bye' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/read .* first/i);
  });

  it('rejects an edit when the file changed since Read (mtime mismatch)', async () => {
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, 'hello\n');
    await ReadTool.execute({ file_path: 'a.txt' }, ctx);
    // Force a distinctly different mtime (+2s) — coarse fs granularity safe.
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(p, future, future);
    const r = await EditTool.execute({ file_path: 'a.txt', old_string: 'hello', new_string: 'bye' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/changed since you read it/i);
  });

  it('non-unique old_string message includes the count', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\nx\nx\n');
    await ReadTool.execute({ file_path: 'a.txt' }, ctx);
    const r = await EditTool.execute({ file_path: 'a.txt', old_string: 'x', new_string: 'y' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('matches 3 times');
  });

  it('replace_all replaces every occurrence', async () => {
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, 'x\nx\nx\n');
    await ReadTool.execute({ file_path: 'a.txt' }, ctx);
    const r = await EditTool.execute({ file_path: 'a.txt', old_string: 'x', new_string: 'y', replace_all: true }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(p, 'utf8')).toBe('y\ny\ny\n');
  });

  it('preserves CRLF line endings after an edit', async () => {
    const p = path.join(dir, 'crlf.txt');
    fs.writeFileSync(p, 'a\r\nb\r\n');
    await ReadTool.execute({ file_path: 'crlf.txt' }, ctx);
    const r = await EditTool.execute({ file_path: 'crlf.txt', old_string: 'b', new_string: 'c' }, ctx);
    expect(r.isError).toBeFalsy();
    const after = fs.readFileSync(p, 'utf8');
    expect(after).toBe('a\r\nc\r\n');
    expect(after).toContain('\r\n');
  });

  it('multi-line edit on a CRLF file matches in LF space and preserves CRLF', async () => {
    const p = path.join(dir, 'multi.txt');
    fs.writeFileSync(p, 'a\r\nb\r\nc\r\n');
    await ReadTool.execute({ file_path: 'multi.txt' }, ctx);
    // old_string/new_string use \n (what the model sees in Read output) — must match
    // despite the file's invisible \r, and the write must stay CRLF end-to-end.
    const r = await EditTool.execute({ file_path: 'multi.txt', old_string: 'a\nb', new_string: 'a\nX\nb' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(p, 'utf8')).toBe('a\r\nX\r\nb\r\nc\r\n');
    // Hunks reflect the one-line insertion, not a whole-file line-ending churn.
    expect(r.structuredPatch).toBeDefined();
    expect(r.structuredPatch!.length).toBeGreaterThan(0);
    const changed = r.structuredPatch!.flatMap((h) => h.lines).filter((l) => l.startsWith('+') || l.startsWith('-'));
    expect(changed.every((l) => !l.includes('\r'))).toBe(true);
    expect(changed.some((l) => l === '+X')).toBe(true);
  });

  it('keeps a CRLF file uniformly CRLF even when new_string contains \\r\\n', async () => {
    const p = path.join(dir, 'crlf2.txt');
    fs.writeFileSync(p, 'a\r\nb\r\nc\r\n');
    await ReadTool.execute({ file_path: 'crlf2.txt' }, ctx);
    // new_string carries its own \r\n — the file must not go mixed-ending.
    const r = await EditTool.execute({ file_path: 'crlf2.txt', old_string: 'b', new_string: 'X\r\nY' }, ctx);
    expect(r.isError).toBeFalsy();
    const bytes = fs.readFileSync(p, 'utf8');
    expect(bytes).toBe('a\r\nX\r\nY\r\nc\r\n');
    // No bare LF anywhere (every \n is preceded by \r) → uniform CRLF.
    expect(/[^\r]\n/.test(bytes)).toBe(false);
    expect(bytes.startsWith('\n')).toBe(false);
  });

  it('returns non-empty structuredPatch hunks', async () => {
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, 'hello\nworld\n');
    await ReadTool.execute({ file_path: 'a.txt' }, ctx);
    const r = await EditTool.execute({ file_path: 'a.txt', old_string: 'world', new_string: 'there' }, ctx);
    expect(r.structuredPatch).toBeDefined();
    expect(r.structuredPatch!.length).toBeGreaterThan(0);
    expect(r.structuredPatch![0]).toHaveProperty('oldStart');
    expect(r.structuredPatch![0]).toHaveProperty('lines');
  });

  it('inserts a new_string containing $& literally (String.replace footgun)', async () => {
    const p = path.join(dir, 'a.txt');
    fs.writeFileSync(p, 'TOKEN\n');
    await ReadTool.execute({ file_path: 'a.txt' }, ctx);
    const r = await EditTool.execute({ file_path: 'a.txt', old_string: 'TOKEN', new_string: 'a$&b$1c$$d' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(p, 'utf8')).toBe('a$&b$1c$$d\n');
  });
});

describe('Write', () => {
  it('rejects overwriting an existing file without a prior Read', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'old\n');
    const r = await WriteTool.execute({ file_path: 'a.txt', content: 'new\n' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Read it first/i);
  });

  it('creates parent directories', async () => {
    const r = await WriteTool.execute({ file_path: 'deep/nested/x.txt', content: 'hi\n' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(dir, 'deep/nested/x.txt'), 'utf8')).toBe('hi\n');
  });

  it('attaches a structuredPatch for a new file', async () => {
    const r = await WriteTool.execute({ file_path: 'x.txt', content: 'line1\nline2\n' }, ctx);
    expect(r.structuredPatch).toBeDefined();
    expect(r.structuredPatch!.length).toBeGreaterThan(0);
  });
});

describe('Bash', () => {
  it('echo round-trips through the shell', async () => {
    const r = await BashTool.execute({ command: 'echo hello-world' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('hello-world');
  });

  it('a non-zero exit is an error and reports the code', async () => {
    const r = await BashTool.execute({ command: 'exit 3' }, ctx);
    expect(r.isError).toBe(true);
    // The exit code now lives in the metadata line, not a leading prefix — it
    // used to duplicate the same fact in two places once Task 4 added the line.
    expect(r.text).toContain('· exit 3]');
    expect(r.text).not.toContain('(exit code 3)');
  });

  it('Bash reports the TRUE output size, not the size of its retained buffer', async () => {
    // 400k of output — past the old 200k accumulator ceiling. The old code
    // reported the CAPPED buffer's length as "chars total", i.e. a number it
    // invented. Regression pin for the 2026-08-01 review finding.
    const r = await BashTool.execute(
      { command: `node -e "process.stdout.write('z'.repeat(400000))"` },
      ctx,
    );
    expect(r.bounds?.unit).toBe('bytes');
    expect(r.bounds?.total).toBe(400_000);
    expect(r.bounds?.moreHint).toContain('head');
    expect(r.text).not.toContain('204800');
  }, 30_000);

  it('Bash declares no bounds for small output', async () => {
    const r = await BashTool.execute({ command: 'echo hi' }, ctx);
    expect(r.bounds).toBeUndefined();
  });

  // Regression pin for the 30k-71.5k "dead zone" (2026-08-06 review): the old
  // `if (head.length < HEAD_CHARS) head += s` guard checked BEFORE appending, so
  // a chunk that crossed the boundary was retained whole — a single pipe read
  // could push retention past 71k before Bash's own `dropped` flag ever tripped,
  // while defineTool's pipeline cap (30_000) fired regardless. Everything in
  // between landed in composeNotice's no-bounds fallback: a bare "[output
  // truncated: showing N of M chars]" with NO moreHint. 50,000 chars sits
  // squarely inside that old dead zone (above the 30k pipeline cap, below the
  // ~71.5k the old accumulator actually retained) — this pins that Bash now
  // declares its own bounds there instead of falling through to the pipeline's
  // uninformative notice.
  it('Bash declares bounds (not the bare pipeline notice) for output in the old 30k-71.5k dead zone', async () => {
    const r = await BashTool.execute(
      { command: `node -e "process.stdout.write('z'.repeat(50000))"` },
      ctx,
    );
    expect(r.bounds).toBeDefined();
    expect(r.bounds?.moreHint).toBeTruthy();
    expect(r.bounds?.moreHint?.length).toBeGreaterThan(0);
    // The bare no-bounds fallback string from composeNotice (truncate.ts) —
    // must NOT appear once Bash declares its own bounds for this size.
    expect(r.text).not.toContain('[output truncated: showing');
  }, 30_000);

  it('Bash always states the cwd and exit code', async () => {
    const r = await BashTool.execute({ command: 'echo hi' }, ctx);
    expect(r.text).toContain(`[cwd: ${dir} · exit 0]`);
  });

  it('Bash states a non-zero exit in the metadata line, not as a prefix', async () => {
    const r = await BashTool.execute({ command: 'exit 42' }, ctx);
    expect(r.text).toContain('· exit 42]');
    expect(r.text).not.toContain('(exit code 42)');
  });

  // Regression pin: the original "(no output, exit N)" fallback text was lost
  // when the unconditional metadata line replaced the old block — a command
  // that produced NO stdout/stderr resolved to a bare leading blank line
  // followed only by the metadata line, giving no positive signal that the
  // command ran and simply produced nothing.
  it('a command that exits non-zero with no output gets a readable "(no output)" body, not a leading blank line', async () => {
    const r = await BashTool.execute({ command: 'exit 3' }, ctx);
    expect(r.text).toContain('(no output)');
    expect(r.text).not.toMatch(/^\n/);
    expect(r.text.startsWith('(no output)')).toBe(true);
  });

  it('Bash reports the tracked cwd after a cd, so the model never has to guess', async () => {
    fs.mkdirSync(path.join(dir, 'sub'));
    let tracked: string | undefined;
    const c: ToolContext = { ...makeCtx(dir), shellCwd: undefined, setShellCwd: (n) => { tracked = n; } };
    const r = await BashTool.execute({ command: 'cd sub' }, c);
    expect(tracked).toBe(path.join(dir, 'sub'));
    expect(r.text).toContain(`[cwd: ${path.join(dir, 'sub')} · exit 0]`);
  });

  it('Bash still reports the cwd when the command timed out', async () => {
    const r = await BashTool.execute({ command: 'sleep 5', timeout: 500 }, ctx);
    expect(r.text).toContain('Command timed out after 500ms.');
    expect(r.text).toContain('[cwd:');
  }, 15_000);

  it('Bash strips ANSI colour codes from output', async () => {
    const r = await BashTool.execute(
      { command: `node -e "process.stdout.write('\\u001b[32m✓\\u001b[39m passed')"` },
      ctx,
    );
    expect(r.text).toContain('✓ passed');
    expect(r.text).not.toContain('\x1b[');
  });

  it('Bash sets NO_COLOR so tools emit plain output in the first place', async () => {
    const r = await BashTool.execute({ command: 'echo "NO_COLOR=$NO_COLOR FORCE_COLOR=$FORCE_COLOR"' }, ctx);
    expect(r.text).toContain('NO_COLOR=1');
    expect(r.text).toContain('FORCE_COLOR=0');
  });

  it('ANSI stripping does not disturb the cwd sentinel', async () => {
    fs.mkdirSync(path.join(dir, 'coloured'));
    let tracked: string | undefined;
    const c: ToolContext = { ...makeCtx(dir), setShellCwd: (n) => { tracked = n; } };
    await BashTool.execute(
      { command: `node -e "process.stdout.write('\\u001b[31mred\\u001b[0m')" && cd coloured` },
      c,
    );
    expect(tracked).toBe(path.join(dir, 'coloured'));
  });

  it('times out and reports it', async () => {
    const r = await BashTool.execute({ command: 'node -e "setTimeout(()=>{},10000)"', timeout: 50 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/timed out/i);
  });

  it('a spawn-level failure resolves a structured error that names the cwd', async () => {
    // A bad startCwd makes spawn fail. The PATH differs by platform: on POSIX a
    // file-cwd throws SYNCHRONOUSLY (before the 'error' handler can attach — the
    // trap the try/catch guards); on Windows the shell spawn fails ASYNCHRONOUSLY
    // via 'error' (ENOENT). Either way the result must be a structured error that
    // NAMES the offending cwd — never a context-free `Bash failed: spawn <CODE>`.
    // (ctx.cwd = a FILE reaches spawn because bash.ts only guards shellCwd.)
    const fileCwd = path.join(dir, 'not-a-dir.txt');
    fs.writeFileSync(fileCwd, 'x');
    const r = await BashTool.execute({ command: 'echo hi' }, makeCtx(fileCwd));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Failed to start shell/);
    expect(r.text).toContain(fileCwd); // named on BOTH the sync and async paths
  });

  // Scoped persistence (ROADMAP 2026-07-17). Before this, every call spawned
  // fresh at the session root and `cd` silently evaporated — the failure mode
  // that burned ~6 tool calls in the 2026-07-17 session.
  describe('scoped cwd persistence', () => {
    function trackingCtx(root: string): ToolContext {
      const c = makeCtx(root);
      c.setShellCwd = (next) => {
        c.shellCwd = next;
      };
      return c;
    }

    // Must mirror withCwdProbe()'s `pwd -W 2>/dev/null || pwd` — a bare `pwd`
    // makes these assertions fail on WINDOWS ONLY. Git Bash mounts %TEMP% at
    // /tmp, so inside a mkdtemp sandbox bare `pwd` prints /tmp/native-tools-xxx;
    // fs.realpathSync() then resolves that leading slash against the runner's
    // CURRENT DRIVE (D: on GitHub's windows-latest) -> ENOENT 'D:\tmp'. `pwd -W`
    // is the MSYS builtin that emits a real Win32 path instead. Broke the
    // 2026-07-19 beta build; the tool itself was never wrong. (POSIX: -W is
    // invalid, the `|| pwd` fallback takes over, stderr suppressed.)
    const PWD = 'pwd -W 2>/dev/null || pwd';

    // Same 8.3 trap the tool itself hit: plain fs.realpathSync leaves a SHORT
    // root (C:\Users\RUNNER~1\...) short while `pwd -W` reports the LONG form
    // (C:\Users\runneradmin\...) for the very same directory, so comparing the
    // two never matches on Windows. .native canonicalizes both. Compare paths
    // through this, never through raw realpathSync.
    const canon = (p: string) => {
      try {
        return fs.realpathSync.native(p);
      } catch {
        return fs.realpathSync(p);
      }
    };

    // Task 4 appends an unconditional `\n[cwd: ... · exit N]` metadata line after
    // the command's own output, so a raw `.trim()` on `r.text` is no longer just
    // the command's stdout — it also swallows the metadata line, which broke
    // every one of these tests' path comparisons (ENOENT on a two-line string).
    // Split it back off so these tests keep checking the actual command output.
    const cmdOutput = (text: string) => text.split('\n[cwd:')[0].trim();

    it('a cd carries to the next call and the sentinel never reaches the model', async () => {
      fs.mkdirSync(path.join(dir, 'sub'));
      const c = trackingCtx(dir);
      const first = await BashTool.execute({ command: 'cd sub && echo moved' }, c);
      expect(first.text).toContain('moved');
      expect(first.text).not.toContain('__YC_CWD__');
      const second = await BashTool.execute({ command: PWD }, c);
      // A cd INTO a workspace subdir must never trip the scope guard. Windows-only
      // regression (2026-07-19): isInside() compared an 8.3 SHORT root against a
      // LONG candidate, so this fired on every cd and reverted it. The two
      // assertions below can't catch that alone — they expect the ROOT, which is
      // also what a fully broken persistence returns, so they passed vacuously.
      expect(first.text).not.toMatch(/Shell cwd was reset/);
      expect(canon(cmdOutput(second.text))).toBe(canon(path.join(dir, 'sub')));
    });

    it('a cd outside the workspace is reverted WITH a notice (never silent)', async () => {
      const c = trackingCtx(dir);
      const r = await BashTool.execute({ command: `cd ${JSON.stringify(os.tmpdir())}` }, c);
      expect(r.text).toMatch(/Shell cwd was reset to/);
      const after = await BashTool.execute({ command: PWD }, c);
      expect(canon(cmdOutput(after.text))).toBe(canon(dir));
    });

    it('the probe preserves the command exit code', async () => {
      const r = await BashTool.execute({ command: 'exit 3' }, trackingCtx(dir));
      expect(r.isError).toBe(true);
      expect(r.text).toContain('· exit 3]');
    });

    it('falls back to the root when the tracked dir was deleted', async () => {
      const gone = path.join(dir, 'gone');
      fs.mkdirSync(gone);
      const c = trackingCtx(dir);
      await BashTool.execute({ command: 'cd gone' }, c);
      fs.rmSync(gone, { recursive: true });
      const r = await BashTool.execute({ command: PWD }, c);
      expect(r.isError).toBeFalsy();
      expect(canon(cmdOutput(r.text))).toBe(canon(dir));
    });

    // Regression (2026-07-18): without a trailing newline after the sentinel, a
    // background writer's output concatenated onto the path — garbage cwd, a
    // spurious reset notice, and the late text silently dropped from the result.
    it('output arriving AFTER the sentinel is preserved and does not corrupt the cwd', async () => {
      fs.mkdirSync(path.join(dir, 'sub'));
      const c = trackingCtx(dir);
      const r = await BashTool.execute(
        { command: 'cd sub && { sleep 0.2; echo LATE-OUTPUT >&2; } &' },
        c,
      );
      expect(r.text).toContain('LATE-OUTPUT'); // not swallowed
      expect(r.text).not.toMatch(/Shell cwd was reset/); // no spurious notice
      expect(String(c.shellCwd ?? dir)).not.toContain('LATE-OUTPUT'); // path never corrupted
    });

    // Regression (2026-07-18): the 200KB accumulator cap dropped the trailing
    // sentinel on chatty commands, silently losing the cd.
    it('a cd survives a command that blows past the output cap', async () => {
      fs.mkdirSync(path.join(dir, 'sub'));
      const c = trackingCtx(dir);
      await BashTool.execute(
        { command: `cd sub && node -e "for(let i=0;i<3000;i++)console.log('X'.repeat(100))"` },
        c,
      );
      const after = await BashTool.execute({ command: PWD }, c);
      expect(canon(cmdOutput(after.text))).toBe(canon(path.join(dir, 'sub')));
    });

    // Regression (2026-07-18): a dangling `&&` absorbs the probe's `__yc_rc=$?`
    // line, so `exit $__yc_rc` fell through to printf's status — a FAILED
    // command reported success. Malformed commands must skip the probe.
    it('a dangling && does not mask a failing command as success', async () => {
      const r = await BashTool.execute({ command: 'false &&' }, trackingCtx(dir));
      expect(r.isError).toBe(true);
    });

    it('a context without setShellCwd still works (stateless fallback)', async () => {
      const r = await BashTool.execute({ command: 'echo plain' }, makeCtx(dir));
      expect(cmdOutput(r.text)).toBe('plain');
    });
  });

  it('an aborted signal kills the child', async () => {
    const ac = new AbortController();
    const actx = makeCtx(dir, ac.signal);
    const promise = BashTool.execute({ command: 'node -e "setTimeout(()=>{},10000)"' }, actx);
    setTimeout(() => ac.abort(), 100);
    const r = await promise;
    // Killed → non-zero/null exit surfaces as an error result, not a hang.
    expect(r.isError).toBe(true);
  });

  // Pin for the PowerShell fallback (Windows without Git Bash): probe === false,
  // so the tool must be stateless — no __YC_CWD__ wrapping — and effectiveCwd
  // must fall back to startCwd unconditionally, since PowerShell has no cwd
  // tracking. Same fs/which-mocking technique as
  // tests/harness-bash-shell-detect.test.ts, but scoped to THIS ONE test via
  // vi.doMock + vi.resetModules + a dynamic import — a file-level vi.mock('fs')
  // here would silently break every other test in this file that writes real
  // fixtures with fs.writeFileSync (Read/Write/Edit/Glob/Grep all do). The
  // statically-imported `BashTool` used by every other test in this file is
  // bound at file-load time and is unaffected by resetModules mid-run.
  describe('on Windows without Git Bash (probe === false)', () => {
    const realPlatform = process.platform;
    afterEach(async () => {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
      vi.doUnmock('fs');
      vi.doUnmock('which');
      vi.resetModules();
    });

    it('runs stateless: no cwd-probe wrapping, and the metadata line still reports the start directory', async () => {
      vi.doMock('fs', async (importActual) => {
        const actual = await importActual<typeof import('fs')>();
        return { ...actual, existsSync: () => false }; // no Git Bash anywhere on the machine
      });
      vi.doMock('which', () => ({ sync: () => null })); // git itself not on PATH either
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      vi.resetModules();
      vi.spyOn(console, 'warn').mockImplementation(() => {}); // detectShell's fallback warning
      spawnSpy.mockClear();

      const winBash = await import('../src/main/harness/tools/bash');
      winBash.resetShellCache();
      expect(winBash.getShell().label).toBe('PowerShell'); // confirms the fallback actually engaged

      const r = await winBash.BashTool.execute({ command: 'echo hi' }, ctx);

      // Stateless: the command must reach spawn() UNWRAPPED — no CWD_SENTINEL,
      // no `pwd -W` probe appended. PowerShell has no $PWD-persistence story
      // (tracksCwdFor() explicitly excludes it), so shipping it a bash-shaped
      // wrapper would be a syntax error, not a no-op.
      const call = spawnSpy.mock.calls.at(-1);
      expect(call?.[1]?.at(-1)).toBe('echo hi');

      // effectiveCwd falls back to startCwd unconditionally when !probe (the
      // `if (probe) {...}` cwd-extraction block never runs) — the metadata line
      // must still name the directory the command actually ran in, regardless of
      // whether spawning powershell.exe itself succeeds on this machine.
      expect(r.text).toContain(`[cwd: ${dir} ·`);
    });
  });
});

describe('Glob', () => {
  it('matches **/*.ts at top level AND in nested dirs, skipping node_modules', async () => {
    fs.writeFileSync(path.join(dir, 'top.ts'), '');
    fs.mkdirSync(path.join(dir, 'a/b'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'a/b/deep.ts'), '');
    fs.mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/pkg/ignored.ts'), '');
    const r = await GlobTool.execute({ pattern: '**/*.ts' }, ctx);
    expect(r.text).toContain('top.ts');
    expect(r.text).toContain('a/b/deep.ts');
    expect(r.text).not.toContain('ignored.ts');
  });

  it('src/**/*.ts matches both shallow and deep files', async () => {
    fs.mkdirSync(path.join(dir, 'src/deep'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src/f.ts'), '');
    fs.writeFileSync(path.join(dir, 'src/deep/g.ts'), '');
    const r = await GlobTool.execute({ pattern: 'src/**/*.ts' }, ctx);
    expect(r.text).toContain('src/f.ts');
    expect(r.text).toContain('src/deep/g.ts');
  });

  it('reports no matches with friendly text', async () => {
    const r = await GlobTool.execute({ pattern: '**/*.nomatch' }, ctx);
    expect(r.text).toBe('No files matched.');
  });
});

describe('Grep', () => {
  it('content mode returns line numbers', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'nope\nfindme here\nnope\n');
    const r = await GrepTool.execute({ pattern: 'findme', output_mode: 'content' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/2:.*findme/);
  });

  it('no matches returns friendly text, not an error', async () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'nothing to see\n');
    const r = await GrepTool.execute({ pattern: 'zzzznotpresent', output_mode: 'content' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe('No matches found.');
  });

  it('an aborted search surfaces a cancellation error, not partial success', async () => {
    // Give rg a big tree so it is still running when we abort.
    for (let i = 0; i < 200; i++) {
      fs.writeFileSync(path.join(dir, `f${i}.txt`), Array.from({ length: 500 }, () => 'needle line here').join('\n'));
    }
    const ac = new AbortController();
    const actx = makeCtx(dir, ac.signal);
    const promise = GrepTool.execute({ pattern: 'needle', output_mode: 'content' }, actx);
    ac.abort();
    const r = await promise;
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Canceled: the user interrupted this search/);
  });

  it('spawns rg with an explicit cwd of ctx.cwd (never inherits ambient cwd)', async () => {
    // Regression pin for the `spawn ENOTDIR` bug: Grep used to omit `cwd` from
    // spawn(), so rg inherited the Electron main process's ambient cwd — which in
    // the packaged app was not a usable directory and failed EVERY search. The
    // fix passes `cwd: ctx.cwd` explicitly (same pattern as BashTool). Assert the
    // contract directly: the spawn call for THIS search must carry ctx.cwd.
    fs.writeFileSync(path.join(dir, 'a.txt'), 'findme here\n');
    spawnSpy.mockClear();
    const r = await GrepTool.execute({ pattern: 'findme', output_mode: 'content' }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/findme/);
    // Find the spawn invocation that ran ripgrep and inspect its options arg.
    const rgCall = spawnSpy.mock.calls.find(
      (c) => Array.isArray(c[1]) && c[1].includes('findme'),
    );
    expect(rgCall, 'expected a spawn call running ripgrep for the search').toBeTruthy();
    const opts = rgCall![2] as { cwd?: string };
    expect(opts?.cwd, 'rg must be spawned with an explicit cwd (ctx.cwd), not inherit ambient cwd').toBe(ctx.cwd);
  });

  it('resolveRgPath rewrites an inside-asar rgPath to the unpacked binary', () => {
    // THE actual `spawn ENOTDIR` root cause (2026-07-20): in the packaged app,
    // @vscode/ripgrep resolves rgPath INSIDE app.asar (a FILE), and spawn() of a
    // command whose path prefix is a file throws ENOTDIR synchronously. The binary
    // IS unpacked to app.asar.unpacked/ — the tool just has to point there. Pin
    // the rewrite against BOTH separators and the no-op cases.
    //
    // Build a real on-disk fixture so the existsSync guard passes: mirror the
    // packaged layout under a tmp dir (.../app.asar.unpacked/.../bin/rg).
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rgpath-'));
    const asarPath = path.join(root, 'app.asar', 'node_modules', '@vscode', 'ripgrep-linux-x64', 'bin', 'rg');
    const unpackedPath = path.join(root, 'app.asar.unpacked', 'node_modules', '@vscode', 'ripgrep-linux-x64', 'bin', 'rg');
    fs.mkdirSync(path.dirname(unpackedPath), { recursive: true });
    fs.writeFileSync(unpackedPath, '#!/bin/sh\n');
    try {
      expect(resolveRgPath(asarPath)).toBe(unpackedPath);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
    // Already-unpacked input is returned unchanged (no app.asar.unpacked.unpacked):
    // the (?!\.unpacked) lookahead must not match. With no unpacked file on disk
    // the guard falls through to returning the input, so this doubles as the pin.
    const rootW = fs.mkdtempSync(path.join(os.tmpdir(), 'rgpath-w-'));
    try {
      const already = path.join(rootW, 'app.asar.unpacked', 'node_modules', '@vscode', 'ripgrep-linux-x64', 'bin', 'rg');
      expect(resolveRgPath(already)).toBe(already);
    } finally {
      fs.rmSync(rootW, { recursive: true, force: true });
    }
  });

  it('resolveRgPath falls back to the bundled path when no unpacked copy exists', () => {
    // Dev checkout: no asar at all → returned unchanged.
    const devPath = '/home/dev/youcoded/desktop/node_modules/@vscode/ripgrep-linux-x64/bin/rg';
    expect(resolveRgPath(devPath)).toBe(devPath);
    // Packaged-style path but the unpacked binary is ABSENT → keep the bundled
    // path (spawn will error, but with the real path surfaced, not a silent
    // rewrite). Uses a tmp dir so it can't collide with a real install.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rgpath-m-'));
    try {
      const missing = path.join(root, 'app.asar', 'node_modules', '@vscode', 'ripgrep-linux-x64', 'bin', 'rg');
      expect(resolveRgPath(missing)).toBe(missing);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('a synchronous spawn throw resolves an error result (never escapes to defineTool)', async () => {
    // spawn() throws SYNCHRONOUSLY when the command path or cwd has a non-directory
    // prefix. cwd = a FILE is the easiest way to force it cross-platform. The
    // 'error' handler (attached after spawn) cannot catch a sync throw, so without
    // the try/catch this escaped as a context-free `Grep failed: spawn ENOTDIR`.
    // Pin: the tool resolves a structured error that NAMES the failing cwd.
    const fileCwd = path.join(dir, 'not-a-dir.txt');
    fs.writeFileSync(fileCwd, 'x');
    const r = await GrepTool.execute({ pattern: 'findme', output_mode: 'content' }, makeCtx(fileCwd));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/could not start ripgrep/);
    expect(r.text).toContain(fileCwd); // the offending path is surfaced, not hidden
  });
});

describe('TodoWrite', () => {
  it('replaces the list in ctx', async () => {
    ctx.todos.push({ content: 'stale', status: 'pending', activeForm: 'Staling' });
    const r = await TodoWriteTool.execute(
      {
        todos: [
          { content: 'One', status: 'completed', activeForm: 'Doing one' },
          { content: 'Two', status: 'in_progress', activeForm: 'Doing two' },
        ],
      },
      ctx,
    );
    expect(ctx.todos.length).toBe(2);
    expect(ctx.todos[0].content).toBe('One');
    expect(r.text).toContain('2 items, 1 completed');
  });
});
