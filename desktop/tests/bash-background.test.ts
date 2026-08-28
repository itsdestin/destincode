// G-1 background Bash — the Bash tool's half: foreground family kill (Task 2),
// run_in_background (Task 3), hand-off at the time limit (Task 4).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { BashTool } from '../src/main/harness/tools/bash';
import { ShellRegistry, MAX_EXPLICIT_RUNNING } from '../src/main/harness/shell-registry';
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

describe.skipIf(!posix)('Task 3: run_in_background', () => {
  it('returns at once with the §4.1 text and a running registry entry; the tool result is not an error', async () => {
    const t0 = Date.now();
    const r = await BashTool.execute({ command: 'sleep 3', run_in_background: true }, ctx());
    expect(Date.now() - t0).toBeLessThan(1_000);
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/^Started in the background \(shell id sh-[0-9a-f]{4}\)\. You'll be told when it finishes\. BashOutput reads new output \(or lists runs\); KillShell stops it\. Running now: 1 of 5\.$/);
    const run = reg.list()[0];
    expect(run.status).toBe('running');
    expect(run.toolUseId).toBe('toolu_bg');
    expect(run.explicit).toBe(true);
  });

  it('a background start never changes the working directory or the env', async () => {
    let tracked: string | undefined;
    let env: unknown;
    fs.mkdirSync(path.join(dir, 'sub'));
    await BashTool.execute({ command: 'cd sub; export FOO=1', run_in_background: true }, ctx({ setShellCwd: (n) => { tracked = n; }, setShellEnv: (e) => { env = e; } }));
    await reg.list()[0].exited;
    expect(tracked).toBeUndefined();
    expect(env).toBeUndefined();
  });

  it('stdin is closed: a command that waits for input fails fast instead of hanging', async () => {
    await BashTool.execute({ command: 'read line; echo "got=$line"; exit 7', run_in_background: true }, ctx());
    const run = reg.list()[0];
    await Promise.race([run.exited, new Promise((_, rej) => setTimeout(() => rej(new Error('hung on stdin')), 3_000))]);
    expect(run.exitCode).toBe(7);
  });

  it('persistent_env + run_in_background is refused in one sentence', async () => {
    const r = await BashTool.execute({ command: 'echo x', run_in_background: true, persistent_env: true }, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Bash rejected: persistent_env cannot be combined with run_in_background — a background command never reports its environment back. Drop one of the two.');
    expect(reg.list()).toHaveLength(0);
  });

  it('with no registry in the context, run_in_background is refused (never silently foregrounded)', async () => {
    const r = await BashTool.execute({ command: 'echo x', run_in_background: true }, ctx({ shells: undefined }));
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Bash rejected: background execution is not available in this session.');
  });

  it('the 6th explicit start is refused naming the running ids', async () => {
    for (let i = 0; i < MAX_EXPLICIT_RUNNING; i++) await BashTool.execute({ command: 'sleep 5', run_in_background: true }, ctx());
    const ids = reg.runningExplicitIds();
    const r = await BashTool.execute({ command: 'sleep 5', run_in_background: true }, ctx());
    expect(r.isError).toBe(true);
    expect(r.text).toBe(`5 background commands are already running (${ids.join(', ')}). Stop one with KillShell before starting another.`);
  });
});
