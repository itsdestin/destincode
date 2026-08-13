import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { scriptedModel, stream, textChunks, multiDeltaTextChunks, toolCallChunk, finishChunk } from './helpers/scripted-model';
import { resolveSpecialist } from '../src/main/harness/specialists/registry';
import { SPECIALIST_IDLE_STALE_MS, SPECIALIST_IN_TOOL_STALE_MS } from '../src/main/harness/specialists/limits';

// ---- Task 7: the FOREGROUND specialist run ----------------------------------
// spawnSpecialist mints a child (Task 5), delivers the brief as its first turn,
// re-emits DISPLAY copies of its three subagent-visible event types under the
// PARENT's session id, and returns the child's last message as a
// headroom-capped report. These tests drive the whole path through the real
// host, a real SessionStore, and a real (scripted) HarnessSession.

const EXPLORER = resolveSpecialist('explorer')!;

// The three types the reducer's applySubagentEvent consumes (chat-reducer.ts).
// Anything else must NEVER be re-emitted stamped — see the "no stamped
// turn-complete" test below for what that would break.
const DISPLAY_TYPES = ['tool-use', 'tool-result', 'assistant-text'];

describe('specialist foreground run (Task 7)', () => {
  let root: string;
  let store: SessionStore;
  let host: NativeSessionHost;

  // ONE shared scripted model instance across every doStream call, so a script
  // spanning MORE THAN ONE TURN (the empty-report nudge) advances rather than
  // restarting — the factory is called once per turn, and a fresh instance per
  // call would replay script[0] forever.
  function boot(scripts: any[][]) {
    const model = scriptedModel(scripts);
    store = new SessionStore(new NativeHome(root));
    host = new NativeSessionHost(store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null);
    return model;
  }
  async function withParent(scripts: any[][]) {
    boot(scripts);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
  }
  // Every event the HOST emitted (what ipc-handlers forwards to the renderer).
  function collect(): any[] {
    const seen: any[] = [];
    host.on('transcript-event', (e) => seen.push(e));
    return seen;
  }

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-spec-run-')); });
  afterEach(async () => { await host?.destroyAll(); fs.rmSync(root, { recursive: true, force: true }); });

  // Two tool steps (distinct inputs, so the doom-loop guard can't trip) then a
  // final report message.
  const TWO_TOOLS_THEN_REPORT = [
    stream(toolCallChunk('c1', 'Glob', { pattern: '*.ts' }), finishChunk('tool-calls')),
    stream(toolCallChunk('c2', 'Glob', { pattern: '*.md' }), finishChunk('tool-calls')),
    stream(...textChunks('t', 'REPORT: found it at src/x.ts'), finishChunk('stop')),
  ];

  it('re-stamps the child\'s display events onto the parent and returns its report', async () => {
    await withParent(TWO_TOOLS_THEN_REPORT);
    const events = collect();

    const { childId, report } = await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      // Task 1 (plan 1b): spawnSpecialist now BINDS a reservation rather than
      // making one itself (tools/task.ts's execute() does that via
      // reserveSpecialist before ever calling spawn) — these tests exercise
      // the run loop directly, below the Task tool, so they hand it a plain
      // reader token rather than going through reserveSpecialist/task.ts.
      token: { parentId: 'root-1', writer: false },
    });

    // (a) display re-stamping: child events arrive under the PARENT's sessionId
    const childStamped = events.filter((e) => e.data?.agentId === childId);
    expect(childStamped.length).toBeGreaterThan(0);
    for (const e of childStamped) {
      expect(e.sessionId).toBe('root-1');
      expect(e.data.parentAgentToolUseId).toBe('tc-1');
      expect(DISPLAY_TYPES).toContain(e.type);
    }
    // Both tool steps and the final text all made it through.
    expect(childStamped.filter((e) => e.type === 'tool-use')).toHaveLength(2);
    expect(childStamped.filter((e) => e.type === 'tool-result')).toHaveLength(2);
    expect(childStamped.some((e) => e.type === 'assistant-text')).toBe(true);

    // (b) NO stamped turn-complete/session-error ever reaches the host emitter —
    // a stamped turn-complete would hit the conversation-record ipc listener
    // (noteModelUsed) and the title feeder under the PARENT's id.
    expect(childStamped.find((e) => e.type === 'turn-complete')).toBeUndefined();
    // Stronger form of the same guard: the child's run must not put ANY
    // turn-complete / session-error / user-message on the host at all (the
    // parent ran no turn of its own during this test), stamped or not.
    expect(events.filter((e) => e.type === 'turn-complete')).toEqual([]);
    expect(events.filter((e) => e.type === 'session-error')).toEqual([]);
    expect(events.filter((e) => e.type === 'user-message')).toEqual([]);
    // Task 5's pin still holds: nothing is forwarded RAW under the child's id.
    expect(events.filter((e) => e.sessionId === childId)).toEqual([]);

    // (c) persistence separation: the child's own JSONL holds its transcript
    // under childId — including the turn-complete that was never re-emitted.
    const childEvents = store.readEvents(childId, root);
    expect(childEvents.length).toBeGreaterThan(1);
    expect(childEvents.map((e) => e.type)).toContain('turn-complete');
    expect(childEvents.map((e) => e.type)).toContain('user-message');
    expect(childEvents.every((e) => e.sessionId === childId)).toBe(true);

    // (d) the parent's file contains NO child-stamped events (display-only
    // re-emission — the copy is for the renderer, never for the parent's disk
    // record, which must stay a faithful record of the parent's own turns).
    await host.drain('root-1');
    expect(store.readEvents('root-1', root).filter((e) => e.data?.agentId)).toHaveLength(0);

    // (e) the report comes back, wrapped with a header and a transcript pointer
    // — Task 8: the header carries the child's assigned fun title, not the
    // bare displayName, so match the title shape rather than a fixed string.
    expect(report).toContain('REPORT: found it');
    expect(report).toMatch(new RegExp(`## Report from \\w+ the \\w+ Explorer \\(${EXPLORER.id}\\)`));
    expect(report).toContain(`[full transcript: specialist session ${childId}]`);
  });

  // Fix: harness-session.ts:1769 emits one assistant-text event per STREAM
  // DELTA for native models, not per whole message — the reducer's
  // applySubagentEvent (chat-reducer.ts) coalesces same-partId deltas back
  // into one segment, but that only works if the display re-stamping this
  // host does (spawnSpecialist's re-emit under the parent's sessionId)
  // actually carries the child's partId through. Pin that here at the host
  // level rather than only in the reducer unit tests.
  it('re-stamped assistant-text display events carry the partId the reducer needs to coalesce', async () => {
    await withParent([
      stream(...multiDeltaTextChunks('t', 'REPORT: found it ', 'at src/x.ts'), finishChunk('stop')),
    ]);
    const events = collect();

    const { childId } = await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      // Task 1 (plan 1b): spawnSpecialist now BINDS a reservation rather than
      // making one itself (tools/task.ts's execute() does that via
      // reserveSpecialist before ever calling spawn) — these tests exercise
      // the run loop directly, below the Task tool, so they hand it a plain
      // reader token rather than going through reserveSpecialist/task.ts.
      token: { parentId: 'root-1', writer: false },
    });

    const textEvents = events.filter((e) => e.data?.agentId === childId && e.type === 'assistant-text');
    expect(textEvents.length).toBeGreaterThanOrEqual(2);
    // Every delta for this text block shares the SAME partId ('t', from the
    // script) — the exact signal the reducer keys its merge on.
    const partIds = new Set(textEvents.map((e) => e.data.partId));
    expect(partIds.size).toBe(1);
    expect([...partIds][0]).toBeTruthy();
  });

  it('tears the child down after a successful run (no live entry, no model ref, no writer lock)', async () => {
    await withParent(TWO_TOOLS_THEN_REPORT);
    const released: string[] = [];
    host.setModelReleasedHandler((id) => released.push(id));

    const { childId } = await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      // Task 1 (plan 1b): spawnSpecialist now BINDS a reservation rather than
      // making one itself (tools/task.ts's execute() does that via
      // reserveSpecialist before ever calling spawn) — these tests exercise
      // the run loop directly, below the Task tool, so they hand it a plain
      // reader token rather than going through reserveSpecialist/task.ts.
      token: { parentId: 'root-1', writer: false },
    });

    expect((host as any).live.has(childId)).toBe(false);
    expect((host as any).childrenOf.get('root-1')?.has(childId)).toBeFalsy();
    // WHY read the map directly: isSpecialistWriterBusy was removed as dead
    // production code (only tests called it) — activeWriterChild is still
    // the source of truth this assertion verifies.
    expect((host as any).activeWriterChild.has('root-1')).toBe(false);
    // The child gave back its model ref: the parent is now 'm''s only user.
    expect(host.sessionsForModel('m')).toEqual(['root-1']);
    await host.destroy('root-1');
    expect(released).toEqual(['m']);
  });

  // Exclusion sweep pin (Task 8): the child's JSONL IS on disk after a
  // completed run (persistence is real — see the persistence-separation
  // assertion above), but SessionStore.list()'s default (includeChildren
  // false) must still hide it from every default listing surface. This is
  // the one behavior every list()-based consumer (Resume Browser via
  // NativeSessionHost.list(), NATIVE_SESSIONS_LIST) inherits for free — see
  // task-8-report.md for the full per-surface sweep this pin backs.
  it('a completed run leaves only the root visible to store.list()', async () => {
    await withParent(TWO_TOOLS_THEN_REPORT);
    const { childId } = await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      // Task 1 (plan 1b): spawnSpecialist now BINDS a reservation rather than
      // making one itself (tools/task.ts's execute() does that via
      // reserveSpecialist before ever calling spawn) — these tests exercise
      // the run loop directly, below the Task tool, so they hand it a plain
      // reader token rather than going through reserveSpecialist/task.ts.
      token: { parentId: 'root-1', writer: false },
    });

    // The child file genuinely exists on disk (persistence happened)...
    expect(store.readEvents(childId, root).length).toBeGreaterThan(0);
    // ...but the default (hidden-children) listing shows only the root.
    const visible = store.list();
    expect(visible.map((r) => r.sessionId)).toEqual(['root-1']);
    // Asking explicitly for children still finds it — this is a default, not
    // a deletion.
    expect(store.list({ includeChildren: true }).some((r) => r.sessionId === childId)).toBe(true);
  });

  it('a mid-run provider failure rejects with the real reason and still tears the child down', async () => {
    // Step 1 calls a tool; step 2's stream surfaces an error part, which the
    // driver throws (not retryable — no HTTP status) and reports as a
    // session-error transcript event. Awaiting the child's drain alone would
    // see a clean resolution here, which is exactly why runSpecialist listens
    // for the error event instead.
    await withParent([
      stream(toolCallChunk('c1', 'Glob', { pattern: '*.ts' }), finishChunk('tool-calls')),
      stream({ type: 'error', error: new Error('llama-server dropped the connection') }),
    ]);
    const events = collect();
    // Fix (Task 7 review, restoring Task 6 coverage lost in the foreground-run
    // rewrite): the success-path leak guard (native-session-host.test.ts "a
    // completed spawnSpecialist run does not leak the minted child") pins
    // childrenOf de-registration AND model-ref release; the failure path needs
    // the identical two assertions so a mid-run throw can't leave the child
    // wired into the parent's children set or holding a phantom model ref.
    const released: string[] = [];
    host.setModelReleasedHandler((id) => released.push(id));

    await expect(host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      token: { parentId: 'root-1', writer: false },
    })).rejects.toThrow(/llama-server dropped the connection/);

    // The failure reason is RELAYED, never replaced by a guess
    // (error-message-standards.md) — and no session-error was stamped onto the
    // parent's stream on the way out.
    expect(events.filter((e) => e.type === 'session-error')).toEqual([]);
    // No leak: the child that failed mid-run is gone from the live map.
    const childRow = store.list({ includeChildren: true }).find((r) => r.parentSessionId === 'root-1');
    expect(childRow).toBeDefined();
    expect((host as any).live.has(childRow!.sessionId)).toBe(false);
    // WHY read the map directly: isSpecialistWriterBusy was removed as dead
    // production code (only tests called it) — activeWriterChild is still
    // the source of truth this assertion verifies.
    expect((host as any).activeWriterChild.has('root-1')).toBe(false);
    // De-registered from the parent's live children set (mirrors the
    // success-path leak guard) — a leaked child would still show up here.
    expect((host as any).childrenOf.get('root-1')?.has(childRow!.sessionId)).toBeFalsy();
    // The child's model ref did not leak either: destroying the parent (its
    // only remaining user of 'm') fully releases it exactly once.
    await host.destroy('root-1');
    expect(released).toEqual(['m']);
  });

  it('nudges EXACTLY once when the child ends with no report, and accepts the second answer', async () => {
    await withParent([
      stream(finishChunk('stop')),                                              // turn 1: no text at all
      stream(...textChunks('t', 'REPORT: after the nudge'), finishChunk('stop')), // turn 2: the real report
    ]);

    const { childId, report } = await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      // Task 1 (plan 1b): spawnSpecialist now BINDS a reservation rather than
      // making one itself (tools/task.ts's execute() does that via
      // reserveSpecialist before ever calling spawn) — these tests exercise
      // the run loop directly, below the Task tool, so they hand it a plain
      // reader token rather than going through reserveSpecialist/task.ts.
      token: { parentId: 'root-1', writer: false },
    });

    expect(report).toContain('REPORT: after the nudge');
    // EXACTLY one nudge — retry budget 1 (spec §3). Two user messages in the
    // child's transcript: the brief, then the single reminder.
    const userMessages = store.readEvents(childId, root).filter((e) => e.type === 'user-message');
    expect(userMessages).toHaveLength(2);
    expect(userMessages[1].data.text).toMatch(/final message is your report/i);
  });

  it('fails typed when the child is still silent after its one nudge', async () => {
    await withParent([
      stream(finishChunk('stop')),   // scriptedModel replays its last script forever → both turns silent
    ]);

    await expect(host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      token: { parentId: 'root-1', writer: false },
    })).rejects.toThrow(/no final message|without producing a report/i);
  });

  it("a step-capped child is NOT a failure: its last text comes back with a '(stopped at its step limit)' suffix", async () => {
    // stepCap 1 means the very first tool step trips the budget gate, which
    // ends the turn with stopReason 'max_steps' (Task 5.5's ask-policy path).
    const CAPPED = { ...EXPLORER, stepCap: 1 };
    await withParent([
      stream(...textChunks('t', 'Found half of it in src/a.ts'), toolCallChunk('c1', 'Glob', { pattern: '*.ts' }), finishChunk('tool-calls')),
    ]);

    const { childId, report } = await host.spawnSpecialist('root-1', {
      specialist: CAPPED, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      token: { parentId: 'root-1', writer: false },
    });

    expect(report).toContain('Found half of it in src/a.ts');
    expect(report).toContain('(stopped at its step limit)');
    // A capped run must NOT be nudged — the child is out of steps, so another
    // turn would just burn the cap again.
    expect(store.readEvents(childId, root).filter((e) => e.type === 'user-message')).toHaveLength(1);
  });

  it('caps the report against the specialist budget and says what it cut', async () => {
    // A report far over the explorer's 2000-token static cap. The parent has no
    // measured occupancy in this test, so the static cap is the binding one.
    const huge = 'x'.repeat(60_000);
    await withParent([
      stream(...textChunks('t', `REPORT: found it\n${huge}`), finishChunk('stop')),
    ]);

    const { report } = await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      // Task 1 (plan 1b): spawnSpecialist now BINDS a reservation rather than
      // making one itself (tools/task.ts's execute() does that via
      // reserveSpecialist before ever calling spawn) — these tests exercise
      // the run loop directly, below the Task tool, so they hand it a plain
      // reader token rather than going through reserveSpecialist/task.ts.
      token: { parentId: 'root-1', writer: false },
    });

    expect(report).toContain('REPORT: found it');            // the head survives
    expect(report.length).toBeLessThan(huge.length / 2);     // ...but the bulk did not
    expect(report).toMatch(/truncated/i);                    // and the cut is stated, never silent
  });

  // ---- Review round 2, Findings 1 & 2: a ledger write can throw (mutateJson
  // is lock-guarded — NativeHome.mutateJson throws on lock exhaustion) at two
  // points in spawnSpecialist, and neither may corrupt what a real run does.
  // These tests boot a host WITH a real ledger wired in (the plain `boot`/
  // `withParent` helpers above never pass a nativeHome, so `host.ledger` is
  // undefined there and none of this file's other tests exercise these
  // paths) and monkeypatch the ledger's methods to throw, the same fault-
  // injection shape `throwOnceFactory` uses elsewhere in this suite for the
  // model factory.
  describe('a ledger write failure never corrupts a real run (review round 2)', () => {
    async function withLedgerParent(scripts: any[][]) {
      const model = scriptedModel(scripts);
      const home = new NativeHome(root);
      store = new SessionStore(new NativeHome(root));
      host = new NativeSessionHost(
        store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null,
        undefined, undefined, undefined, undefined, undefined, home,
      );
      await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    }

    it('Finding 1: a completion-write failure does not discard the report or relabel a successful run "failed"', async () => {
      await withLedgerParent(TWO_TOOLS_THEN_REPORT);
      const ledger = (host as any).ledger;
      const realUpdate = ledger.update.bind(ledger);
      let sawCompletedWrite = false;
      // Fail ONLY the completion write (status: 'completed') — recordStart
      // (before the run) still works, so the record genuinely exists.
      ledger.update = async (...args: any[]) => {
        if (args[3]?.status === 'completed') {
          sawCompletedWrite = true;
          throw new Error('simulated lock exhaustion');
        }
        return realUpdate(...args);
      };

      const { childId, report } = await host.spawnSpecialist('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
        token: { parentId: 'root-1', writer: false },
      });

      expect(sawCompletedWrite).toBe(true); // sanity: the throwing write path actually ran
      // The report the child genuinely produced is still returned...
      expect(report).toContain('REPORT: found it at src/x.ts');
      expect(childId).toBeTruthy();
      // ...and the run is not relabeled a failure on disk because the
      // completion write blew up on the way out.
      const rec = ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
      expect(rec?.status).not.toBe('failed');
    });

    it('Finding 2: a recordStart failure still tears the child down — no leaked live entry, childrenOf, or model ref', async () => {
      await withLedgerParent(TWO_TOOLS_THEN_REPORT);
      const ledger = (host as any).ledger;
      ledger.recordStart = async () => { throw new Error('simulated lock exhaustion'); };

      const released: string[] = [];
      host.setModelReleasedHandler((id) => released.push(id));

      await expect(host.spawnSpecialist('root-1', {
        specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
        token: { parentId: 'root-1', writer: false },
      })).rejects.toThrow(/simulated lock exhaustion/);

      // The child that createChild minted before recordStart ever ran must
      // still be torn down — the LEAK GUARD (spawnSpecialist's finally) has
      // to cover this path too.
      const childRow = store.list({ includeChildren: true }).find((r) => r.parentSessionId === 'root-1');
      expect(childRow).toBeDefined();
      expect((host as any).live.has(childRow!.sessionId)).toBe(false);
      expect((host as any).childrenOf.get('root-1')?.has(childRow!.sessionId)).toBeFalsy();
      expect((host as any).activeWriterChild.has('root-1')).toBe(false);
      await host.destroy('root-1');
      expect(released).toEqual(['m']); // the child's model ref did not leak either
    });
  });
});

