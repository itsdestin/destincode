// Task 6 — the Task tool's own gating: unknown specialist / trivial prompt /
// at-capacity / writer-busy typed refusals. Drives execute() directly against
// a fake ToolContext, mirroring harness-tools-core.test.ts's makeCtx pattern —
// the actual spawn (Task 7's runSpecialist) is stubbed per-test via the fake
// ToolServices.specialists.spawn, since none of these tests are meant to
// reach it (each refuses before ever calling spawn).
import { describe, it, expect, vi } from 'vitest';
import { createTaskTool } from '../src/main/harness/tools/task';
import { HOSTED_MAX_CONCURRENT_SPECIALISTS } from '../src/main/harness/specialists/limits';
import type { ToolContext } from '../src/main/harness/tools/types';

interface RunOpts {
  slotFree?: boolean;
  writerBusy?: boolean;
  spawn?: ReturnType<typeof vi.fn>;
}

function runTaskTool(args: Record<string, unknown>, opts: RunOpts = {}) {
  const tool = createTaskTool();
  const spawn = opts.spawn ?? vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
  const ctx: ToolContext = {
    sessionId: 'parent-1',
    cwd: '/work',
    signal: new AbortController().signal,
    readRegistry: new Map(),
    todos: [],
    services: {
      specialists: {
        tryReserveSlot: () => opts.slotFree !== false,
        releaseSlot: () => {},
        isWriterBusy: () => !!opts.writerBusy,
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
    expect(r.text).toMatch(new RegExp(`at capacity \\(max ${HOSTED_MAX_CONCURRENT_SPECIALISTS}\\)`, 'i'));
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

  it('happy path: resolves, reserves a slot, spawns, releases the slot, and returns the report', async () => {
    const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'the report' }));
    const r = await runTaskTool({ agent: 'worker', prompt: 'a'.repeat(60), work_dir: 'src' }, { spawn });
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe('the report');
    expect(spawn).toHaveBeenCalledWith('parent-1', expect.objectContaining({
      workDir: 'src',
      specialist: expect.objectContaining({ id: 'worker' }),
    }));
  });

  it('a thrown spawn error resolves an isError result naming what happened — never a dangling call', async () => {
    const spawn = vi.fn(async () => { throw new Error('specialist child-9 was created but Task 7 is not implemented yet'); });
    const r = await runTaskTool({ agent: 'explorer' }, { spawn });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/child-9/);
  });

  it('releases the reserved slot even when spawn throws', async () => {
    const release = vi.fn();
    const tool = createTaskTool();
    const ctx: ToolContext = {
      sessionId: 'parent-1',
      cwd: '/work',
      signal: new AbortController().signal,
      readRegistry: new Map(),
      todos: [],
      services: {
        specialists: {
          tryReserveSlot: () => true,
          releaseSlot: release,
          isWriterBusy: () => false,
          spawn: async () => { throw new Error('boom'); },
        },
      },
    };
    await tool.execute({ description: 'x', prompt: 'a'.repeat(50), agent: 'explorer', work_dir: '.' } as any, ctx);
    expect(release).toHaveBeenCalledWith('parent-1');
  });
});
