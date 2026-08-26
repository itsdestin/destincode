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
import { toPosix } from '../src/main/harness/tools/guards';

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

  it('a missing file fails the WHOLE call and names the path in "path: reason" shape', async () => {
    const r = await SendUserFileTool.execute({ files: ['report.md', 'nope.md'] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('nothing was sent');
    expect(r.text).toContain(`${toPosix(path.join(dir, 'nope.md'))}: does not exist`);
    expect(r.text).not.toContain('report.md');
  });

  it('a directory is named as a directory, not as missing, in "path: reason" shape', async () => {
    const r = await SendUserFileTool.execute({ files: ['out'] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain(`${toPosix(path.join(dir, 'out'))}: is a directory`);
    expect(r.text).not.toContain('does not exist');
  });

  it('a "~" path says "~" is not expanded — never "does not exist" — and keeps the raw (unresolved) path', async () => {
    const r = await SendUserFileTool.execute({ files: ['~/report.md'] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('~/report.md: "~" is not expanded here; use an absolute path');
    expect(r.text).not.toContain('does not exist');
  });

  it('lists every bad path paired with ITS OWN reason, in the shared "path: reason" shape', async () => {
    const r = await SendUserFileTool.execute({ files: ['nope.md', 'out', '~/x'] }, ctx);
    const lines = r.text.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(3);
    // Each assertion pins path AND reason together so the test would fail if
    // the lines were emitted in the right count but the wrong pairing (e.g.
    // all three saying "does not exist").
    expect(lines[0]).toBe(`- ${toPosix(path.join(dir, 'nope.md'))}: does not exist`);
    expect(lines[1]).toBe(`- ${toPosix(path.join(dir, 'out'))}: is a directory`);
    expect(lines[2]).toBe('- ~/x: "~" is not expanded here; use an absolute path');
  });

  it('a path behind an unreadable parent directory reports the real errno (EACCES), not a guessed "does not exist"', async () => {
    // Root (and Windows, where chmod doesn't restrict traversal the same way)
    // ignores directory permission bits, so the EACCES this test depends on
    // would never fire there — skip rather than assert a false negative.
    if (process.platform === 'win32' || (process.getuid && process.getuid() === 0)) return;
    const blocked = path.join(dir, 'blocked');
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(blocked, 'secret.txt'), 'x');
    fs.chmodSync(blocked, 0o000); // remove traverse (x) permission on the PARENT dir
    try {
      const r = await SendUserFileTool.execute({ files: ['blocked/secret.txt'] }, ctx);
      expect(r.isError).toBe(true);
      expect(r.text).toContain(`${toPosix(path.join(blocked, 'secret.txt'))}: cannot be read (EACCES)`);
      expect(r.text).not.toContain('does not exist');
    } finally {
      fs.chmodSync(blocked, 0o755); // restore so afterEach's rmSync can clean up
    }
  });

  it('has no permission subject (no cwd jail — a /tmp chart must go through)', () => {
    expect(SendUserFileTool.permissionSubject({ files: ['/tmp/x.png'] })).toBeUndefined();
  });

  it('tells the model that only the first render per reply is honored', () => {
    expect(SendUserFileTool.description).toMatch(/first such request in a reply/);
    expect(SendUserFileTool.description).toMatch(/not scratch/i);
  });
});