// ---- Task 12, item 4: compaction-finalize ----------------------------------
// A small local window can force the child to auto-compact MORE THAN ONCE
// during one delegated run (spec §3: a designed path for small windows, not an
// edge case). On the SECOND auto-compaction, runSpecialist's listener posts a
// steer telling the child to stop exploring and write up what it has — via
// postSteer (Task 3's primitive), never a prompt edit. These tests drive the
// listener directly by emitting synthetic `compact-summary` events on the
// child's OWN session emitter (the exact channel runSpecialist listens on),
// rather than engineering a real tiny-context compaction trigger — the
// compaction MATH itself is already pinned in harness-compaction.test.ts; this
// suite is about the LISTENER's count-to-two-then-steer-once behavior.
describe('compaction-finalize steer (Task 12, item 4)', () => {
  let root: string;
  let store: SessionStore;
  let host: NativeSessionHost;

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-spec-finalize-')); });
  afterEach(async () => { await host?.destroyAll(); fs.rmSync(root, { recursive: true, force: true }); });

  const FINALIZE_STEER = 'You are running low on room even after summarizing. Stop new exploration — '
    + 'write up what you have and finish with your report now.';

  // Builds a host whose model, on every doStream call, looks up the freshly
  // minted specialist child (the one live entry that is not the root) and
  // fires `fakeCompactionCalls` synthetic compact-summary(autoCompaction:true)
  // events on the CHILD's own session emitter — the same 'transcript-event'
  // channel runSpecialist's onEvent listens on — before returning that step's
  // real scripted chunks. A spy on the child's postSteer is installed the
  // first time the child is found, so it is in place before any steer could
  // possibly fire.
  function bootWithFakeCompactions(scripts: any[][], compactionsPerCall: number[]) {
    let call = 0;
    let postSteerSpy: ReturnType<typeof vi.spyOn> | undefined;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const childEntry = [...(host as any).live.entries()].find(([id]: [string, unknown]) => id !== 'root-1');
        if (childEntry) {
          const [childId, entry] = childEntry as [string, { session: any }];
          if (!postSteerSpy) postSteerSpy = vi.spyOn(entry.session, 'postSteer');
          const n = compactionsPerCall[call] ?? 0;
          for (let i = 0; i < n; i++) {
            entry.session.emit('transcript-event', {
              type: 'compact-summary',
              sessionId: childId,
              uuid: `fake-compaction-${call}-${i}`,
              timestamp: Date.now(),
              data: { summary: 'fake summary', autoCompaction: true },
            });
          }
        }
        const chunks = scripts[Math.min(call, scripts.length - 1)];
        call += 1;
        return { stream: simulateReadableStream({ chunks }) };
      },
    });
    store = new SessionStore(new NativeHome(root));
    host = new NativeSessionHost(store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null);
    return () => postSteerSpy!;
  }

  const TWO_TOOLS_THEN_REPORT = [
    stream(toolCallChunk('c1', 'Glob', { pattern: '*.ts' }), finishChunk('tool-calls')),
    stream(toolCallChunk('c2', 'Glob', { pattern: '*.md' }), finishChunk('tool-calls')),
    stream(...textChunks('t', 'REPORT: found it at src/x.ts'), finishChunk('stop')),
  ];

  it('posts the finalize steer exactly once, on the SECOND auto-compaction', async () => {
    // One auto-compaction on step 1 (no steer yet), the second on step 2
    // (steer fires here), none on step 3.
    const getSpy = bootWithFakeCompactions(TWO_TOOLS_THEN_REPORT, [1, 1, 0]);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      // Task 1 (plan 1b): spawnSpecialist BINDS a reservation the Task tool
      // made; these tests drive the run loop directly, so they hand it a
      // plain reader token instead of going through reserveSpecialist.
      token: { parentId: 'root-1', writer: false },
    });

    const postSteerSpy = getSpy();
    expect(postSteerSpy).toHaveBeenCalledTimes(1);
    expect(postSteerSpy).toHaveBeenCalledWith(FINALIZE_STEER);
  });

  it('still posts only ONCE per child even with a third auto-compaction later in the same run', async () => {
    const getSpy = bootWithFakeCompactions(TWO_TOOLS_THEN_REPORT, [1, 1, 1]);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      // Task 1 (plan 1b): spawnSpecialist BINDS a reservation the Task tool
      // made; these tests drive the run loop directly, so they hand it a
      // plain reader token instead of going through reserveSpecialist.
      token: { parentId: 'root-1', writer: false },
    });

    expect(getSpy()).toHaveBeenCalledTimes(1);
  });

  it('never steers when auto-compaction happens only once in the whole run', async () => {
    const getSpy = bootWithFakeCompactions(TWO_TOOLS_THEN_REPORT, [1, 0, 0]);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      // Task 1 (plan 1b): spawnSpecialist BINDS a reservation the Task tool
      // made; these tests drive the run loop directly, so they hand it a
      // plain reader token instead of going through reserveSpecialist.
      token: { parentId: 'root-1', writer: false },
    });

    expect(getSpy()).not.toHaveBeenCalled();
  });

  it('a manual (non-auto) compact-summary event never counts toward the finalize steer', async () => {
    // Same shape as maybeCompact's manual-/compact path (harness-session.ts
    // line ~1083): compact-summary WITHOUT autoCompaction. Two of these must
    // not add up to a steer — only autoCompaction:true events count.
    let call = 0;
    let postSteerSpy: ReturnType<typeof vi.spyOn> | undefined;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        const childEntry = [...(host as any).live.entries()].find(([id]: [string, unknown]) => id !== 'root-1');
        if (childEntry) {
          const [childId, entry] = childEntry as [string, { session: any }];
          if (!postSteerSpy) postSteerSpy = vi.spyOn(entry.session, 'postSteer');
          entry.session.emit('transcript-event', {
            type: 'compact-summary', sessionId: childId, uuid: `fake-manual-${call}`, timestamp: Date.now(),
            data: { summary: 'fake summary' },   // NO autoCompaction flag
          });
        }
        const chunks = TWO_TOOLS_THEN_REPORT[Math.min(call, TWO_TOOLS_THEN_REPORT.length - 1)];
        call += 1;
        return { stream: simulateReadableStream({ chunks }) };
      },
    });
    store = new SessionStore(new NativeHome(root));
    host = new NativeSessionHost(store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null);
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    await host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      // Task 1 (plan 1b): spawnSpecialist BINDS a reservation the Task tool
      // made; these tests drive the run loop directly, so they hand it a
      // plain reader token instead of going through reserveSpecialist.
      token: { parentId: 'root-1', writer: false },
    });

    expect(postSteerSpy).not.toHaveBeenCalled();
  });
});

