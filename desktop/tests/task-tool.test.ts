// Task 6 — the Task tool's own gating: unknown specialist / trivial prompt /
// at-capacity / writer-busy typed refusals. Drives execute() directly against
// a fake ToolContext, mirroring harness-tools-core.test.ts's makeCtx pattern —
// the actual spawn (Task 7's runSpecialist) is stubbed per-test via the fake
// ToolServices.specialists.spawn, since none of these tests are meant to
// reach it (each refuses before ever calling spawn).
import { describe, it, expect, vi } from 'vitest';
import { createTaskTool } from '../src/main/harness/tools/task';
import type { ToolContext } from '../src/main/harness/tools/types';
import { SPECIALIST_SPAWN_BUDGET_PER_SESSION } from '../src/main/harness/specialists/limits';

interface RunOpts {
  slotFree?: boolean;
  writerBusy?: boolean;
  spawn?: ReturnType<typeof vi.fn>;
  // Task 12, item 3: the per-conversation spawn budget is a SEPARATE gate from
  // the concurrency slot above (tryReserveSlot) — default true (budget available)
  // so every existing test in this file, which never cares about the budget,
  // keeps passing unmodified.
  budgetOk?: boolean;
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
        trySpendSpawnBudget: () => opts.budgetOk !== false,
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

  // Task 12, item 2 — placeholder prompt rejection (spec §3). The regex only
  // matches the WHOLE trimmed prompt, so a bare "todo"/"tbd"/"fixme" is already
  // caught by the 40-char floor above — these cases specifically pin the ones
  // the floor MISSES: longer placeholder-shaped junk that clears 40 chars
  // while still being nothing but an unexpanded marker (never real content
  // padded around a real marker — that would legitimately not match, by design).
  describe('placeholder prompt rejection (Task 12, item 2)', () => {
    const PLACEHOLDER_PROMPTS = [
      '<placeholder text goes right here please>',      // <[^>]*>
      '{{TASK_DESCRIPTION_GOES_HERE_PLEASE_FILL}}',      // the exact padded example from the brief
      'x'.repeat(45),                                    // xxx+
      `task ${'1'.repeat(40)}`,                           // task ?\d*
    ];
    for (const prompt of PLACEHOLDER_PROMPTS) {
      it(`rejects ${JSON.stringify(prompt)}`, async () => {
        expect(prompt.length).toBeGreaterThanOrEqual(40);   // sanity: actually clears the floor
        const r = await runTaskTool({ agent: 'explorer', prompt });
        expect(r.isError).toBe(true);
        expect(r.text).toBe(
          'That prompt looks like an unexpanded placeholder. Write the actual self-contained brief: '
          + 'what to do, relevant paths, what "done" looks like.',
        );
      });
    }

    // The pinned false-positive boundary (external review 2026-08-12): a real,
    // self-contained ~45-char sentence must NOT be caught by the narrow regex.
    it('a real ~45-char sentence is NOT rejected as a placeholder', async () => {
      const realPrompt = 'Find every call site of parseConfig() in src/.';   // 46 chars
      expect(realPrompt.length).toBeGreaterThanOrEqual(45);
      const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
      const r = await runTaskTool({ agent: 'explorer', prompt: realPrompt }, { spawn });
      expect(r.isError).toBeFalsy();
      expect(spawn).toHaveBeenCalledTimes(1);
    });
  });

  // Task 12, item 3 — per-conversation spawn budget: a runaway-loop backstop
  // distinct from the concurrency slot (HOSTED_MAX_CONCURRENT_SPECIALISTS) —
  // this one is a LIFETIME cap per parent conversation, never released.
  it('refuses once the per-conversation spawn budget is exhausted, naming the budget', async () => {
    const r = await runTaskTool({ agent: 'explorer' }, { budgetOk: false });
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      `Refused: this conversation has reached its specialist budget (${SPECIALIST_SPAWN_BUDGET_PER_SESSION}). `
      + 'This is a runaway guard — the user can start a fresh conversation to continue delegating.',
    );
  });

  it('spawns normally when the budget still has room', async () => {
    const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
    const r = await runTaskTool({ agent: 'explorer' }, { budgetOk: true, spawn });
    expect(r.isError).toBeFalsy();
    expect(spawn).toHaveBeenCalledTimes(1);
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
          trySpendSpawnBudget: () => true,
          spawn: async () => { throw new Error('boom'); },
        },
      },
    };
    await tool.execute({ description: 'x', prompt: 'a'.repeat(50), agent: 'explorer', work_dir: '.' } as any, ctx);
    expect(release).toHaveBeenCalledWith('parent-1');
  });
});
