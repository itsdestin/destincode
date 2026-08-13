// Task 6 — the Task tool's own gating: unknown specialist / trivial prompt /
// at-capacity / writer-busy typed refusals. Drives execute() directly against
// a fake ToolContext, mirroring harness-tools-core.test.ts's makeCtx pattern —
// the actual spawn (Task 7's runSpecialist) is stubbed per-test via the fake
// ToolServices.specialists.spawn, since none of these tests are meant to
// reach it (each refuses before ever calling spawn).
//
// Task 1 (plan 1b): the fake reserve()/release() below stand in for the host's
// real reserveSpecialist()/releaseReservation() (native-session-host.ts) — the
// pair that folds the slot AND writer-busy checks into one synchronous
// reserve-or-refuse step. These fakes intentionally do NOT re-implement that
// atomicity (there is nothing to race against in a single synchronous test
// call); they only need to hand execute() the same shaped answers the real
// host would, so task.ts's reason-mapping and release-in-finally logic is what
// gets exercised.
import { describe, it, expect, vi } from 'vitest';
import { createTaskTool } from '../src/main/harness/tools/task';
import type { ToolContext } from '../src/main/harness/tools/types';

interface RunOpts {
  slotFree?: boolean;
  writerBusy?: boolean;
  spawn?: ReturnType<typeof vi.fn>;
  release?: ReturnType<typeof vi.fn>;
}

function runTaskTool(args: Record<string, unknown>, opts: RunOpts = {}) {
  const tool = createTaskTool();
  const spawn = opts.spawn ?? vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
  const release = opts.release ?? vi.fn();
  const ctx: ToolContext = {
    sessionId: 'parent-1',
    cwd: '/work',
    signal: new AbortController().signal,
    readRegistry: new Map(),
    todos: [],
    services: {
      specialists: {
        reserve: (parentId: string, reserveOpts: { writer: boolean }) => {
          if (reserveOpts.writer && opts.writerBusy) return { ok: false, reason: 'writer-busy' } as const;
          if (opts.slotFree === false) return { ok: false, reason: 'at-capacity' } as const;
          return { ok: true, token: { parentId, writer: reserveOpts.writer } } as const;
        },
        release,
        spawn,
      },
    },
  };
  return tool.execute(
    { description: 'test task', prompt: 'a'.repeat(50), work_dir: '.', ...args } as any,
    ctx,
  );
}

describe('Task tool — typed refusals (plan 1a)', () => {
  it('refuses an unknown specialist with the available list', async () => {
    const r = await runTaskTool({ agent: 'wizard' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/unknown specialist/i);
    expect(r.text).toMatch(/explorer/);   // names what IS available
  });

  it('refuses a trivial or placeholder prompt with a typed error', async () => {
    const r = await runTaskTool({ agent: 'explorer', prompt: 'do the thing' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/self-contained brief/i);   // minimal weak-model hardening; full pass is plan 1b
  });

  it('returns a typed at-capacity result when this parent has no slot free', async () => {
    const r = await runTaskTool({ agent: 'explorer' }, { slotFree: false });
    expect(r.isError).toBe(true);
    // Relaxed to not require the paren to close right after the digits — the
    // copy fix moved "concurrent specialists" inside the parenthetical
    // ("at capacity (max N concurrent specialists)"), and this regex should
    // survive that phrasing rather than pin the exact punctuation.
    expect(r.text).toMatch(/at capacity \(max \d+/i);
    expect(r.text).toMatch(/wait/i);      // tells the model what it CAN do
  });

  it('returns a typed writer-busy result for a second concurrent write-capable specialist under the same parent', async () => {
    const r = await runTaskTool({ agent: 'worker' }, { writerBusy: true });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/another specialist with write access is running/i);
  });

  it('a read-only specialist is unaffected by writer-busy', async () => {
    const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
    const r = await runTaskTool({ agent: 'explorer' }, { writerBusy: true, spawn });
    expect(r.isError).toBeFalsy();
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('happy path: resolves, reserves a slot, spawns, releases the reservation, and returns the report', async () => {
    const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'the report' }));
    const r = await runTaskTool({ agent: 'worker', prompt: 'a'.repeat(60), work_dir: 'src' }, { spawn });
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe('the report');
    expect(spawn).toHaveBeenCalledWith('parent-1', expect.objectContaining({
      workDir: 'src',
      specialist: expect.objectContaining({ id: 'worker' }),
      token: expect.objectContaining({ parentId: 'parent-1', writer: true }),
    }));
  });

  it('a thrown spawn error resolves an isError result naming what happened — never a dangling call', async () => {
    const spawn = vi.fn(async () => { throw new Error('specialist child-9 was created but Task 7 is not implemented yet'); });
    const r = await runTaskTool({ agent: 'explorer' }, { spawn });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/child-9/);
  });

  // ---- Task 6 review fix 4: the consent key is CHARTER-SCOPED, not a bare
  // work_dir. Before this fix `permissionSubject` returned only `a.work_dir`,
  // so a remembered "Always allow" for a read-only explorer at a path silently
  // pre-approved a future read-write worker at the SAME path — the charter is
  // the unit of envelope consent (spec §5). ----
  describe('permissionSubject — charter-scoped consent key (Fix 4)', () => {
    it('prefixes the subject with the resolved specialist\'s charter', () => {
      const tool = createTaskTool();
      // explorer is read-only (specialists/builtins.ts); worker is read-write.
      expect(tool.permissionSubject({ agent: 'explorer', work_dir: '/proj', description: 'd', prompt: 'p' } as any))
        .toBe('read-only:/proj');
      expect(tool.permissionSubject({ agent: 'worker', work_dir: '/proj', description: 'd', prompt: 'p' } as any))
        .toBe('read-write:/proj');
    });

    it('falls back to the bare work_dir for an unresolvable agent name', () => {
      // execute() above already refuses an unknown specialist before ever
      // spawning, so this text is only ever shown on an ask that's about to be
      // declined anyway — never a real standing grant.
      const tool = createTaskTool();
      expect(tool.permissionSubject({ agent: 'wizard', work_dir: '/proj', description: 'd', prompt: 'p' } as any))
        .toBe('/proj');
    });
  });

  it('releases the reservation even when spawn throws', async () => {
    const release = vi.fn();
    const tool = createTaskTool();
    const token = { parentId: 'parent-1', writer: false };
    const ctx: ToolContext = {
      sessionId: 'parent-1',
      cwd: '/work',
      signal: new AbortController().signal,
      readRegistry: new Map(),
      todos: [],
      services: {
        specialists: {
          reserve: () => ({ ok: true, token }),
          release,
          spawn: async () => { throw new Error('boom'); },
        },
      },
    };
    await tool.execute({ description: 'x', prompt: 'a'.repeat(50), agent: 'explorer', work_dir: '.' } as any, ctx);
    expect(release).toHaveBeenCalledWith(token);
  });
});
