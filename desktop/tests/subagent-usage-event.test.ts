// A specialist's spend belongs to the session that delegated it (spec §2). It
// cannot ride the child's own turn-complete: SUBAGENT_DISPLAY_TYPES excludes
// that deliberately, because a stamped copy would end the PARENT's turn in the
// reducer and attribute the child's model to the parent.
//
// Two halves are pinned here:
//   (1) the REDUCER half — a `subagent-usage` action folds one finished
//       specialist into the parent's totals exactly ONCE, mints nothing for a
//       session this window doesn't hold, and touches neither the timeline nor
//       the turn;
//   (2) the PRODUCER half — a real (scripted) specialist run through the real
//       NativeSessionHost emits exactly one such event on the PARENT's stream,
//       priced at the CHILD's own model, and persists it to the PARENT's
//       record so a resume replays it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { SUBAGENT_DISPLAY_TYPES, NativeSessionHost } from '../src/main/harness/native-session-host';
import { chatReducer } from '../src/renderer/state/chat-reducer';
import type { ChatState } from '../src/renderer/state/chat-types';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { scriptedModel, stream, textChunks, toolCallChunk, finishChunk } from './helpers/scripted-model';
import { resolveSpecialist } from '../src/main/harness/specialists/registry';

const SID = 'p1';
const start = (): ChatState => chatReducer(new Map(), { type: 'SESSION_INIT', sessionId: SID });

const subagentUsage = (uuid: string, usage: any) => ({
  type: 'TRANSCRIPT_SUBAGENT_USAGE' as const,
  sessionId: SID, uuid, timestamp: 1,
  parentAgentToolUseId: 'task-1', agentId: 'child-1',
  usage,
});

describe('subagent-usage — the reducer half', () => {
  it('is not smuggled in as a forwarded child turn-complete', () => {
    expect(SUBAGENT_DISPLAY_TYPES.has('turn-complete')).toBe(false);
  });

  it('folds a finished specialist into the parent session totals', () => {
    let s = start();
    s = chatReducer(s, subagentUsage('su1', {
      inputTokens: 5000, outputTokens: 400, cacheReadTokens: 100, cacheCreationTokens: 0, costUsd: 0.05, free: false,
    }) as any);
    const t = s.get(SID)!.totals;
    expect(t.inputTokens).toBe(5000);
    expect(t.outputTokens).toBe(400);
    expect(t.cacheReadTokens).toBe(100);
    expect(t.costUsd).toBeCloseTo(0.05, 10);
    expect(t.specialistCostUsd).toBeCloseTo(0.05, 10);
    expect(t.specialistRuns).toBe(1);
    expect(t.anyPriced).toBe(true);
  });

  it('marks the session unpriced when the specialist model has no published price', () => {
    let s = start();
    s = chatReducer(s, subagentUsage('su2', {
      inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null, free: false,
    }) as any);
    expect(s.get(SID)!.totals.anyUnpriced).toBe(true);
    expect(s.get(SID)!.totals.costUsd).toBe(0);
  });

  it('marks the session free when the specialist ran on a local engine', () => {
    // The addition beyond the plan: `free` is resolved for the SPECIALIST's own
    // model, so a metered parent that delegates to a local specialist still
    // reports that some of its work cost nothing to run.
    let s = start();
    s = chatReducer(s, subagentUsage('su3', {
      inputTokens: 900, outputTokens: 90, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: null, free: true,
    }) as any);
    const t = s.get(SID)!.totals;
    expect(t.anyFree).toBe(true);
    expect(t.anyPriced).toBe(false);     // free is never a $0.00 bill
    expect(t.costUsd).toBe(0);
    expect(t.specialistRuns).toBe(1);
    // Free is NOT a spelling of "no published price". The emitted shape here is
    // exactly the one a free PARENT turn carries (costUsd: null AND free: true —
    // costForUsage returns null for a free model), so the specialist path and
    // the turn path must reach the same verdict.
    expect(t.anyUnpriced).toBe(false);
  });

  it('counts one specialist exactly once, even on a duplicate delivery (replay overlapping live)', () => {
    let s = start();
    const ev = subagentUsage('su4', {
      inputTokens: 5000, outputTokens: 400, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.05, free: false,
    });
    s = chatReducer(s, ev as any);
    s = chatReducer(s, ev as any);   // the same event again — resume replays what live already delivered
    const t = s.get(SID)!.totals;
    expect(t.inputTokens).toBe(5000);
    expect(t.costUsd).toBeCloseTo(0.05, 10);
    expect(t.specialistRuns).toBe(1);
  });

  it('an ORPHAN report — for a session this window does not hold — changes nothing and mints nothing', () => {
    const s = start();
    const after = chatReducer(s, {
      ...subagentUsage('su5', { inputTokens: 999999, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 9.99, free: false }),
      sessionId: 'a-session-this-window-never-had',
    } as any);
    expect(after).toBe(s);                              // same object — no snapshot churn
    expect(after.has('a-session-this-window-never-had')).toBe(false);
    expect(after.get(SID)!.totals.inputTokens).toBe(0);
  });

  it('is bookkeeping, not conversation: no timeline entry, and the parent turn stays open', () => {
    let s = start();
    s = chatReducer(s, {
      type: 'TRANSCRIPT_ASSISTANT_TEXT', sessionId: SID, uuid: 'a1', timestamp: 1, text: 'working on it',
    } as any);
    const before = s.get(SID)!;
    expect(before.currentTurnId).not.toBeNull();
    s = chatReducer(s, subagentUsage('su6', {
      inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0.01, free: false,
    }) as any);
    const after = s.get(SID)!;
    expect(after.timeline).toEqual(before.timeline);          // nothing added to the chat
    expect(after.currentTurnId).toBe(before.currentTurnId);   // the turn did NOT end
    expect(after.assistantTurns).toBe(before.assistantTurns);
    expect(after.totals.inputTokens).toBe(100);
  });

  it('is ignored by model-history rebuild — it is bookkeeping, not conversation', async () => {
    const { rebuildHistory } = await import('../src/main/harness/history-rebuild');
    const before = rebuildHistory([]);
    const after = rebuildHistory([{
      type: 'subagent-usage', sessionId: SID, uuid: 'x', timestamp: 1,
      data: { usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0 } },
    } as any]);
    expect(after).toEqual(before);
  });
});

