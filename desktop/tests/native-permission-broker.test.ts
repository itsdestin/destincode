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

  it('respond() returns false for unknown ids (lets ipc-handlers fall through to hookRelay)', () => {
    expect(new PermissionBroker().respond('hook-123', { behavior: 'allow' })).toBe(false);
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
