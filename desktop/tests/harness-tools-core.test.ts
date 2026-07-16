import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ReadTool } from '../src/main/harness/tools/read';
import { WriteTool } from '../src/main/harness/tools/write';
import { EditTool } from '../src/main/harness/tools/edit';
import { BashTool } from '../src/main/harness/tools/bash';
import { GlobTool } from '../src/main/harness/tools/glob';
import { GrepTool } from '../src/main/harness/tools/grep';
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
    expect(r.text).toContain('(exit code 3)');
  });

  it('times out and reports it', async () => {
    const r = await BashTool.execute({ command: 'node -e "setTimeout(()=>{},10000)"', timeout: 50 }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/timed out/i);
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