// ---- the PRODUCER half: a real specialist run through the real host ---------
const EXPLORER = resolveSpecialist('explorer')!;

describe('subagent-usage — the producer half', () => {
  let root: string;
  let store: SessionStore;
  let host: NativeSessionHost;

  // The parent runs on 'm' (NO published price); the specialist is delegated to
  // a DIFFERENT model that does have one. That asymmetry is the whole test: if
  // the run were priced with the parent's binding the cost would come back
  // null, so a number here can only have come from the child's own rate.
  const PRICES: Record<string, any> = {
    'm': null,
    'child-model': { in: 3, out: 15 },
    'free-model': { in: 0, out: 0 },
  };

  function boot(scripts: any[][]) {
    const model = scriptedModel(scripts);
    store = new SessionStore(new NativeHome(root));
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }),
      async () => null, async () => null,
      async (binding) => PRICES[binding.modelId] ?? null,
    );
    return model;
  }

  // Two tool steps then a report — one turn, three steps, so run.usage is a
  // real SUM across steps rather than a single step's numbers.
  const RUN = [
    stream(toolCallChunk('c1', 'Glob', { pattern: '*.ts' }), finishChunk('tool-calls', 1000, 100)),
    stream(toolCallChunk('c2', 'Glob', { pattern: '*.md' }), finishChunk('tool-calls', 2000, 200)),
    stream(...textChunks('t', 'REPORT: found it'), finishChunk('stop', 3000, 300)),
  ];

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-subusage-')); });
  afterEach(async () => { await host?.destroyAll(); fs.rmSync(root, { recursive: true, force: true }); });

  async function runOne(childModelId: string) {
    boot(RUN);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const seen: any[] = [];
    host.on('transcript-event', (e) => seen.push(e));
    const { childId } = await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader', workDir: root, parentToolCallId: 'tc-1',
      binding: { providerId: 'openrouter', modelId: childModelId },
      token: { parentId: 'root-1', writer: false }, description: 'find it',
    } as any);
    await host.drain('root-1');
    return { seen, childId };
  }

  it('reports the finished specialist\'s summed spend to the PARENT, exactly once, priced at the CHILD\'s model', async () => {
    const { seen, childId } = await runOne('child-model');
    const reports = seen.filter((e) => e.type === 'subagent-usage');
    expect(reports).toHaveLength(1);
    const ev = reports[0];
    expect(ev.sessionId).toBe('root-1');            // the PARENT's stream
    expect(ev.data.agentId).toBe(childId);
    expect(ev.data.parentAgentToolUseId).toBe('tc-1');
    expect(ev.data.model).toBe('child-model');
    // Summed across the run's three steps (1000+2000+3000 / 100+200+300).
    expect(ev.data.usage.inputTokens).toBe(6000);
    expect(ev.data.usage.outputTokens).toBe(600);
    // (6000/1e6)*3 + (600/1e6)*15 = 0.018 + 0.009
    expect(ev.data.usage.costUsd).toBeCloseTo(0.027, 10);
    expect(ev.data.usage.free).toBe(false);
    // The child's own turn-complete is NEVER re-emitted under the parent's id —
    // that is what would double-count this exact spend.
    expect(seen.filter((e) => e.type === 'turn-complete')).toEqual([]);
  });

  it('says the specialist was FREE when it ran on a model that costs nothing', async () => {
    const { seen } = await runOne('free-model');
    const ev = seen.find((e) => e.type === 'subagent-usage');
    expect(ev.data.usage.free).toBe(true);
    expect(ev.data.usage.costUsd).toBeNull();   // free is never a $0.00 bill
  });

  it('persists the report on the PARENT\'s record, so a resume replays it', async () => {
    const { childId } = await runOne('child-model');
    const parentEvents = store.readEvents('root-1', root).filter((e) => e.type === 'subagent-usage');
    expect(parentEvents).toHaveLength(1);
    expect(parentEvents[0].data.usage?.inputTokens).toBe(6000);
    expect(parentEvents[0].data.usage?.costUsd).toBeCloseTo(0.027, 10);
    expect(parentEvents[0].data.agentId).toBe(childId);
    // And it comes back out of getHistory() — the exact list the replay handler
    // streams to a resuming window.
    expect(host.getHistory('root-1')!.filter((e) => e.type === 'subagent-usage')).toHaveLength(1);
  });
});
