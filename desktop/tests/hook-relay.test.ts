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

  describe('tier-1 hold (2026-07-30 spec §1)', () => {
    it('auto-denies with nested decision shape + app-timeout reason when the hold fires', async () => {
      const short = new HookRelay((relay as any).pipeName + '-hold', 60 /* holdMs */);
      await short.start();
      const expired = new Promise<[string, string, string?]>((resolve) => {
        short.once('permission-expired', (sid, rid, reason) => resolve([sid, rid, reason]));
      });
      const net = await import('net');
      const client = net.createConnection((short as any).pipeName);
      await new Promise<void>((res, rej) => { client.on('connect', res); client.on('error', rej); });
      const received = new Promise<string>((resolve) => {
        let buf = '';
        client.on('data', (c) => { buf += c; if (buf.includes('\n')) resolve(buf); });
      });
      client.write(JSON.stringify({ hook_event_name: 'PermissionRequest', _desktop_session_id: 'sess-h' }) + '\n');

      const [sid, , reason] = await expired;
      expect(sid).toBe('sess-h');
      expect(reason).toBe('app-timeout');
      // Assert against the RELAY'S OWN parse path: relay-blocking.js reads
      // appDecision.decision — a flat shape would make this undefined.
      const decision = JSON.parse((await received).trim());
      expect(decision.decision.behavior).toBe('deny');
      expect(decision.decision.message).toContain('auto-denied');
      short.stop();
      client.destroy();
    });

    it('caps the hold at 60s-tier when the session gate says unroutable', async () => {
      const short = new HookRelay((relay as any).pipeName + '-unroutable', 60_000, 40 /* unroutableHoldMs */);
      short.setSessionGate(() => false);
      await short.start();
      const expired = new Promise<string | undefined>((resolve) => {
        short.once('permission-expired', (_s, _r, reason) => resolve(reason));
      });
      const net = await import('net');
      const client = net.createConnection((short as any).pipeName);
      await new Promise<void>((res, rej) => { client.on('connect', res); client.on('error', rej); });
      client.write(JSON.stringify({ hook_event_name: 'PermissionRequest', _desktop_session_id: 'ghost' }) + '\n');
      expect(await expired).toBe('unroutable');
      short.stop();
      client.destroy();
    });

    it("far-end death emits 'hook-closed'; respond() cancels the hold and emits nothing", async () => {
      const short = new HookRelay((relay as any).pipeName + '-closed', 100);
      await short.start();
      const reasons: (string | undefined)[] = [];
      short.on('permission-expired', (_s, _r, reason) => reasons.push(reason));

      const net = await import('net');
      const c1 = net.createConnection((short as any).pipeName);
      await new Promise<void>((res, rej) => { c1.on('connect', res); c1.on('error', rej); });
      const evt = new Promise<any>((resolve) => short.once('hook-event', resolve));
      c1.write(JSON.stringify({ hook_event_name: 'PermissionRequest', _desktop_session_id: 'sess-c' }) + '\n');
      const e1 = await evt;
      c1.destroy(); // far end dies
      await new Promise((r) => setTimeout(r, 30));
      expect(reasons).toEqual(['hook-closed']);

      const c2 = net.createConnection((short as any).pipeName);
      await new Promise<void>((res, rej) => { c2.on('connect', res); c2.on('error', rej); });
      const evt2 = new Promise<any>((resolve) => short.once('hook-event', resolve));
      c2.write(JSON.stringify({ hook_event_name: 'PermissionRequest', _desktop_session_id: 'sess-d' }) + '\n');
      const e2 = await evt2;
      short.respond(e2.payload._requestId, { decision: { behavior: 'deny' } });
      await new Promise((r) => setTimeout(r, 150)); // past holdMs — timer must be dead
      expect(reasons).toEqual(['hook-closed']); // respond() itself emits nothing (caller's job)
      short.stop();
      c2.destroy();
    });
  });
});
