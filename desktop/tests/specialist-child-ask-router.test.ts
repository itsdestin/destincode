// Child ask routing (plan 1b, Task 8). Replaces child-ask-policy.ts's
// deny-everything stub: a child's ask now rides the SAME broker a root
// session's ask does, re-registered under the PARENT's sessionId so the
// existing permission card renders it (with the specialist labelled) — the
// child has no window of its own to raise a card under.
//
// Scope of THIS file: the router + broker contract only (no HarnessSession,
// no NativeSessionHost). The "child still running" vs "child already ended"
// branch of a late answer is HOST state (this.live), not something the
// router or the broker can know — those two cases are pinned instead in
// native-session-host.test.ts, against the real host.
import { describe, it, expect, vi } from 'vitest';
import { childAskRouter, ASK_REDIRECT_MESSAGE } from '../src/main/harness/specialists/child-ask-router';
import { PermissionBroker } from '../src/main/harness/permission-broker';
import { SPECIALIST_ASK_HOLD_MS } from '../src/main/harness/specialists/limits';

function firstPayload(emitted: any[]) {
  return emitted[0].payload;
}

describe('childAskRouter', () => {
  it('a routed ask reaches the broker under the PARENT sessionId with the specialist payload', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const router = childAskRouter({ broker, parentId: 'parent-1', childId: 'child-1', agentType: 'worker', title: 'Wanda the Worker' });
    const p = router({ sessionId: 'child-1', toolName: 'Bash', toolInput: { command: 'rm -rf /' }, denyListed: true });
    expect(emitted[0].sessionId).toBe('parent-1');
    expect(firstPayload(emitted).tool_name).toBe('Bash');
    expect(firstPayload(emitted).specialist).toEqual({ childId: 'child-1', agentType: 'worker', title: 'Wanda the Worker' });
    const requestId = firstPayload(emitted)._requestId as string;
    expect(broker.respond(requestId, { behavior: 'allow' })).toBe(true);
    await expect(p).resolves.toMatchObject({ behavior: 'allow' });
  });

  it('after SPECIALIST_ASK_HOLD_MS the child receives the redirect deny and the entry stays answerable', async () => {
    vi.useFakeTimers();
    try {
      const broker = new PermissionBroker();
      const emitted: any[] = [];
      broker.on('hook-event', (e) => emitted.push(e));
      const router = childAskRouter({ broker, parentId: 'parent-1', childId: 'child-1', agentType: 'worker', title: 'W' });
      const p = router({ sessionId: 'child-1', toolName: 'Bash', toolInput: {}, denyListed: true });
      await vi.advanceTimersByTimeAsync(SPECIALIST_ASK_HOLD_MS);
      const d = await p;
      expect(d.behavior).toBe('deny');
      expect(d.message).toBe(ASK_REDIRECT_MESSAGE);
      // Stays answerable: the id is still known to the broker after the timeout fired.
      const requestId = firstPayload(emitted)._requestId as string;
      expect(broker.respond(requestId, { behavior: 'allow' })).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the redirect wording contains both load-bearing clauses', () => {
    expect(ASK_REDIRECT_MESSAGE).toMatch(/Do NOT attempt the blocked action by any other means/);
    expect(ASK_REDIRECT_MESSAGE).toMatch(/Do NOT build further work on the assumption/);
  });

  it('a real user deny inside the window carries no redirect — the plain declined copy stands', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const router = childAskRouter({ broker, parentId: 'parent-1', childId: 'child-1', agentType: 'worker', title: 'W' });
    const p = router({ sessionId: 'child-1', toolName: 'Bash', toolInput: {}, denyListed: true });
    const requestId = firstPayload(emitted)._requestId as string;
    broker.respond(requestId, { behavior: 'deny' });
    const d = await p;
    expect(d.behavior).toBe('deny');
    expect(d.message).toBeUndefined(); // harness-session.ts falls back to the plain "user declined" copy
  });

  it('interactive asks still deny instantly with factual copy', async () => {
    const broker = new PermissionBroker();
    const emitted: any[] = [];
    broker.on('hook-event', (e) => emitted.push(e));
    const router = childAskRouter({ broker, parentId: 'parent-1', childId: 'child-1', agentType: 'worker', title: 'W' });
    const d = await router({ sessionId: 'child-1', toolName: 'AskUserQuestion', toolInput: { questions: [] }, denyListed: false });
    expect(d.behavior).toBe('deny');
    expect(d.message).toMatch(/AskUserQuestion/);
    expect(d.message).not.toMatch(/user declined/i); // never blame a user who was never asked
    expect(emitted).toEqual([]); // never reaches the broker/card at all

    const d2 = await router({ sessionId: 'child-1', toolName: 'Read', toolInput: { file_path: '/outside' }, denyListed: false, external: true });
    expect(d2.behavior).toBe('deny');
    expect(d2.message).toMatch(/work directory/i);
    expect(d2.message).not.toMatch(/user declined/i);
    expect(emitted).toEqual([]);
  });
});
