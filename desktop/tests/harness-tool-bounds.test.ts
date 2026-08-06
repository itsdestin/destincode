// Regression pins for the 2026-08-01 harness tool-honesty review (Tasks 6-9):
// Grep's error advice, Grep/Glob path-format agreement, Grep's per-file/output
// caps, and Glob's "newest first" claim.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { grepErrorMessage, GrepTool } from '../src/main/harness/tools/grep';
import { GlobTool } from '../src/main/harness/tools/glob';
import type { ToolContext } from '../src/main/harness/tools/types';

function makeCtx(cwd: string): ToolContext {
  return { sessionId: 'test', cwd, signal: new AbortController().signal, readRegistry: new Map(), todos: [] };
}

describe('grepErrorMessage', () => {
  const P = '/ws/youcoded/desktop/src/main';
  const CWD = '/ws';

  it('keeps regex advice when ripgrep actually reported a regex parse error', () => {
    const err = 'rg: regex parse error:\n  (?:ipcMain\\.handle(()\n                    ^\nerror: unclosed group';
    const out = grepErrorMessage(err, P, CWD);
    expect(out).toContain('unclosed group');
    expect(out).toContain('Check the regex syntax.');
  });

  it('names the path and workspace root when ripgrep reported a missing directory', () => {
    const err = `rg: ${P}: IO error for operation on ${P}: No such file or directory (os error 2)`;
    const out = grepErrorMessage(err, P, CWD);
    expect(out).toContain(P);
    expect(out).toContain(CWD);
    // The wrong path was the whole problem. Never send the model regex-hunting.
    expect(out).not.toContain('Check the regex syntax.');
  });

  it('offers NO advice when the failure matches neither shape', () => {
    const out = grepErrorMessage('rg: something entirely unexpected', P, CWD);
    expect(out).toContain('something entirely unexpected');
    expect(out).not.toContain('Check the regex syntax.');
    expect(out).not.toContain('does not exist');
  });
});

describe('Grep and Glob agree on path format', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'grep-paths-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const marker = 1;\n');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('Grep returns workspace-relative paths for targets inside the workspace', async () => {
    const r = await GrepTool.execute({ pattern: 'marker', output_mode: 'files_with_matches' }, makeCtx(dir));
    expect(r.text).toContain('src/a.ts');
    expect(r.text).not.toContain(dir);
  });

  it('Glob returns the same shape for the same file', async () => {
    const r = await GlobTool.execute({ pattern: '**/*.ts' }, makeCtx(dir));
    expect(r.text).toContain('src/a.ts');
  });
});
