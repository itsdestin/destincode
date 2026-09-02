import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import os from 'os';
import fs from 'fs';
import path from 'path';
import { SessionManager } from '../src/main/session-manager';

const tmpDir = os.tmpdir();

// Mock child_process.fork to return a fake worker
const mockWorker = {
  send: vi.fn(),
  on: vi.fn(),
  disconnect: vi.fn(),
  kill: vi.fn(),
};

vi.mock('child_process', () => ({
  fork: vi.fn(() => mockWorker),
  spawn: vi.fn(() => mockWorker),
}));

vi.mock('electron', () => ({
  app: { isPackaged: false, getPath: vi.fn(() => tmpDir) },
}));

describe('SessionManager', () => {
  let manager: SessionManager;

  beforeEach(() => {
    vi.clearAllMocks();
    mockWorker.on = vi.fn();
    mockWorker.send = vi.fn();
    mockWorker.disconnect = vi.fn();
    manager = new SessionManager();
  });

  afterEach(() => {
    manager.destroyAll();
  });

  it('creates a session and returns session info', () => {
    const info = manager.createSession({
      name: 'test-session',
      cwd: tmpDir,
      skipPermissions: false,
    });

    expect(info.id).toBeDefined();
    expect(info.name).toBe('test-session');
    expect(info.cwd).toBe(tmpDir);
    expect(info.status).toBe('active');
  });

  it('includes model in session info when provided', () => {
    const info = manager.createSession({
      name: 'model-test',
      cwd: tmpDir,
      skipPermissions: false,
      model: 'claude-sonnet-4-6',
    });
    expect(info.model).toBe('claude-sonnet-4-6');
  });

  it('has undefined model in session info when not provided', () => {
    const info = manager.createSession({
      name: 'no-model-test',
      cwd: tmpDir,
      skipPermissions: false,
    });
    expect(info.model).toBeUndefined();
  });

  it('lists all active sessions', () => {
    manager.createSession({ name: 's1', cwd: tmpDir, skipPermissions: false });
    manager.createSession({ name: 's2', cwd: tmpDir, skipPermissions: false });

    const sessions = manager.listSessions();
    expect(sessions).toHaveLength(2);
  });

  it('destroys a session by id', () => {
    const info = manager.createSession({ name: 'test', cwd: tmpDir, skipPermissions: false });
    manager.destroySession(info.id);

    const sessions = manager.listSessions();
    expect(sessions).toHaveLength(0);
  });

  it('sends spawn with --dangerously-skip-permissions when requested', () => {
    manager.createSession({ name: 'skip', cwd: tmpDir, skipPermissions: true });

    const spawnMsg = mockWorker.send.mock.calls[0][0];
    expect(spawnMsg.type).toBe('spawn');
    expect(spawnMsg.args).toContain('--dangerously-skip-permissions');
  });

  // Claude Code has no link deliverable of its own; the app attaches one per
  // session (claude-code-mcp.ts). These two flags are the whole mechanism —
  // if they stop being passed, the link tile silently never appears in a
  // Claude Code session and nothing else fails.
  it('attaches the SendUserLink MCP server to every Claude Code session', () => {
    manager.createSession({ name: 'mcp', cwd: tmpDir, skipPermissions: false });
    const args: string[] = mockWorker.send.mock.calls[0][0].args;

    const configIdx = args.indexOf('--mcp-config');
    expect(configIdx).toBeGreaterThanOrEqual(0);
    const configPath = args[configIdx + 1];
    // A FILE path (node-pty re-joins these into one command line on Windows,
    // where inline JSON would not survive), inside the app's OWN data dir —
    // never ~/.claude.json, which no code path can un-write.
    expect(configPath.startsWith(path.join(tmpDir, 'claude-code-mcp'))).toBe(true);
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    expect(Object.keys(config.mcpServers)).toEqual(['youcoded']);
    expect(fs.existsSync(config.mcpServers.youcoded.args[0])).toBe(true);

    // Pre-approved, so handing the user a link never raises a permission prompt.
    expect(args).toContain('--allowedTools');
    expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__youcoded__SendUserLink');
  });

  it('emits pty-output when worker sends data', () => {
    manager.createSession({ name: 'test', cwd: tmpDir, skipPermissions: false });

    const messageHandler = mockWorker.on.mock.calls.find(
      (c: any) => c[0] === 'message'
    )?.[1];

    const received: string[] = [];
    manager.on('pty-output', (_id: string, data: string) => received.push(data));

    messageHandler({ type: 'data', data: 'hello world' });
    expect(received).toEqual(['hello world']);
  });

  it('emits session-exit when worker reports exit', () => {
    manager.createSession({ name: 'test', cwd: tmpDir, skipPermissions: false });

    const messageHandler = mockWorker.on.mock.calls.find(
      (c: any) => c[0] === 'message'
    )?.[1];

    const exits: string[] = [];
    manager.on('session-exit', (id: string) => exits.push(id));

    messageHandler({ type: 'exit', exitCode: 0 });
    expect(exits).toHaveLength(1);
    expect(manager.listSessions()).toHaveLength(0);
  });

  it('does not emit session-exit after explicit destroy', () => {
    manager.createSession({ name: 'test', cwd: tmpDir, skipPermissions: false });

    const exitHandler = mockWorker.on.mock.calls.find(
      (c: any) => c[0] === 'exit'
    )?.[1];

    manager.destroySession(manager.listSessions()[0].id);

    const exits: string[] = [];
    manager.on('session-exit', (id: string) => exits.push(id));

    exitHandler();
    expect(exits).toHaveLength(0);
  });

  // --- initialInput propagation (Task 10: dev:open-session-in) ---

  it('carries initialInput through to SessionInfo when provided', () => {
    const info = manager.createSession({
      name: 'prefill-test',
      cwd: tmpDir,
      skipPermissions: false,
      initialInput: 'hello from dev panel',
    });
    expect(info.initialInput).toBe('hello from dev panel');
  });

  it('leaves initialInput undefined when not provided', () => {
    const info = manager.createSession({
      name: 'no-prefill-test',
      cwd: tmpDir,
      skipPermissions: false,
    });
    // initialInput should be absent, not an empty string — keeps the object clean.
    expect(info.initialInput).toBeUndefined();
  });

  it('emits session-created event with initialInput in the info object', () => {
    const emitted: any[] = [];
    manager.on('session-created', (info) => emitted.push(info));
    manager.createSession({
      name: 'emit-prefill-test',
      cwd: tmpDir,
      skipPermissions: false,
      initialInput: 'prefill text',
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0].initialInput).toBe('prefill text');
  });

  // --- broadcastReloadPlugins gating (stray-Enter fix) ---
  //
  // `/reload-plugins\r` typed into a session whose PTY is showing a live Ink
  // select menu (permission prompt / AskUserQuestion) presses Enter on the
  // highlighted option. The broadcast must defer per-session while a
  // permission request is pending there.

  describe('broadcastReloadPlugins gating', () => {
    const reloadSends = () =>
      mockWorker.send.mock.calls.filter(
        (c: any) => c[0].type === 'input' && c[0].data === '/reload-plugins\r',
      );

    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('sends /reload-plugins to active sessions after the delay', () => {
      manager.createSession({ name: 's1', cwd: tmpDir, skipPermissions: false });
      manager.broadcastReloadPlugins(100);
      expect(reloadSends()).toHaveLength(0);
      vi.advanceTimersByTime(100);
      expect(reloadSends()).toHaveLength(1);
    });

    it('defers the send while the gate reports the session blocked', () => {
      manager.createSession({ name: 's1', cwd: tmpDir, skipPermissions: false });
      let blocked = true;
      manager.setReloadPluginsGate(() => blocked);

      manager.broadcastReloadPlugins(100);
      vi.advanceTimersByTime(100);
      expect(reloadSends()).toHaveLength(0);

      // Still blocked across one retry tick…
      vi.advanceTimersByTime(5000);
      expect(reloadSends()).toHaveLength(0);

      // …then the permission resolves and the next retry delivers the reload.
      blocked = false;
      vi.advanceTimersByTime(5000);
      expect(reloadSends()).toHaveLength(1);
    });

    it('gives up after the retry cap instead of retrying forever', () => {
      manager.createSession({ name: 's1', cwd: tmpDir, skipPermissions: false });
      manager.setReloadPluginsGate(() => true);

      manager.broadcastReloadPlugins(0);
      // Far beyond the cap window — nothing should ever be sent.
      vi.advanceTimersByTime(10 * 60 * 1000);
      expect(reloadSends()).toHaveLength(0);
    });

    it('drops the retry when the session is destroyed in the meantime', () => {
      const info = manager.createSession({ name: 's1', cwd: tmpDir, skipPermissions: false });
      let blocked = true;
      manager.setReloadPluginsGate(() => blocked);

      manager.broadcastReloadPlugins(0);
      vi.advanceTimersByTime(0);
      manager.destroySession(info.id);
      blocked = false;
      vi.advanceTimersByTime(5000);
      expect(reloadSends()).toHaveLength(0);
    });
  });
});
