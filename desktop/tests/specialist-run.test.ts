import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { NativeHome } from '../src/main/native-home';
import { SessionStore } from '../src/main/harness/session-store';
import { NativeSessionHost } from '../src/main/harness/native-session-host';
import { scriptedModel, stream, textChunks, multiDeltaTextChunks, toolCallChunk, finishChunk } from './helpers/scripted-model';
import { resolveSpecialist } from '../src/main/harness/specialists/registry';

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
    expect(host.isSpecialistWriterBusy('root-1')).toBe(false);
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
    expect(host.isSpecialistWriterBusy('root-1')).toBe(false);
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
});
