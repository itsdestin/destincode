// The plain-shell session provider (local-engine upgrades §F, T5).
//
// A shell session is the user's own terminal running inside the app — no AI in
// it at all. It exists so "Run in terminal" can put a set-up command in front of
// the user instead of sending them off to find a terminal. Everything pinned
// here is a way that could go wrong SILENTLY: a command that never arrives, a
// command that runs itself, a hook pipe that makes a plain shell look like a
// Claude Code session, or the app typing "/reload-plugins" at someone's prompt.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import { SessionManager, resolveShellCommand, shellDisplayName } from '../src/main/session-manager';

const tmpDir = os.tmpdir();

// One fake PTY worker whose message handlers we can fire by hand — the real one
// is a child process, and the whole point of these tests is the ORDER in which
// SessionManager talks to it.
const handlers: Record<string, (...args: any[]) => void> = {};
const mockWorker = {
  send: vi.fn(),
  on: vi.fn((event: string, cb: (...args: any[]) => void) => { handlers[event] = cb; }),
  disconnect: vi.fn(),
  kill: vi.fn(),
  stderr: { on: vi.fn() },
};

vi.mock('child_process', () => ({
  fork: vi.fn(() => mockWorker),
  spawn: vi.fn(() => mockWorker),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => tmpDir) },
}));

/** The 'spawn' message SessionManager sent to the worker. */
function spawnMessage() {
  return mockWorker.send.mock.calls.map((c) => c[0]).find((m: any) => m?.type === 'spawn');
}
/** Every 'input' message, in order. */
function inputMessages() {
  return mockWorker.send.mock.calls.map((c) => c[0]).filter((m: any) => m?.type === 'input');
}

describe('shell sessions', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    for (const k of Object.keys(handlers)) delete handlers[k];
    manager = new SessionManager();
    manager.setPipeName('\\\\.\\pipe\\youcoded-test');
  });

  afterEach(() => { manager.destroyAll(); });

  describe('what gets spawned', () => {
    it('spawns the user\'s own shell with no arguments', () => {
      manager.createSession({ name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell' });
      const msg = spawnMessage();
      expect(msg.command).toBe(resolveShellCommand());
      expect(msg.command).not.toBe('claude');
      expect(msg.args).toEqual([]);
    });

    it('passes NO hook pipe and NO session id, so nothing watches it', () => {
      // If these carried real values and the user started Claude Code inside the
      // terminal, its hooks would report against THIS session — attaching a
      // transcript, and a chat view, to a plain shell.
      manager.createSession({ name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell' });
      const msg = spawnMessage();
      expect(msg.pipeName).toBe('');
      expect(msg.sessionId).toBe('');
    });

    it('still passes the pipe and id for a Claude session', () => {
      // Guards the guard: if the shell branch above were accidentally applied to
      // every session, Claude Code sessions would lose their hook relay and the
      // test above would still pass.
      const info = manager.createSession({ name: 'cc', cwd: tmpDir, skipPermissions: false });
      const msg = spawnMessage();
      expect(msg.command).toBe('claude');
      expect(msg.pipeName).toBe('\\\\.\\pipe\\youcoded-test');
      expect(msg.sessionId).toBe(info.id);
    });

    it('takes none of the Claude CLI flags', () => {
      manager.createSession({
        name: 'fish', cwd: tmpDir, skipPermissions: true, provider: 'shell',
        model: 'claude-sonnet-4-6', resumeSessionId: 'abc',
      });
      expect(spawnMessage().args).toEqual([]);
    });

    it('carries no model and labels itself with the shell name', () => {
      const info = manager.createSession({
        name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell', model: 'claude-sonnet-4-6',
      });
      expect(info.provider).toBe('shell');
      expect(info.model).toBeUndefined();
      expect(info.shellName).toBe(shellDisplayName(resolveShellCommand()));
    });
  });

  describe('the command is typed, not run', () => {
    const COMMAND = 'sudo pacman -S rocm-hip-runtime';

    it('writes NOTHING before the PTY has produced output', () => {
      // The rule this pins: a command written at spawn time can be swallowed by
      // the shell before its line editor is ready, and the terminal then opens
      // empty with no sign of what the user was meant to run.
      manager.createSession({
        name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell', initialCommand: COMMAND,
      });
      expect(inputMessages()).toEqual([]);
    });

    it('writes it on the first output, with NO trailing carriage return', () => {
      manager.createSession({
        name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell', initialCommand: COMMAND,
      });
      handlers.message({ type: 'data', data: '$ ' });
      const inputs = inputMessages();
      expect(inputs).toHaveLength(1);
      expect(inputs[0].data).toBe(COMMAND);
      // The carriage return is the difference between "here is the command" and
      // "I ran a sudo command on your machine".
      expect(inputs[0].data.endsWith('\r')).toBe(false);
      expect(inputs[0].data).not.toContain('\n');
    });

    it('writes it exactly once, however much output follows', () => {
      manager.createSession({
        name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell', initialCommand: COMMAND,
      });
      handlers.message({ type: 'data', data: 'welcome\r\n' });
      handlers.message({ type: 'data', data: '$ ' });
      handlers.message({ type: 'data', data: 'more' });
      expect(inputMessages()).toHaveLength(1);
    });

    it('writes nothing when no command was given', () => {
      manager.createSession({ name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell' });
      handlers.message({ type: 'data', data: '$ ' });
      expect(inputMessages()).toEqual([]);
    });

    it('never types into a Claude session, which has its own input path', () => {
      manager.createSession({
        name: 'cc', cwd: tmpDir, skipPermissions: false, initialCommand: COMMAND,
      });
      handlers.message({ type: 'data', data: 'hello' });
      expect(inputMessages()).toEqual([]);
    });
  });

  describe('the app never types at a shell prompt on its own', () => {
    it('does not broadcast /reload-plugins to a shell session', async () => {
      vi.useFakeTimers();
      try {
        const shell = manager.createSession({
          name: 'fish', cwd: tmpDir, skipPermissions: false, provider: 'shell',
        });
        expect(shell.provider).toBe('shell');
        mockWorker.send.mockClear();
        manager.broadcastReloadPlugins(0);
        await vi.advanceTimersByTimeAsync(10);
        // A shell session HAS a PTY, so without the provider guard the literal
        // text "/reload-plugins" plus an Enter would be typed into — and run by
        // — the user's shell.
        expect(inputMessages()).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('resolving the shell', () => {
    const realShell = process.env.SHELL;
    afterEach(() => {
      if (realShell === undefined) delete process.env.SHELL;
      else process.env.SHELL = realShell;
    });

    it('prefers $SHELL on this platform', () => {
      if (process.platform === 'win32') return;   // Windows has no $SHELL
      process.env.SHELL = '/usr/bin/fish';
      expect(resolveShellCommand()).toBe('/usr/bin/fish');
    });

    it('falls back to /bin/sh when $SHELL is unset', () => {
      if (process.platform === 'win32') return;
      delete process.env.SHELL;
      expect(resolveShellCommand()).toBe('/bin/sh');
    });

    it('reads a display name off a path', () => {
      expect(shellDisplayName('/usr/bin/fish')).toBe('fish');
      expect(shellDisplayName('/bin/zsh')).toBe('zsh');
      // 'powershell.exe' is the bare name Windows actually spawns — there is no
      // Windows path to test here, and path.basename on POSIX would not split
      // one anyway (it is path.win32.basename that knows about backslashes).
      expect(shellDisplayName('powershell.exe')).toBe('powershell');
    });
  });
});
