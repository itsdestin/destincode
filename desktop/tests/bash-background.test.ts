// G-1 background Bash — the Bash tool's half: foreground family kill (Task 2),
// run_in_background (Task 3), hand-off at the time limit (Task 4).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BashTool } from '../src/main/harness/tools/bash';
import { ShellRegistry } from '../src/main/harness/shell-registry';
import type { ToolContext } from '../src/main/harness/tools/types';

const posix = process.platform !== 'win32';
function alive(pid: number): boolean { try { process.kill(pid, 0); return true; } catch { return false; } }
function waitFor(cond: () => boolean, ms = 5_000): Promise<void> {
  const start = Date.now();
  return new Promise((res, rej) => {
    const tick = () => { if (cond()) return res(); if (Date.now() - start > ms) return rej(new Error('waitFor timed out')); setTimeout(tick, 25); };
    tick();
  });
}

let dir: string;
let reg: ShellRegistry;
function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return { sessionId: 'bg-test', cwd: dir, signal: new AbortController().signal, readRegistry: new Map(), todos: [], toolCallId: 'toolu_bg', shells: reg, ...over } as ToolContext;
}
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-bg-')); reg = new ShellRegistry('bg-test'); });
afterEach(async () => { await reg.killAll('app-quit', { graceMs: 0 }); fs.rmSync(dir, { recursive: true, force: true }); });

describe.skipIf(!posix)('Task 2: foreground interrupt kills the grandchild and still resolves immediately', () => {
  it('sleep 30 & wait — abort resolves at once, the grandchild is gone within the grace period', async () => {
    const ac = new AbortController();
    const pidFile = path.join(dir, 'pid');
    const promise = BashTool.execute({ command: `sleep 30 & echo $! > "${pidFile}"; wait` }, ctx({ signal: ac.signal, shells: undefined }));
    await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim() !== '');
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    expect(alive(pid)).toBe(true);
    const t0 = Date.now();
    ac.abort();
    const r = await promise;
    expect(Date.now() - t0).toBeLessThan(1_000);   // resolves NOW, never waits for 'close'
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/Canceled: the user interrupted this operation/);
    await waitFor(() => !alive(pid), 4_000);
    expect(alive(pid)).toBe(false);
  }, 15_000);
});
