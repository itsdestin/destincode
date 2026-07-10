import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HookRelay } from '../src/main/hook-relay';
import { randomUUID } from 'crypto';

describe('HookRelay', () => {
  let relay: HookRelay;

  beforeEach(() => {
    // Use a unique pipe name per test to avoid EADDRINUSE
    const pipeName = `\\\\.\\pipe\\claude-desktop-hooks-test-${randomUUID()}`;
    relay = new HookRelay(pipeName);
  });

  afterEach(() => {
    relay.stop();
  });

  it('starts a named pipe server', async () => {
    await relay.start();
    expect(relay.isRunning()).toBe(true);
  });

  it('parses incoming hook JSON and emits events via simulateEvent', async () => {
    const events: any[] = [];
    relay.on('hook-event', (event) => events.push(event));

    const hookPayload = JSON.stringify({
      hook_event_name: 'PostToolUse',
      session_id: 'test-session',
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/test.ts', content: 'hello' },
      tool_response: 'File written',
    });

    await relay.simulateEvent(hookPayload);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('PostToolUse');
    expect(events[0].payload.tool_name).toBe('Write');
  });

  // hasPendingPermission is the main-process side of the stray-Enter fix:
  // while a PermissionRequest socket is held open, the session's PTY has a
  // live Ink select menu, so automated writers (the /reload-plugins
  // broadcast) must not type into it.
  describe('hasPendingPermission', () => {
    it('is false when nothing is pending', () => {
      expect(relay.hasPendingPermission('sess-1')).toBe(false);
    });

    it('tracks a held PermissionRequest socket by session and clears on close', async () => {
      await relay.start();

      const eventPromise = new Promise<any>((resolve) => {
        relay.once('hook-event', resolve);
      });

      const net = await import('net');
      const client = net.createConnection((relay as any).pipeName);
      await new Promise<void>((resolve, reject) => {
        client.on('connect', resolve);
        client.on('error', reject);
      });
      client.write(
        JSON.stringify({
          hook_event_name: 'PermissionRequest',
          _desktop_session_id: 'sess-1',
          tool_name: 'Bash',
        }) + '\n',
      );

      const event = await eventPromise;
      expect(event.type).toBe('PermissionRequest');
      expect(relay.hasPendingPermission('sess-1')).toBe(true);
      expect(relay.hasPendingPermission('other-session')).toBe(false);

      // Socket close (relay timeout / TUI-side answer) must clear the flag.
      const expired = new Promise<void>((resolve) => {
        relay.once('permission-expired', () => resolve());
      });
      client.destroy();
      await expired;
      expect(relay.hasPendingPermission('sess-1')).toBe(false);
    });

    it('clears when the request is answered via respond()', async () => {
      await relay.start();

      const eventPromise = new Promise<any>((resolve) => {
        relay.once('hook-event', resolve);
      });

      const net = await import('net');
      const client = net.createConnection((relay as any).pipeName);
      await new Promise<void>((resolve, reject) => {
        client.on('connect', resolve);
        client.on('error', reject);
      });
      client.write(
        JSON.stringify({
          hook_event_name: 'PermissionRequest',
          _desktop_session_id: 'sess-2',
        }) + '\n',
      );

      const event = await eventPromise;
      expect(relay.hasPendingPermission('sess-2')).toBe(true);

      relay.respond(event.payload._requestId, { decision: { behavior: 'deny' } });
      expect(relay.hasPendingPermission('sess-2')).toBe(false);
      client.destroy();
    });
  });
});