// ---- Task 7: heartbeat staleness — flags, never kills -----------------------
// Liveness is heartbeat-based, never wall-clock (spec §3): runSpecialist's
// listener tracks lastActivityAt + an open-tool-call set and polls them on an
// interval that only ever flips a `stale` flag on the ledger record (read by
// Task 5's status block) — it never aborts, interrupts, or fails the child.
// These tests use vitest fake timers and a model whose FIRST doStream call
// hangs until the test calls `release()`, so a synthetic event can be fired
// directly on the child's OWN session emitter (same technique the
// compaction-finalize suite above uses) at controlled fake-timer offsets,
// with no live model turn racing the assertions. `release()` always lets that
// turn finish normally, so every test proves the child actually completes.
describe('heartbeat staleness (Task 7)', () => {
  let root: string;
  let store: SessionStore;
  let host: NativeSessionHost;

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-spec-stale-')); });
  afterEach(async () => {
    vi.useRealTimers();
    await host?.destroyAll();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const REPORT_CHUNKS = stream(...textChunks('t', 'REPORT: done'), finishChunk('stop'));

  // Scoped fake-timer allowlist (never the bare `vi.useFakeTimers()`): the
  // host's send() intentionally defers the actual turn by one setImmediate
  // macrotask (native-session-host.ts:1430-1431, "let a same-tick send
  // dispatch" elsewhere in this same file), and `ai`'s simulateReadableStream
  // used below skips its own real/fake setTimeout(0) pacing via explicit null
  // delays — so setImmediate never needs to be faked here. Faking it anyway
  // would wedge every turn before its first doStream call ever runs (verified
  // empirically while writing these tests).
  const fakeStaleTimers = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });

  /** Boots a host with a REAL ledger wired in (the plain `boot`/`withParent`
   *  helpers elsewhere in this file never pass a NativeHome) and a model
   *  whose first doStream call locates the freshly-minted child, then hangs
   *  on `releasePromise` until the test calls `release()`. */
  function bootHangingChild() {
    let childId: string | undefined;
    let childEntry: { session: any } | undefined;
    let startedResolve: () => void;
    const startedPromise = new Promise<void>((r) => { startedResolve = r; });
    let releaseResolve: () => void;
    const releasePromise = new Promise<void>((r) => { releaseResolve = r; });
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        if (call === 0) {
          const entry = [...(host as any).live.entries()].find(([id]: [string, unknown]) => id !== 'root-1');
          if (entry) { childId = entry[0] as string; childEntry = entry[1] as { session: any }; }
          startedResolve();
          await releasePromise;
        }
        call += 1;
        return { stream: simulateReadableStream({ chunks: REPORT_CHUNKS, initialDelayInMs: null, chunkDelayInMs: null }) };
      },
    });
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    return {
      release: () => releaseResolve(),
      started: startedPromise,
      getChildId: () => childId!,
      getEntry: () => childEntry!,
    };
  }

  /** Boots the SAME kind of host, but hangs REAL TOOL EXECUTION rather than
   *  doStream. Tests 3/4 need to sit silent for 300s+ of (fake) time — long
   *  enough to cross the harness session's OWN per-step prefill watchdog
   *  (harness-session.ts's armWatchdog, ~240s+ by default), which would fire
   *  its own heartbeat and reset OUR clock too if a doStream call were still
   *  open (that overlap is real and correct — see the "open model request is
   *  never stale" test above). The genuinely realistic shape of "an
   *  unresolved tool call" is the model having ALREADY gotten its tool-call
   *  chunk back (the step's stream is fully drained, so the per-step watchdog
   *  is torn down — harness-session.ts:1840-1845 clears it in every step's
   *  `finally`) and the REAL tool execution just taking a long time — so this
   *  helper patches the child's real Glob tool to hang on `releasePromise`
   *  instead, letting the REST of the driver (permissions, the real tool-use
   *  event, doom-loop bookkeeping) run unmodified. */
  function bootHangingTool() {
    let childId: string | undefined;
    let toolStartedResolve: () => void;
    const toolStartedPromise = new Promise<void>((r) => { toolStartedResolve = r; });
    let releaseResolve: () => void;
    const releasePromise = new Promise<void>((r) => { releaseResolve = r; });
    const TOOL_CALL_CHUNKS = stream(toolCallChunk('t1', 'Glob', { pattern: '*.ts' }), finishChunk('tool-calls'));
    let call = 0;
    const model = new MockLanguageModelV4({
      doStream: async () => {
        if (call === 0) {
          const entry = [...(host as any).live.entries()].find(([id]: [string, unknown]) => id !== 'root-1');
          if (entry) {
            childId = entry[0] as string;
            const session = (entry[1] as { session: any }).session;
            // Patch installed BEFORE this call returns, so it is in place
            // before the driver can possibly reach the real execute() below —
            // no race with when the test resumes after `started`/`toolStarted`.
            const tool = session.toolByName.get('Glob');
            const realExecute = tool.execute.bind(tool);
            tool.execute = async (...args: any[]) => {
              toolStartedResolve();
              await releasePromise;
              return realExecute(...args);
            };
          }
          call += 1;
          return { stream: simulateReadableStream({ chunks: TOOL_CALL_CHUNKS, initialDelayInMs: null, chunkDelayInMs: null }) };
        }
        call += 1;
        return { stream: simulateReadableStream({ chunks: REPORT_CHUNKS, initialDelayInMs: null, chunkDelayInMs: null }) };
      },
    });
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => ({ contextLength: null, totalSlots: null }), async () => null, async () => null,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    return {
      release: () => releaseResolve(),
      toolStarted: toolStartedPromise,
      getChildId: () => childId!,
    };
  }

  /** Monkeypatches ledger.updateIfRunning (the write path staleness uses,
   *  same as the review-round-2 fault-injection tests above) so the test can
   *  deterministically AWAIT the real write the interval fires — a bare
   *  `await vi.advanceTimersByTimeAsync(...)` gives no guarantee the
   *  fire-and-forget disk write it triggered has actually landed yet. */
  function trackStaleWrites() {
    const ledger = (host as any).ledger;
    const real = ledger.updateIfRunning.bind(ledger);
    let lastWrite: Promise<void> = Promise.resolve();
    ledger.updateIfRunning = async (...args: any[]) => {
      lastWrite = real(...args);
      return lastWrite;
    };
    return { waitForWrite: () => lastWrite, ledger };
  }

  it('a silent child is flagged stale after the idle threshold and unflagged by its next event', async () => {
    fakeStaleTimers();
    const { release, started, getChildId, getEntry } = bootHangingChild();
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const { waitForWrite, ledger } = trackStaleWrites();

    const runPromise = host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      token: { parentId: 'root-1', writer: false },
    });
    await started;
    const childId = getChildId();

    // Still under the idle threshold: not yet stale.
    await vi.advanceTimersByTimeAsync(SPECIALIST_IDLE_STALE_MS - 10_000);
    await waitForWrite();
    expect(ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId)?.stale).not.toBe(true);

    // Cross it — the next poll tick flags it.
    await vi.advanceTimersByTimeAsync(20_000);
    await waitForWrite();
    expect(ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId)?.stale).toBe(true);

    // The child's NEXT event (fired directly on its own session emitter, the
    // exact channel runSpecialist's onEvent listens on) unflags it.
    getEntry().session.emit('transcript-event', {
      type: 'assistant-text', sessionId: childId, uuid: 'evt-unflag', timestamp: Date.now(),
      data: { text: 'still working', partId: 't2' },
    });
    await waitForWrite();
    expect(ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId)?.stale).toBe(false);

    // The run still finishes normally — staleness never touched it.
    release();
    const { report } = await runPromise;
    expect(report).toContain('REPORT: done');
  });

  it('watchdog heartbeat events (text-less assistant-thinking) count as activity — an open model request is never stale', async () => {
    fakeStaleTimers();
    const { release, started, getChildId, getEntry } = bootHangingChild();
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const { waitForWrite, ledger } = trackStaleWrites();

    const runPromise = host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      token: { parentId: 'root-1', writer: false },
    });
    await started;
    const childId = getChildId();

    // 90s of silence (under the 120s idle threshold)...
    await vi.advanceTimersByTimeAsync(90_000);
    // ...then the streaming watchdog's text-less, partId-less heartbeat
    // arrives — session-store.ts:93-95 drops it from disk, but the emitter
    // still fires, and that is exactly what must count as activity here (a
    // slow local prefill must never be flagged stale).
    getEntry().session.emit('transcript-event', {
      type: 'assistant-thinking', sessionId: childId, uuid: 'evt-heartbeat', timestamp: Date.now(),
      data: {},
    });
    await waitForWrite();

    // Another 90s since the heartbeat (180s total since the run started, but
    // only 90s since the last activity) — still must NOT be stale.
    await vi.advanceTimersByTimeAsync(90_000);
    await waitForWrite();
    expect(ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId)?.stale).not.toBe(true);

    // Sanity: the mechanism is not permanently exempted — with no further
    // heartbeats it does eventually trip once genuinely 120s pass.
    await vi.advanceTimersByTimeAsync(40_000);
    await waitForWrite();
    expect(ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId)?.stale).toBe(true);

    release();
    await runPromise;
  });

  it('an unresolved tool call uses the longer in-tool threshold', async () => {
    fakeStaleTimers();
    const { release, toolStarted, getChildId } = bootHangingTool();
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const { waitForWrite, ledger } = trackStaleWrites();

    const runPromise = host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      token: { parentId: 'root-1', writer: false },
    });
    // Waits for the REAL Glob execute() to actually start — at that point the
    // REAL tool-use event has already fired (openTools now holds 't1') and
    // the model's step-level stream is fully drained, so there is no
    // per-step watchdog running underneath this wait.
    await toolStarted;
    const childId = getChildId();

    // Past the plain idle threshold (120s) but under the in-tool one (300s):
    // an open tool call must NOT be flagged yet.
    await vi.advanceTimersByTimeAsync(SPECIALIST_IDLE_STALE_MS + 60_000); // 180s
    await waitForWrite();
    expect(ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId)?.stale).not.toBe(true);

    // Past the in-tool threshold (300s total) — now it flags.
    await vi.advanceTimersByTimeAsync(SPECIALIST_IN_TOOL_STALE_MS - (SPECIALIST_IDLE_STALE_MS + 60_000) + 10_000);
    await waitForWrite();
    expect(ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId)?.stale).toBe(true);

    // The tool result arrives — the run finishes normally afterward.
    release();
    const { report } = await runPromise;
    expect(report).toContain('REPORT: done');
  });

  it('staleness never interrupts, kills, or fails the child', async () => {
    fakeStaleTimers();
    const { release, toolStarted, getChildId } = bootHangingTool();
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const { waitForWrite, ledger } = trackStaleWrites();

    const runPromise = host.spawnSpecialist('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root, parentToolCallId: 'tc-1',
      token: { parentId: 'root-1', writer: false },
    });
    await toolStarted;
    const childId = getChildId();

    // Go well stale — long past the (longer, since a tool is open) threshold.
    await vi.advanceTimersByTimeAsync(SPECIALIST_IN_TOOL_STALE_MS + 60_000);
    await waitForWrite();
    expect(ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId)?.stale).toBe(true);

    // The child completes normally afterward — no abort, no interrupt, no
    // typed failure. spawnSpecialist resolves with its real report.
    release();
    const { report } = await runPromise;
    expect(report).toContain('REPORT: done');

    const rec = ledger.listFor(root, 'root-1').find((r: any) => r.childId === childId);
    expect(rec?.status).toBe('completed');
    // Torn down normally, same as every other successful run in this file.
    expect((host as any).live.has(childId)).toBe(false);
  });
});
