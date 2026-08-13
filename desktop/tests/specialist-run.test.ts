import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { scriptedModel, stream, textChunks, multiDeltaTextChunks, toolCallChunk, finishChunk } from './helpers/scripted-model';
import { resolveSpecialist } from '../src/main/harness/specialists/registry';
import { OWNER, RAW_REPORT_CAP_CHARS } from '../src/main/harness/specialists/delegation-ledger';
import { computeReportBudget } from '../src/main/harness/specialists/report-budget';
import { APPROX_CHARS_PER_TOKEN } from '../src/main/harness/message-size';

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
    host = new NativeSessionHost(store, async () => model as any, async () => null, async () => null, async () => null);
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
        store, async () => model as any, async () => null, async () => null, async () => null,
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

// ---- Task 4: BACKGROUND specialist execution + idle-boundary delivery ------
// spawnSpecialistBackground resolves at LAUNCH (createChild + a 'running'
// ledger row) and hands the rest of the run to an un-awaited chain
// (runDelegation). The chain's eventual report (or typed failure) is injected
// into the parent's OWN conversation as a synthetic user-role turn — but ONLY
// once the parent reaches an idle boundary (queueDelivery / runTurns' tail),
// never spliced into a turn the parent is still running. All of these tests
// need a REAL ledger (a NativeHome pointed at the test's tmp root), since the
// delivery loop reads/writes it directly — same `home` pattern the "ledger
// write failure" describe block above uses.
describe('background execution + idle-boundary delivery (Task 4)', () => {
  let root: string;
  let store: SessionStore;
  let host: NativeSessionHost;

  function collect(): any[] {
    const seen: any[] = [];
    host.on('transcript-event', (e) => seen.push(e));
    return seen;
  }

  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-spec-bg-')); });
  afterEach(async () => { await host?.destroyAll(); fs.rmSync(root, { recursive: true, force: true }); });

  it('background Task resolves immediately with a task_id while the child is still running', async () => {
    // No gating needed: send()'s dispatch is deferred one macrotask
    // (setImmediate), and spawnSpecialistBackground returns BEFORE its
    // un-awaited runDelegation chain ever reaches that dispatch — so by
    // construction the child cannot have started running yet at the moment
    // this call resolves. Asserting `inFlight` on the child's own live entry
    // (rather than just "the call resolved fast") is what actually pins
    // "still running", not just "hasn't finished".
    const model = scriptedModel([
      stream(...textChunks('t', 'REPORT: done'), finishChunk('stop')),
    ]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => null, async () => null, async () => null,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    const { childId, title } = await host.spawnSpecialistBackground('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root,
      parentToolCallId: 'tc-1', description: 'find the config loader', token: { parentId: 'root-1', writer: false },
    });

    expect(childId).toBeTruthy();
    expect(title).toBeTruthy();
    // The parent itself was never touched — background delegation must not
    // block or busy the delegating session.
    expect(host.isIdle('root-1')).toBe(true);
    // The child, on the other hand, is genuinely mid-run: send() already set
    // inFlight synchronously, before this call ever returned.
    expect((host as any).live.get(childId)?.inFlight).toBe(true);

    // Let the child's run actually finish so afterEach's destroyAll() doesn't
    // race a live turn.
    await vi.waitFor(() => {
      const rec = (host as any).ledger.listFor(root, 'root-1').find((d: any) => d.childId === childId);
      expect(rec?.status).toBe('completed');
    });
  });

  it('a background completion is injected as a user-role turn when the parent goes idle — never mid-turn', async () => {
    // The PARENT's own turn is gated (manually resolved) so it stays
    // in-flight for as long as the test needs — long enough for an
    // independently-triggered background child to run to completion while
    // the parent is still busy. The child gets a SEPARATE scripted model
    // instance; modelFactory routes the FIRST call (guaranteed to be the
    // parent's own turn, confirmed via `parentEntered` before the child is
    // ever spawned) to it and everything after to the child's model.
    let parentEntered = false;
    let releaseParent: () => void = () => {};
    const parentGate = new Promise<void>((res) => { releaseParent = res; });
    const parentModel = new MockLanguageModelV4({
      doStream: async () => {
        parentEntered = true;
        await parentGate;
        return { stream: simulateReadableStream({ chunks: stream(...textChunks('t', 'parent turn done'), finishChunk('stop')) }) };
      },
    });
    const childModel = scriptedModel([
      stream(...textChunks('t', 'REPORT: child done'), finishChunk('stop')),
    ]);
    let calls = 0;
    const factory = async () => (calls++ === 0 ? parentModel : childModel) as any;

    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, factory, async () => null, async () => null, async () => null,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const events = collect();

    const sendResult = host.send('root-1', 'go');
    expect(sendResult.status).toBe('sent');
    await vi.waitFor(() => expect(parentEntered).toBe(true));

    const { childId } = await host.spawnSpecialistBackground('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root,
      parentToolCallId: 'tc-1', description: 'find the config loader', token: { parentId: 'root-1', writer: false },
    });

    await vi.waitFor(() => {
      const rec = (host as any).ledger.listFor(root, 'root-1').find((d: any) => d.childId === childId);
      expect(rec?.status).toBe('completed');
    });

    // The child finished, but the PARENT is still mid-turn — nothing may be
    // injected yet.
    expect(events.filter((e) => e.data?.injected === 'specialist-report')).toEqual([]);
    expect(host.isIdle('root-1')).toBe(false);

    releaseParent();
    await (host as any).live.get('root-1').running;

    await vi.waitFor(() => {
      expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
    });
    const injected = events.find((e) => e.data?.injected === 'specialist-report')!;
    expect(injected.type).toBe('user-message');
    expect(injected.data.text).toContain('## Report from');

    // Ordering: the parent's own turn-complete happened strictly BEFORE the
    // injected notice — never spliced mid-turn.
    const turnCompleteIdx = events.findIndex((e) => e.type === 'turn-complete' && !e.data?.agentId);
    const injectedIdx = events.indexOf(injected);
    expect(turnCompleteIdx).toBeGreaterThanOrEqual(0);
    expect(injectedIdx).toBeGreaterThan(turnCompleteIdx);
  });

  it('the injected report is formatted at DELIVERY time with concurrentReporters = number of pending deliveries', async () => {
    // Seed the ledger directly with TWO already-completed, undelivered
    // records (rather than racing two real specialist children to finish at
    // exactly the same moment) — the delivery loop only ever reads the
    // ledger, so this exercises the exact same code path deterministically.
    const model = scriptedModel([stream(finishChunk('stop'))]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    // A real (non-Infinity) remaining window is required — computeReportBudget
    // degrades to the static per-specialist cap when remaining is Infinity,
    // which would hide any difference concurrentReporters makes.
    host = new NativeSessionHost(
      store, async () => model as any, async () => 3500, async () => null, async () => null,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    // Force a KNOWN occupancy so `remaining` is deterministic instead of
    // whatever the chars/4 estimate of the assembled system prompt happens to
    // be — same private-field test seam this suite already uses for `live`.
    ((host as any).live.get('root-1').session as any)._contextUsedTokens = 500;

    const ledger = (host as any).ledger;
    const huge = 'x'.repeat(60_000);
    for (const childId of ['child-a', 'child-b']) {
      await ledger.recordStart(root, 'root-1', {
        childId, parentToolCallId: 'tc', agentType: EXPLORER.id, title: `Test ${childId}`, workDir: root,
        description: 'a test brief', background: true, status: 'running', startedAt: Date.now(),
        delivered: false, owner: OWNER, missedSteers: [],
      });
      await ledger.update(root, 'root-1', childId, { status: 'completed', endedAt: Date.now(), steps: 3, rawReport: huge });
    }

    const events = collect();
    (host as any).queueDelivery('root-1');
    await vi.waitFor(() => {
      expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(2);
    });

    // remaining = window(3500) - used(500) = 3000. Same formula the code uses.
    const remaining = 3000;
    const budgetSolo = computeReportBudget({ staticCapTokens: EXPLORER.reportBudgetTokens, parentRemainingTokens: remaining, concurrentReporters: 1 });
    const budgetShared = computeReportBudget({ staticCapTokens: EXPLORER.reportBudgetTokens, parentRemainingTokens: remaining, concurrentReporters: 2 });
    expect(budgetShared).toBeLessThan(budgetSolo); // sanity: the split genuinely differs

    const injected = events.filter((e) => e.data?.injected === 'specialist-report');
    expect(injected).toHaveLength(2);
    for (const e of injected) {
      const len = (e.data.text as string).length;
      // Definitively NOT the single-reporter budget (which would be ~2x bigger)...
      expect(len).toBeLessThan(budgetSolo * APPROX_CHARS_PER_TOKEN);
      // ...and roughly consistent with the 2-way split, not near-zero.
      expect(len).toBeGreaterThan(budgetShared * APPROX_CHARS_PER_TOKEN * 0.5);
    }
  });

  it('a background child that dies mid-run delivers a typed failure notice, not silence', async () => {
    const model = scriptedModel([
      stream({ type: 'error', error: new Error('llama-server dropped the connection') }),
    ]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => null, async () => null, async () => null,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const events = collect();

    const { childId } = await host.spawnSpecialistBackground('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root,
      parentToolCallId: 'tc-1', description: 'find the config loader', token: { parentId: 'root-1', writer: false },
    });

    await vi.waitFor(() => {
      expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
    });
    const injected = events.find((e) => e.data?.injected === 'specialist-report')!;
    expect(injected.data.text).toMatch(/failed/i);
    expect(injected.data.text).toContain(childId);

    // The failure is durable, not just relayed once: the ledger record itself
    // reads 'failed', and (Task 2's invariant) with the real thrown reason.
    const rec = (host as any).ledger.listFor(root, 'root-1').find((d: any) => d.childId === childId);
    expect(rec.status).toBe('failed');
    expect(rec.failureText).toMatch(/llama-server dropped the connection/);
  });

  it('a background completion whose report exceeds the ledger cap spills the full body to a file', async () => {
    // External review (2026-08-12): the ledger caps rawReport at
    // RAW_REPORT_CAP_CHARS on every write — for a background run, nothing
    // ELSE ever sees the uncapped body again (the child is torn down right
    // after), so the completion handler must spill the full text to disk
    // BEFORE that cap silently discards it.
    const huge = 'y'.repeat(RAW_REPORT_CAP_CHARS + 5_000);
    const model = scriptedModel([stream(...textChunks('t', huge), finishChunk('stop'))]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => null, async () => null, async () => null,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    const { childId } = await host.spawnSpecialistBackground('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root,
      parentToolCallId: 'tc-1', description: 'find the config loader', token: { parentId: 'root-1', writer: false },
    });

    const ledger = (host as any).ledger;
    await vi.waitFor(() => {
      const rec = ledger.listFor(root, 'root-1').find((d: any) => d.childId === childId);
      expect(rec?.status).toBe('completed');
    });
    const rec = ledger.listFor(root, 'root-1').find((d: any) => d.childId === childId);
    expect(rec.rawReport.length).toBe(RAW_REPORT_CAP_CHARS); // capped copy in the ledger
    expect(rec.reportPath).toBeTruthy();
    const spilled = fs.readFileSync(rec.reportPath, 'utf8');
    expect(spilled.length).toBe(huge.length); // the FULL, uncapped body
    expect(spilled.startsWith(huge.slice(0, 200))).toBe(true);
  });

  // ---- Fix pass (external review, 2026-08-12): three follow-on gaps ----------

  it('Finding 1: delivery of a spilled oversized report reads the FULL body back from disk, not the capped ledger copy', async () => {
    // The ledger's own rawReport is capped at RAW_REPORT_CAP_CHARS on every
    // write (delegation-ledger.ts's update()) — formatting delivery from
    // THAT copy alone understates the report's true size in
    // formatSpecialistReport's truncation notice for anything the completion
    // handler had to spill to disk. Proof: the notice must cite the FULL
    // body's length (bigger than the cap), not the capped copy's.
    const huge = 'z'.repeat(RAW_REPORT_CAP_CHARS + 5_000);
    const model = scriptedModel([stream(...textChunks('t', huge), finishChunk('stop'))]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => null, async () => null, async () => null,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const events = collect();

    await host.spawnSpecialistBackground('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root,
      parentToolCallId: 'tc-1', description: 'find the config loader', token: { parentId: 'root-1', writer: false },
    });

    await vi.waitFor(() => {
      expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
    });
    const injected = events.find((e) => e.data?.injected === 'specialist-report')!;
    // The notice must cite the REAL total (the spilled file's length), not
    // the ledger's capped copy — proof delivery read reportPath back rather
    // than formatting from rec.rawReport alone.
    expect(injected.data.text).toContain(`of ${huge.length} chars`);
    expect(injected.data.text).not.toContain(`of ${RAW_REPORT_CAP_CHARS} chars`);
  });

  it('Finding 2: a background completion-write failure does not strand the report — a retry recovers it and still delivers it to the parent', async () => {
    // runDelegation's own completion write (ledger.update, inside its own
    // try/catch) is deliberately log-only on failure. Before this fix,
    // NOTHING downstream of runDelegation on the background path ever
    // captured the resolved run — a failed write left the ledger record
    // stuck at 'running' forever: never claimed (claimUndelivered only
    // selects 'completed'/'failed'), never delivered, never even surfaced as
    // a failure. This simulates exactly that write failing, then proves the
    // report still reaches the parent.
    const model = scriptedModel([
      stream(...textChunks('t', 'REPORT: done via background'), finishChunk('stop')),
    ]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => null, async () => null, async () => null,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });
    const events = collect();

    const ledger = (host as any).ledger;
    const realUpdate = ledger.update.bind(ledger);
    let primaryWriteAttempts = 0;
    // Fail ONLY the primary completion write (status: 'completed' with a
    // report body) — every other ledger.update call (e.g. confirmDelivered's
    // bare { delivered: true } patch) goes through untouched, so this pins
    // the retry's recovery, not a coincidentally-broken ledger overall.
    vi.spyOn(ledger, 'update').mockImplementation(async (...args: any[]) => {
      const [parentCwd, parentId, childId, patch] = args as [string, string, string, any];
      if (patch.status === 'completed' && patch.rawReport !== undefined) {
        primaryWriteAttempts++;
        throw new Error('simulated disk failure while recording specialist completion');
      }
      return realUpdate(parentCwd, parentId, childId, patch);
    });

    const { childId } = await host.spawnSpecialistBackground('root-1', {
      specialist: EXPLORER, prompt: 'find the config loader and report where it lives', workDir: root,
      parentToolCallId: 'tc-1', description: 'find the config loader', token: { parentId: 'root-1', writer: false },
    });

    // The parent still learns the truth: the report is injected once the
    // retry recovers the record, delivered at the next idle boundary.
    await vi.waitFor(() => {
      expect(events.filter((e) => e.data?.injected === 'specialist-report')).toHaveLength(1);
    });
    const injected = events.find((e) => e.data?.injected === 'specialist-report')!;
    expect(injected.data.text).toContain('REPORT: done via background');

    // The ledger record itself reflects the recovered completion — never a
    // 'running' row stranded where nothing will ever claim it.
    const rec = ledger.listFor(root, 'root-1').find((d: any) => d.childId === childId);
    expect(rec.status).toBe('completed');
    expect(rec.delivered).toBe(true);
    expect(primaryWriteAttempts).toBeGreaterThan(0); // the primary write really did fail first
  });

  it('Finding 3: a destroy() racing the delivery loop leaves the report claimable again, never falsely confirmed', async () => {
    // The pre-existing queue-drain loop rechecks `this.live.get(sessionId)
    // !== entry` after every turn because destroy() can land mid-turn. The
    // delivery loop reused the same captured `entry` across three awaits
    // with no equivalent recheck — HarnessSession.destroy() aborts and
    // removeAllListeners()s (which is what actually stops appends being
    // persisted) WITHOUT throwing and WITHOUT setting any flag runNotice
    // checks, so an orphaned runNotice() call completes normally, having
    // shown the report to nobody. Simulate that exact "resolves normally on
    // a dead session" shape directly (rather than fighting HarnessSession's
    // real abort timing) by overriding the live session's own runNotice with
    // a manually-gated stub, destroying the parent while it's paused
    // mid-call, then releasing it.
    const model = scriptedModel([stream(finishChunk('stop'))]);
    const home = new NativeHome(root);
    store = new SessionStore(home);
    host = new NativeSessionHost(
      store, async () => model as any, async () => null, async () => null, async () => null,
      undefined, undefined, undefined, undefined, undefined, home,
    );
    await host.create({ sessionId: 'root-1', cwd: root, binding: { providerId: 'openrouter', modelId: 'm' } });

    const ledger = (host as any).ledger;
    await ledger.recordStart(root, 'root-1', {
      childId: 'child-x', parentToolCallId: 'tc', agentType: EXPLORER.id, title: 'Test child-x', workDir: root,
      description: 'a test brief', background: true, status: 'running', startedAt: Date.now(),
      delivered: false, owner: OWNER, missedSteers: [],
    });
    await ledger.update(root, 'root-1', 'child-x', { status: 'completed', endedAt: Date.now(), steps: 1, rawReport: 'REPORT: done' });

    const entry = (host as any).live.get('root-1');
    let enteredNotice = false;
    let releaseGate: () => void = () => {};
    const gate = new Promise<void>((res) => { releaseGate = res; });
    // Replace the live session's runNotice with a stub that pauses mid-call
    // (mirrors runNotice being suspended on an in-flight provider stream) and
    // then RESOLVES NORMALLY (no throw) once released — exactly the "no
    // throw" shape the WHY comment on the fix names.
    entry.session.runNotice = vi.fn(async () => { enteredNotice = true; await gate; });

    (host as any).queueDelivery('root-1');
    await vi.waitFor(() => expect(enteredNotice).toBe(true));

    // destroy() lands WHILE the delivery loop is awaiting runNotice — the
    // exact race the fix closes.
    await host.destroy('root-1');
    releaseGate();

    // The record must come back CLAIMABLE (not confirmed delivered): status
    // stays 'completed', delivered stays false, and the lease was released
    // rather than left dangling.
    await vi.waitFor(() => {
      const rec = ledger.listFor(root, 'root-1').find((d: any) => d.childId === 'child-x');
      expect(rec?.claimedBy).toBeUndefined();
    });
    const rec = ledger.listFor(root, 'root-1').find((d: any) => d.childId === 'child-x');
    expect(rec.status).toBe('completed');
    expect(rec.delivered).toBe(false);
  });
});
