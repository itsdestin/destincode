import { describe, it, expect, vi } from 'vitest';
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

  it('stamps `dismissed` on a human deny — and ONLY on a deny', async () => {
    // respond() is the only path a person's answer travels, so it is the only
    // place that can honestly say "a human said no". The driver ends the turn on
    // a dismissed AskUserQuestion; a POLICY askUser (childAskPolicy, the harness
    // evaluator's jail) constructs its own decision, never sets this, and keeps
    // the old carry-on semantics. Guard: harness-session-loop's POLICY-deny test.
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));

    const denied = broker.ask({ sessionId: 's1', toolName: 'AskUserQuestion', toolInput: {}, denyListed: false });
    expect(broker.respond(emitted[0].payload._requestId as string, { decision: { behavior: 'deny' } })).toBe(true);
    expect((await denied).dismissed).toBe(true);

    const allowed = broker.ask({ sessionId: 's1', toolName: 'AskUserQuestion', toolInput: {}, denyListed: false });
    expect(broker.respond(emitted[1].payload._requestId as string, { decision: { behavior: 'allow' } })).toBe(true);
    expect((await allowed).dismissed).toBeFalsy();
  });

  it('a canceled ask carries no `dismissed` (an interrupt is not a dismissal)', async () => {
    // cancelSession resolves pending asks as 'canceled'; the driver unwinds that
    // as an interrupt. It must not look like the user closed the card.
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const p = broker.ask({ sessionId: 's1', toolName: 'AskUserQuestion', toolInput: {}, denyListed: false });
    broker.cancelSession('s1');
    const d = await p;
    expect(d.behavior).toBe('canceled');
    expect(d.dismissed).toBeFalsy();
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

  // --- Task 8: timeout + late-response + raisedBy cancellation ---

  it('ask() with a timeout resolves onTimeout() at the deadline but leaves the entry answerable', async () => {
    vi.useFakeTimers();
    try {
      const broker = new PermissionBroker();
      const emitted: any[] = [];
      broker.on('hook-event', (e) => emitted.push(e));
      const p = broker.ask(
        { sessionId: 's1', toolName: 'Bash', toolInput: {}, denyListed: true },
        { timeoutMs: 1000, onTimeout: () => ({ behavior: 'deny', message: 'redirect' }) },
      );
      await vi.advanceTimersByTimeAsync(1000);
      await expect(p).resolves.toEqual({ behavior: 'deny', message: 'redirect' });
      const requestId = emitted[0].payload._requestId as string;
      // Still answerable — respond() finds it and reports success, even though
      // the promise above already settled.
      expect(broker.respond(requestId, { behavior: 'allow' })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a real respond() before the deadline clears the timer — no leaked timeout fires later', async () => {
    vi.useFakeTimers();
    try {
      const broker = new PermissionBroker();
      const emitted: any[] = [];
      broker.on('hook-event', (e) => emitted.push(e));
      const onTimeout = vi.fn(() => ({ behavior: 'deny' as const, message: 'redirect' }));
      const p = broker.ask({ sessionId: 's1', toolName: 'Bash', toolInput: {}, denyListed: true }, { timeoutMs: 1000, onTimeout });
      const requestId = emitted[0].payload._requestId as string;
      broker.respond(requestId, { behavior: 'allow' });
      await expect(p).resolves.toMatchObject({ behavior: 'allow' });
      await vi.advanceTimersByTimeAsync(5000); // well past the deadline
      expect(onTimeout).not.toHaveBeenCalled(); // the timer was cleared on respond(), not merely raced
    } finally {
      vi.useRealTimers();
    }
  });

  it('a late respond() after timeout routes to the lateResponseHandler instead of dropping silently', async () => {
    vi.useFakeTimers();
    try {
      const broker = new PermissionBroker();
      const late: any[] = [];
      broker.setLateResponseHandler((entry, decision) => late.push({ entry, decision }));
      const emitted: any[] = [];
      broker.on('hook-event', (e) => emitted.push(e));
      broker.ask(
        { sessionId: 'parent-1', toolName: 'Bash', toolInput: {}, denyListed: true, raisedBy: 'child-1', specialist: { childId: 'child-1', agentType: 'worker', title: 'W' } },
        { timeoutMs: 1000, onTimeout: () => ({ behavior: 'deny', message: 'redirect' }) },
      );
      await vi.advanceTimersByTimeAsync(1000);
      const requestId = emitted[0].payload._requestId as string;
      expect(broker.respond(requestId, { behavior: 'allow' })).toBe(true);
      expect(late).toHaveLength(1);
      expect(late[0].entry).toMatchObject({ sessionId: 'parent-1', toolName: 'Bash', raisedBy: 'child-1' });
      expect(late[0].decision.behavior).toBe('allow');
      // A THIRD respond() for the same (now fully consumed) id is unknown.
      expect(broker.respond(requestId, { behavior: 'deny' })).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancelSession(childId) cancels a routed ask (raisedBy match) while still within its window', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const p = broker.ask({ sessionId: 'parent-1', toolName: 'Bash', toolInput: {}, denyListed: true, raisedBy: 'child-1' });
    broker.cancelSession('child-1'); // the CHILD's id, not the parent's — this is the routed-ask case
    await expect(p).resolves.toMatchObject({ behavior: 'canceled' });
    expect(emitted.some((e) => e.type === 'PermissionExpired')).toBe(true);
  });

  it('cancelSession(childId) does NOT cancel a routed ask that already timed out — it stays answerable for the parent', async () => {
    vi.useFakeTimers();
    try {
      const broker = new PermissionBroker();
      const emitted: any[] = [];
      broker.on('hook-event', (e) => emitted.push(e));
      const p = broker.ask(
        { sessionId: 'parent-1', toolName: 'Bash', toolInput: {}, denyListed: true, raisedBy: 'child-1' },
        { timeoutMs: 1000, onTimeout: () => ({ behavior: 'deny', message: 'redirect' }) },
      );
      await vi.advanceTimersByTimeAsync(1000);
      await p; // settles with the redirect
      broker.cancelSession('child-1'); // the child was torn down AFTER its ask already timed out
      const requestId = emitted[0].payload._requestId as string;
      // Still present: a real answer can still reach the parent (Task 8's late-answer path).
      expect(broker.respond(requestId, { behavior: 'allow' })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancelSession(parentId) cancels a routed, already-timed-out ask too — the parent's own teardown always wins", async () => {
    vi.useFakeTimers();
    try {
      const broker = new PermissionBroker();
      const emitted: any[] = [];
      broker.on('hook-event', (e) => emitted.push(e));
      const p = broker.ask(
        { sessionId: 'parent-1', toolName: 'Bash', toolInput: {}, denyListed: true, raisedBy: 'child-1' },
        { timeoutMs: 1000, onTimeout: () => ({ behavior: 'deny', message: 'redirect' }) },
      );
      await vi.advanceTimersByTimeAsync(1000);
      await p;
      broker.cancelSession('parent-1');
      const requestId = emitted[0].payload._requestId as string;
      expect(broker.respond(requestId, { behavior: 'allow' })).toBe(false); // gone — parent teardown removed it
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('PermissionBroker — grantScope', () => {
  /** ask() + the id it emitted, so each case reads as one call. */
  const askOnce = (broker: PermissionBroker) => {
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const p = broker.ask({ sessionId: 's', toolName: 'Bash', toolInput: { command: 'npm run build' }, denyListed: false });
    return { p, id: emitted[0].payload._requestId as string };
  };

  it('passes a valid selector through', async () => {
    const broker = new PermissionBroker();
    const { p, id } = askOnce(broker);
    broker.respond(id, { decision: { behavior: 'allow' }, updatedPermissions: ['x'], grantScope: 'wide' });
    await expect(p).resolves.toMatchObject({ behavior: 'allow', always: true, grantScope: 'wide' });
  });

  it('fails NARROW on anything that is not the literal "wide"', async () => {
    // This value is persisted, so it is validated here AND re-derived at the
    // session. A renderer that could widen its own grant by sending junk would
    // be writing the top precedence layer.
    for (const bad of [undefined, 'WIDE', 'tool-wide', 42, { scope: 'wide' }, null]) {
      const broker = new PermissionBroker();
      const { p, id } = askOnce(broker);
      broker.respond(id, { decision: { behavior: 'allow' }, updatedPermissions: ['x'], grantScope: bad });
      await expect(p).resolves.toMatchObject({ grantScope: 'exact' });
    }
  });
});
