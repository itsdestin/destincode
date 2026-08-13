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
import { SPECIALIST_SPAWN_BUDGET_PER_SESSION, HOSTED_MAX_CONCURRENT_SPECIALISTS } from '../src/main/harness/specialists/limits';
import { DelegatedModels } from '../src/main/harness/specialists/delegated-models';
import { NativeHome } from '../src/main/native-home';
import type { CatalogModel, ModelBinding } from '../src/shared/provider-types';
import * as fs from 'fs'; import * as os from 'os'; import * as path from 'path';

interface RunOpts {
  slotFree?: boolean;
  writerBusy?: boolean;
  spawn?: ReturnType<typeof vi.fn>;
  release?: ReturnType<typeof vi.fn>;
  // Task 12, item 3: the per-conversation spawn budget is a SEPARATE gate from
  // the concurrency slot above (reserve) — default true (budget available)
  // so every existing test in this file, which never cares about the budget,
  // keeps passing unmodified.
  budgetOk?: boolean;
  // Task 14 — both undefined by default so every pre-Task-14 test in this
  // file (which never touches model resolution: no args.model, and every
  // built-in specialist's modelPreference is unset) keeps compiling and
  // passing with the exact same behavior as before this task: task.ts only
  // reaches for ctx.binding / ctx.services.models when a tier or specific id
  // was actually requested.
  binding?: ModelBinding;
  models?: { designated: DelegatedModels; catalog: () => Promise<CatalogModel[] | null> };
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
    ...(opts.binding ? { binding: opts.binding } : {}),
    services: {
      specialists: {
        reserve: (parentId: string, reserveOpts: { writer: boolean }) => {
          if (reserveOpts.writer && opts.writerBusy) return { ok: false, reason: 'writer-busy' } as const;
          // Task 13: the real reserveSpecialist() now carries the RESOLVED
          // ceiling on an at-capacity refusal (native-session-host.ts) —
          // this fake mirrors that shape so task.ts's copy-interpolation
          // (`reservation.max`) is what actually gets exercised here.
          if (opts.slotFree === false) return { ok: false, reason: 'at-capacity', max: HOSTED_MAX_CONCURRENT_SPECIALISTS } as const;
          return { ok: true, token: { parentId, writer: reserveOpts.writer } } as const;
        },
        release,
        trySpendSpawnBudget: () => opts.budgetOk !== false,
        spawn,
      },
      ...(opts.models ? { models: opts.models } : {}),
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

  // ---- Task 4: background: true dispatches through spawnBackground, not
  // spawn, and the reservation's release ownership moves off this call site
  // (the detached delivery chain releases it once the run settles) — the ONE
  // exception is a THROWN launch, where ownership never transferred anywhere.
  describe('background: true (Task 4)', () => {
    it('calls spawnBackground (not spawn) and returns the launch ack without releasing the reservation', async () => {
      const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
      const spawnBackground = vi.fn(async () => ({ childId: 'child-9', title: 'Rusty the Explorer' }));
      const release = vi.fn();
      const tool = createTaskTool();
      const token = { parentId: 'parent-1', writer: false };
      const ctx: ToolContext = {
        sessionId: 'parent-1', cwd: '/work', signal: new AbortController().signal,
        readRegistry: new Map(), todos: [],
        services: { specialists: { reserve: () => ({ ok: true, token }), release, spawn, spawnBackground, trySpendSpawnBudget: () => true } },
      };
      const r = await tool.execute(
        { description: 'find the bug', prompt: 'a'.repeat(60), agent: 'explorer', work_dir: '.', background: true } as any,
        ctx,
      );
      expect(spawn).not.toHaveBeenCalled();
      expect(spawnBackground).toHaveBeenCalledWith('parent-1', expect.objectContaining({
        description: 'find the bug', workDir: '.', token,
        specialist: expect.objectContaining({ id: 'explorer' }),
      }));
      expect(r.isError).toBeFalsy();
      expect(r.text).toMatch(/working in the background/);
      expect(r.text).toMatch(/task_id: child-9/);
      // Ownership transferred: this call site does NOT release on the
      // successful-launch path — the detached chain does, once it settles.
      expect(release).not.toHaveBeenCalled();
    });

    it('a thrown background launch still releases the reservation — ownership never transferred', async () => {
      const spawnBackground = vi.fn(async () => { throw new Error('createChild blew up'); });
      const release = vi.fn();
      const tool = createTaskTool();
      const token = { parentId: 'parent-1', writer: false };
      const ctx: ToolContext = {
        sessionId: 'parent-1', cwd: '/work', signal: new AbortController().signal,
        readRegistry: new Map(), todos: [],
        services: { specialists: { reserve: () => ({ ok: true, token }), release, spawn: vi.fn(), spawnBackground, trySpendSpawnBudget: () => true } },
      };
      const r = await tool.execute(
        { description: 'x', prompt: 'a'.repeat(60), agent: 'explorer', work_dir: '.', background: true } as any,
        ctx,
      );
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/createChild blew up/); // the real thrown reason, never a guess
      expect(release).toHaveBeenCalledWith(token);
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
          trySpendSpawnBudget: () => true,
          spawn: async () => { throw new Error('boom'); },
        },
      },
    };
    await tool.execute({ description: 'x', prompt: 'a'.repeat(50), agent: 'explorer', work_dir: '.' } as any, ctx);
    expect(release).toHaveBeenCalledWith(token);
  });
});

