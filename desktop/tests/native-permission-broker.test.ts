import { describe, it, expect } from 'vitest';
import { PermissionBroker } from '../src/main/harness/permission-broker';

// The emitted payload uses CC's snake_case field names because hook-dispatcher
// reads payload._requestId / tool_name / tool_input (verified in Task 8 Step 1).
describe('PermissionBroker', () => {
  it('emits a hook-shaped request and resolves on respond()', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const p = broker.ask({ sessionId: 's1', toolName: 'Bash', toolInput: { command: 'npm test' }, denyListed: false });
    expect(emitted[0].type).toBe('PermissionRequest');
    expect(emitted[0].sessionId).toBe('s1');
    expect(emitted[0].payload.tool_name).toBe('Bash');
    const requestId = emitted[0].payload._requestId as string;
    expect(requestId).toMatch(/^native-/); // MUST NOT collide with CC hook ids
    expect(broker.respond(requestId, { behavior: 'allow' })).toBe(true);
    await expect(p).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('unwraps the real ToolCard decision shape and flags Always-allow', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const p = broker.ask({ sessionId: 's1', toolName: 'Bash', toolInput: {}, denyListed: true });
    const requestId = emitted[0].payload._requestId as string;
    // ToolCard sends { decision: { behavior }, updatedPermissions? }.
    expect(broker.respond(requestId, { decision: { behavior: 'allow' }, updatedPermissions: ['Bash(npm test)'] })).toBe(true);
    await expect(p).resolves.toMatchObject({ behavior: 'allow', always: true });
  });

  it('rides permissionMode along the PermissionRequest payload (full-auto safety stop keys on it)', () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    void broker.ask({ sessionId: 's1', toolName: 'Bash', toolInput: { command: 'git push' }, denyListed: true, permissionMode: 'full-auto' });
    expect(emitted[0].payload.permissionMode).toBe('full-auto');
  });

  it('omits permissionMode when the caller did not supply one (CC-path payload shape unchanged)', () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    void broker.ask({ sessionId: 's1', toolName: 'Bash', toolInput: {}, denyListed: false });
    expect('permissionMode' in emitted[0].payload).toBe(false);
  });

  it('does NOT flag always when behavior is deny (guards against persisting an allow rule for a denied tool)', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const p = broker.ask({ sessionId: 's1', toolName: 'Bash', toolInput: {}, denyListed: false });
    const requestId = emitted[0].payload._requestId as string;
    expect(broker.respond(requestId, { decision: { behavior: 'deny' }, updatedPermissions: ['Bash(rm)'] })).toBe(true);
    const d = await p;
    expect(d.behavior).toBe('deny');
    expect(d.always).toBeFalsy();
  });

  it('passes decision.updatedInput through to the resolver (AskUserQuestion answers)', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const p = broker.ask({ sessionId: 's1', toolName: 'AskUserQuestion', toolInput: { questions: [] }, denyListed: false });
    const requestId = emitted[0].payload._requestId as string;
    broker.respond(requestId, { decision: { behavior: 'allow', updatedInput: { questions: [], answers: { 'Q?': 'Blue' } } } });
    const d = await p;
    expect(d.behavior).toBe('allow');
    expect(d.updatedInput).toEqual({ questions: [], answers: { 'Q?': 'Blue' } });
    expect(d.always).toBe(false); // updatedInput must NOT be mistaken for updatedPermissions/always
  });

  it('respond() returns false for unknown ids (lets ipc-handlers fall through to hookRelay)', () => {
    expect(new PermissionBroker().respond('hook-123', { behavior: 'allow' })).toBe(false);
  });

  it('cancelAll() resolves every pending ask across sessions as canceled and expires each card', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const p1 = broker.ask({ sessionId: 's1', toolName: 'Bash', toolInput: {}, denyListed: false });
    const p2 = broker.ask({ sessionId: 's2', toolName: 'Edit', toolInput: {}, denyListed: false });
    broker.cancelAll();
    await expect(p1).resolves.toMatchObject({ behavior: 'canceled' });
    await expect(p2).resolves.toMatchObject({ behavior: 'canceled' });
    const expired = emitted.filter((e) => e.type === 'PermissionExpired');
    expect(expired.map((e) => e.sessionId).sort()).toEqual(['s1', 's2']);
  });

  it('cancel() resolves pending asks as canceled and emits PermissionExpired', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const p = broker.ask({ sessionId: 's1', toolName: 'Edit', toolInput: {}, denyListed: false });
    broker.cancelSession('s1');
    await expect(p).resolves.toMatchObject({ behavior: 'canceled' });
    expect(emitted.some((e) => e.type === 'PermissionExpired')).toBe(true); // clears the card
  });
});
