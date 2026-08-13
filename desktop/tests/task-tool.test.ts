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
// Task 6 — the "belongs to a DIFFERENT parent" refusal is only a REAL test
// against the real host: a fake that always answers 'not-yours' would prove
// nothing about own-children-only actually holding. NativeSessionHost/
// SessionStore drive that one test; every other Task 6 test below stays on
// fakes, same as the rest of this file.
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { SessionStore } from '../src/main/harness/session-store';
import { resolveSpecialist as resolveRealSpecialist } from '../src/main/harness/specialists/registry';

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

    // Task 11 (ROADMAP fold-in): '.', './x', and the absolute form of the SAME
    // directory used to mint THREE different remembered-rule keys — approving
    // one left the other two spellings still asking every time. permissionSubject
    // has no session cwd to resolve a relative work_dir against (the NativeTool
    // contract passes only the raw args), so it normalizes against the process's
    // own cwd — the same base a bare path.resolve(p) would use.
    it('canonicalizes work_dir so "." and process.cwd() mint the SAME consent key', () => {
      const tool = createTaskTool();
      expect(tool.permissionSubject({ agent: 'wizard', work_dir: '.', description: 'd', prompt: 'p' } as any))
        .toBe(tool.permissionSubject({ agent: 'wizard', work_dir: process.cwd(), description: 'd', prompt: 'p' } as any));
    });

    it('canonicalizes work_dir for a resolved-agent (charter-prefixed) subject too', () => {
      const tool = createTaskTool();
      expect(tool.permissionSubject({ agent: 'explorer', work_dir: '.', description: 'd', prompt: 'p' } as any))
        .toBe(tool.permissionSubject({ agent: 'explorer', work_dir: process.cwd(), description: 'd', prompt: 'p' } as any));
    });

    // Fix pass, Finding 1: the consent key doubles as DISPLAY TEXT — describe-
    // rule.ts slices this exact string into what the permissions screen
    // renders. The old implementation reused guards.ts's `canonicalize()`,
    // which case-folds the WHOLE path on win32 (right for the sensitive-path
    // comparison sets it was built for, wrong for anything a user reads back
    // — see that function's own doc comment). Forced via a platform stub
    // since canonicalize's lowercasing branch only engages when
    // `process.platform === 'win32'`, which this test suite normally isn't.
    it('preserves the real casing of work_dir even on win32 (Fix 1 — the key doubles as display text)', () => {
      const realPlatform = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        const tool = createTaskTool();
        const subject = tool.permissionSubject({ agent: 'wizard', work_dir: '/Proj/MixedCase', description: 'd', prompt: 'p' } as any);
        expect(subject).toContain('MixedCase');
        expect(subject).not.toBe(subject.toLowerCase());
      } finally {
        Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
      }
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

// ---------------------------------------------------------------------------
// Task 6 — the task_id management surface: steer a running child, resume a
// finished/interrupted one, or interrupt one, all through the SAME Task tool
// (task_id + interrupt, no new agent/work_dir/description/prompt needed).
// Fakes throughout except the "different parent" test, which needs the REAL
// host to prove own-children-only actually holds rather than assuming a fake
// that always answers 'not-yours' is trustworthy.
// ---------------------------------------------------------------------------
describe('Task tool — task_id management surface (Task 6)', () => {
  function manageCtx(overrides: Partial<{
    steerSpecialist: any; interruptSpecialist: any; resumeSpecialist: any; reserve: any; release: any;
  }> = {}): ToolContext {
    return {
      sessionId: 'parent-1',
      cwd: '/work',
      signal: new AbortController().signal,
      readRegistry: new Map(),
      todos: [],
      toolCallId: 'tc-manage',
      services: {
        specialists: {
          reserve: overrides.reserve ?? vi.fn(() => ({ ok: true, token: { parentId: 'parent-1', writer: false } })),
          release: overrides.release ?? vi.fn(),
          trySpendSpawnBudget: () => true,
          spawn: vi.fn(),
          spawnBackground: vi.fn(),
          steerSpecialist: overrides.steerSpecialist ?? vi.fn(() => ({ status: 'not-yours' })),
          interruptSpecialist: overrides.interruptSpecialist ?? vi.fn(() => ({ status: 'not-yours' })),
          resumeSpecialist: overrides.resumeSpecialist ?? vi.fn(async () => ({ status: 'not-yours' })),
        },
      },
    };
  }

  it('steers a RUNNING child and reports delivery, naming who received it', async () => {
    const tool = createTaskTool();
    const steerSpecialist = vi.fn(() => ({ status: 'ok', title: 'Rusty the Explorer' }));
    const r = await tool.execute(
      { task_id: 'child-1', prompt: 'focus on auth.ts instead' } as any,
      manageCtx({ steerSpecialist }),
    );
    expect(steerSpecialist).toHaveBeenCalledWith('parent-1', 'child-1', 'focus on auth.ts instead');
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe('Steer delivered to Rusty the Explorer.');
  });

  it('resumes a FINISHED child in the foreground — the resumed run\'s report IS the tool result', async () => {
    const tool = createTaskTool();
    const steerSpecialist = vi.fn(() => ({ status: 'not-running', agentType: 'explorer' }));
    const reserve = vi.fn(() => ({ ok: true, token: { parentId: 'parent-1', writer: false } }));
    const release = vi.fn();
    const resumeSpecialist = vi.fn(async () => ({ status: 'ok', childId: 'child-1', report: 'the resumed report' }));
    const r = await tool.execute(
      { task_id: 'child-1', prompt: 'continue from where you left off' } as any,
      manageCtx({ steerSpecialist, reserve, release, resumeSpecialist }),
    );
    // explorer is read-only (specialists/builtins.ts) — the reservation must
    // size its writer flag from the specialist steerSpecialist named, not a
    // default.
    expect(reserve).toHaveBeenCalledWith('parent-1', { writer: false });
    expect(resumeSpecialist).toHaveBeenCalledWith('parent-1', expect.objectContaining({
      childId: 'child-1', prompt: 'continue from where you left off', background: false,
    }));
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe('the resumed report');
    expect(release).toHaveBeenCalled(); // foreground: this call site releases once the run settles
  });

  it('resumes an INTERRUPTED child in the background — the launch ack names the task_id, and the reservation is NOT released here', async () => {
    const tool = createTaskTool();
    const steerSpecialist = vi.fn(() => ({ status: 'not-running', agentType: 'worker' })); // worker is read-write
    const reserve = vi.fn(() => ({ ok: true, token: { parentId: 'parent-1', writer: true } }));
    const release = vi.fn();
    const resumeSpecialist = vi.fn(async () => ({ status: 'ok-background', childId: 'child-1', title: 'Wren the Worker' }));
    const r = await tool.execute(
      { task_id: 'child-1', prompt: 'pick up the refactor', background: true } as any,
      manageCtx({ steerSpecialist, reserve, release, resumeSpecialist }),
    );
    expect(reserve).toHaveBeenCalledWith('parent-1', { writer: true }); // worker is read-write
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/Wren the Worker \(worker\) is now working in the background/);
    expect(r.text).toMatch(/task_id: child-1/);
    expect(release).not.toHaveBeenCalled(); // ownership transferred to the detached chain, same as a fresh background spawn
  });

  it('interrupt: true cancels a RUNNING child with a typed result naming what it was doing', async () => {
    const tool = createTaskTool();
    const interruptSpecialist = vi.fn(() => ({ status: 'ok', title: 'Rusty the Explorer', description: 'Find the auth bug' }));
    const r = await tool.execute({ task_id: 'child-1', interrupt: true } as any, manageCtx({ interruptSpecialist }));
    expect(interruptSpecialist).toHaveBeenCalledWith('parent-1', 'child-1');
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe('Interrupted Rusty the Explorer — it was: Find the auth bug.');
  });

  it('interrupt: true on a child that already finished says there is nothing to interrupt', async () => {
    const tool = createTaskTool();
    const interruptSpecialist = vi.fn(() => ({ status: 'not-running', agentType: 'explorer' }));
    const r = await tool.execute({ task_id: 'child-1', interrupt: true } as any, manageCtx({ interruptSpecialist }));
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/is not currently running/);
    expect(r.text).toMatch(/nothing to interrupt/);
  });

  it('refuses a task_id that never existed', async () => {
    const tool = createTaskTool();
    const steerSpecialist = vi.fn(() => ({ status: 'not-yours' }));
    const r = await tool.execute({ task_id: 'ghost-child', prompt: 'hello' } as any, manageCtx({ steerSpecialist }));
    expect(r.isError).toBe(true);
    expect(r.text).toBe('Refused: that task_id does not belong to a specialist of this session.');
  });

  // The only test in this describe block against the REAL host: proves a
  // task_id belonging to a DIFFERENT parent is refused the SAME way as one
  // that never existed at all (spec §5 own-children-only) — a fake that
  // always answers 'not-yours' would only prove task.ts's OWN wiring, not
  // that the host actually enforces the boundary.
  it('refuses a task_id belonging to a DIFFERENT parent, identically to a nonexistent one', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'task-tool-manage-'));
    const home = new NativeHome(root);
    const store = new SessionStore(home);
    // The model factory is never called: createChild only constructs and
    // wires the child session, it never dispatches a turn.
    const neverCalledFactory = async () => { throw new Error('model factory should never be called in this test — no turn ever runs'); };
    const host = new NativeSessionHost(
      store, neverCalledFactory, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    try {
      await host.create({ sessionId: 'parent-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      await host.create({ sessionId: 'parent-2', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
      const EXPLORER = resolveRealSpecialist('explorer')!;
      const { childId } = await host.createChild('parent-1', {
        specialist: EXPLORER, prompt: 'find the bug', workDir: root, parentToolCallId: 'tc-1',
      });

      const tool = createTaskTool();
      const ctxFor = (parentId: string): ToolContext => ({
        sessionId: parentId, cwd: root, signal: new AbortController().signal, readRegistry: new Map(), todos: [],
        services: {
          specialists: {
            reserve: (pid: string, opts: { writer: boolean }) => host.reserveSpecialist(pid, opts),
            release: (token: any) => host.releaseReservation(token),
            trySpendSpawnBudget: (pid: string) => host.trySpendSpecialistSpawnBudget(pid),
            spawn: (pid: string, opts: any) => host.spawnSpecialist(pid, opts),
            spawnBackground: (pid: string, opts: any) => host.spawnSpecialistBackground(pid, opts),
            steerSpecialist: (pid: string, cid: string, text: string) => host.steerSpecialist(pid, cid, text),
            interruptSpecialist: (pid: string, cid: string) => host.interruptSpecialist(pid, cid),
            resumeSpecialist: (pid: string, opts: any) => host.resumeSpecialist(pid, opts),
          },
        },
      });

      // parent-2 does not own this child — real cross-parent refusal.
      const foreign = await tool.execute({ task_id: childId, prompt: 'do something' } as any, ctxFor('parent-2'));
      // A task_id that never existed anywhere — same host, same parent-2.
      const nonexistent = await tool.execute({ task_id: 'totally-made-up-id', prompt: 'do something' } as any, ctxFor('parent-2'));

      expect(foreign.isError).toBe(true);
      expect(foreign.text).toBe('Refused: that task_id does not belong to a specialist of this session.');
      expect(nonexistent.isError).toBe(true);
      expect(nonexistent.text).toBe(foreign.text); // indistinguishable — own-children-only can't be probed

      // And parent-1 — the REAL owner — can manage it normally.
      const owned = await tool.execute({ task_id: childId, interrupt: true } as any, ctxFor('parent-1'));
      expect(owned.isError).toBeFalsy();
      expect(owned.text).toMatch(/^Interrupted/);
    } finally {
      await host.destroyAll();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