// ---------------------------------------------------------------------------
// Task 14 — the `model` input's resolution. Every test in this block sets
// opts.binding + opts.models explicitly; every test ABOVE this block
// deliberately does not, and stays green unmodified, because 'parent' (the
// default when no args.model and no specialist.modelPreference) never
// touches either.
// ---------------------------------------------------------------------------
describe('Task tool — model resolution (Task 14)', () => {
  const PARENT_BINDING: ModelBinding = { providerId: 'openrouter', modelId: 'parent-model' };

  async function designatedWith(entries: Partial<Record<'budget' | 'frontier', ModelBinding>>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-tool-designated-'));
    const home = new NativeHome(dir);
    const designated = new DelegatedModels(home);
    if (entries.budget) await designated.set('budget', entries.budget);
    if (entries.frontier) await designated.set('frontier', entries.frontier);
    return designated;
  }

  it('model: "budget" spawns using the designated binding', async () => {
    const budgetBinding: ModelBinding = { providerId: 'openrouter', modelId: 'cheap-model' };
    const designated = await designatedWith({ budget: budgetBinding });
    const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
    const r = await runTaskTool(
      { agent: 'explorer', model: 'budget' },
      { spawn, binding: PARENT_BINDING, models: { designated, catalog: async () => null } },
    );
    expect(r.isError).toBeFalsy();
    expect(spawn).toHaveBeenCalledWith('parent-1', expect.objectContaining({ binding: budgetBinding }));
    // No fallback note — the tier WAS configured.
    expect(r.text).toBe('done');
  });

  it('model: "frontier" with no tier configured falls back to the parent binding AND appends the honest note', async () => {
    const designated = await designatedWith({});
    const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
    const r = await runTaskTool(
      { agent: 'explorer', model: 'frontier' },
      { spawn, binding: PARENT_BINDING, models: { designated, catalog: async () => null } },
    );
    expect(r.isError).toBeFalsy();
    // Falls back to the PARENT's own binding — resolveDelegatedBinding
    // returns it explicitly (fellBack: true), so task.ts passes it through
    // like any other resolved binding; createChild would have landed on the
    // exact same value via its own opts.binding ?? parent.session.binding
    // default even without this.
    expect(spawn).toHaveBeenCalledWith('parent-1', expect.objectContaining({ binding: PARENT_BINDING }));
    expect(r.text).toBe('done\n\n(No frontier model is set in Settings — using this conversation\'s model.)');
  });

  it('a specific model id that IS in the live catalog resolves and spawns on it', async () => {
    const designated = await designatedWith({});
    const catalog: CatalogModel[] = [{ id: 'gpt-5', providerId: 'openai', label: 'GPT-5' }];
    const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
    const r = await runTaskTool(
      { agent: 'explorer', model: 'gpt-5' },
      { spawn, binding: PARENT_BINDING, models: { designated, catalog: async () => catalog } },
    );
    expect(r.isError).toBeFalsy();
    expect(spawn).toHaveBeenCalledWith('parent-1', expect.objectContaining({
      binding: { providerId: 'openai', modelId: 'gpt-5' },
    }));
    expect(r.text).toBe('done'); // no fallback note — this path never falls back
  });

  it('a specific model id NOT in the live catalog REFUSES the call — never spawns', async () => {
    const designated = await designatedWith({});
    const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
    const r = await runTaskTool(
      { agent: 'explorer', model: 'totally-made-up-model' },
      { spawn, binding: PARENT_BINDING, models: { designated, catalog: async () => [] } },
    );
    expect(r.isError).toBe(true);
    expect(r.text).toBe(
      'Refused: "totally-made-up-model" is not an available model. Use ModelSearch to find the exact id, or use "budget"/"frontier".',
    );
    expect(spawn).not.toHaveBeenCalled();
  });

  it('omitting model (and an unset specialist.modelPreference) never touches ctx.binding or ctx.services.models', async () => {
    // No `binding`, no `models` in opts — if task.ts reached for either when
    // it shouldn't, this would throw a "configuration error" result instead
    // of spawning normally, which is exactly what this test pins against.
    const spawn = vi.fn(async () => ({ childId: 'child-1', report: 'done' }));
    const r = await runTaskTool({ agent: 'explorer' }, { spawn });
    expect(r.isError).toBeFalsy();
    expect(spawn).toHaveBeenCalledWith('parent-1', expect.not.objectContaining({ binding: expect.anything() }));
  });
});
