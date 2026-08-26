// Native mirror of Claude Code's SendUserFile (spec 2026-08-25 §6). Stateless:
// validates paths, reports, and leaves the one-render-per-reply rule to the
// renderer. Errors name every bad path WITH its reason — "does not exist" about
// a "~" path that exists would be a lie (docs/error-message-standards.md).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SendUserFileTool } from '../src/main/harness/tools/send-user-file';
import type { ToolContext } from '../src/main/harness/tools/types';

let dir: string;
let ctx: ToolContext;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'send-user-file-'));
  ctx = { sessionId: 'test', cwd: dir, signal: new AbortController().signal, readRegistry: new Map(), todos: [] };
  fs.writeFileSync(path.join(dir, 'report.md'), '# r\n');
  fs.mkdirSync(path.join(dir, 'out'));
  fs.writeFileSync(path.join(dir, 'out', 'chart.png'), Buffer.from([0x89, 0x50]));
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('SendUserFile', () => {
  it('sends one relative file', async () => {
    const r = await SendUserFileTool.execute({ files: ['report.md'] }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe('Sent 1 file to the user.');
  });

  it('sends several absolute files; display and caption do not change the text', async () => {
    const r = await SendUserFileTool.execute(
      { files: [path.join(dir, 'report.md'), path.join(dir, 'out', 'chart.png')], caption: 'both', display: 'render', status: 'normal' },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe('Sent 2 files to the user.');
  });

  it('a missing file fails the WHOLE call and names the path', async () => {
    const r = await SendUserFileTool.execute({ files: ['report.md', 'nope.md'] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('nothing was sent');
    expect(r.text).toContain('nope.md does not exist');
    expect(r.text).not.toContain('report.md');
  });

  it('a directory is named as a directory, not as missing', async () => {
    const r = await SendUserFileTool.execute({ files: ['out'] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/out is a directory/);
    expect(r.text).not.toContain('does not exist');
  });

  it('a "~" path says "~" is not expanded — never "does not exist"', async () => {
    const r = await SendUserFileTool.execute({ files: ['~/report.md'] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('"~" is not expanded');
    expect(r.text).not.toContain('does not exist');
  });

  it('lists every bad path with its own reason', async () => {
    const r = await SendUserFileTool.execute({ files: ['nope.md', 'out', '~/x'] }, ctx);
    expect(r.text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(3);
  });

  it('has no permission subject (no cwd jail — a /tmp chart must go through)', () => {
    expect(SendUserFileTool.permissionSubject({ files: ['/tmp/x.png'] })).toBeUndefined();
  });

  it('tells the model that only the first render per reply is honored', () => {
    expect(SendUserFileTool.description).toMatch(/first such request in a reply/);
    expect(SendUserFileTool.description).toMatch(/not scratch/i);
  });
});
