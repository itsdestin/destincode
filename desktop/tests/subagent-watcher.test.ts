import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { SubagentIndex } from '../src/main/subagent-index';
import { SubagentWatcher } from '../src/main/subagent-watcher';
import type { TranscriptEvent } from '../src/shared/types';

function writeMeta(dir: string, agentId: string, description: string, agentType: string) {
  fs.writeFileSync(
    path.join(dir, `agent-${agentId}.meta.json`),
    JSON.stringify({ description, agentType }),
  );
}

function appendLine(dir: string, agentId: string, obj: any) {
  fs.appendFileSync(
    path.join(dir, `agent-${agentId}.jsonl`),
    JSON.stringify(obj) + '\n',
  );
}

function toolUseLine(uuid: string, toolUseId: string, toolName: string, input: any) {
  return {
    type: 'assistant',
    uuid,
    isSidechain: true,
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: toolUseId, name: toolName, input }],
      stop_reason: null,
    },
  };
}

// Fixed sleep. ONLY valid before a NEGATIVE assertion ("nothing was emitted"),
// where there is no condition to poll for — a too-short sleep there fails safe
// (the assertion still holds). NEVER sleep before a POSITIVE assertion: the
// watcher's reads are async and fs.watch delivery is load-dependent (macOS
// FSEvents coalescing, Windows under vitest's parallel pool), so a fixed budget
// is a bet that loses as the machine gets busy — that was this file's flake.
// Use `vi.waitFor(...)` to poll until the condition actually holds instead.
function wait(ms = 50): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

// Generous ceilings — these only bound the FAILURE case. A passing assertion
// returns as soon as it holds, so raising them costs nothing on green runs.
const SETTLE_MS = 5_000;   // in-process: watcher read + emit
const WATCH_MS = 15_000;   // fs.watch/stat-poll delivery of an external write

describe('SubagentWatcher', () => {
  let tmpRoot: string;
  let subagentsDir: string;
  let index: SubagentIndex;
  let emitted: TranscriptEvent[];
  let watcher: SubagentWatcher;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-watcher-'));
    subagentsDir = path.join(tmpRoot, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    index = new SubagentIndex();
    emitted = [];
    watcher = new SubagentWatcher({
      sessionId: 'sess-1',
      subagentsDir,
      index,
      emit: e => emitted.push(e),
    });
  });

  afterEach(() => {
    watcher.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('replays an existing subagent file on start', async () => {
    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));

    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    watcher.start();
    await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: SETTLE_MS });

    expect(emitted[0].type).toBe('tool-use');
    expect(emitted[0].data.parentAgentToolUseId).toBe('toolu_parent');
    expect(emitted[0].data.agentId).toBe('abc');
    expect(emitted[0].data.toolUseId).toBe('toolu_X');
  });

  it('picks up a subagent file that appears after start', async () => {
    watcher.start();
    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');

    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));

    // Was `await wait(1500) // allow fs.watch/poll to fire`, which failed every
    // macOS build: FSEvents coalescing latency exceeds 1500ms under runner load.
    // Poll for the event instead of betting on a fixed budget.
    await vi.waitFor(() => {
      const stamped = emitted.find(e => e.type === 'tool-use');
      expect(stamped?.data.parentAgentToolUseId).toBe('toolu_parent');
    }, { timeout: WATCH_MS });
  });

  it('streams new lines appended to an existing subagent file', async () => {
    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));

    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    watcher.start();
    await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: SETTLE_MS });

    appendLine(subagentsDir, 'abc', toolUseLine('u2', 'toolu_Y', 'Grep', { pattern: 'foo' }));
    // fs.watch delivery of the append — poll, don't sleep (see wait() above).
    await vi.waitFor(() => {
      expect(emitted.find(e => e.data.toolName === 'Grep')).toBeDefined();
    }, { timeout: WATCH_MS });

    expect(emitted.length).toBeGreaterThanOrEqual(2);
    const grep = emitted.find(e => e.data.toolName === 'Grep');
    expect(grep?.data.parentAgentToolUseId).toBe('toolu_parent');
    expect(grep?.data.agentId).toBe('abc');
  });

  it('buffers events when no parent binding exists, flushes when parent arrives', async () => {
    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));

    watcher.start();
    await wait(100);
    // Negative assertion, so the fixed sleep is fine: with no parent binding the
    // watcher CANNOT emit, whether or not its read has landed yet.
    expect(emitted).toHaveLength(0); // buffered

    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    // Retry the flush rather than flushing once behind a fixed sleep: the read
    // is async, so under load the single flush ran against an empty buffer and
    // the assertion below never saw the event. A flush with nothing pending is a
    // no-op, so retrying is safe.
    await vi.waitFor(() => {
      watcher.flushPendingFor('abc');
      expect(emitted).toHaveLength(1);
    }, { timeout: SETTLE_MS });
    expect(emitted[0].data.parentAgentToolUseId).toBe('toolu_parent');
  });

  it('dedups on re-reading the same lines (seen-uuid window)', async () => {
    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));

    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    watcher.start();
    await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: SETTLE_MS });

    // Simulate file-size shrink then re-growth (e.g. poll triggers redundant read).
    watcher.forceRereadFor('abc');
    await wait(50); // negative assertion below — a fixed settle is correct here
    expect(emitted).toHaveLength(1); // no duplicate emit
  });

  it('getHistory yields all events from all subagent files for replay', () => {
    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));
    writeMeta(subagentsDir, 'def', 'Other', 'Plan');
    appendLine(subagentsDir, 'def', toolUseLine('u2', 'toolu_Y', 'Grep', { pattern: 'foo' }));

    const historyIndex = new SubagentIndex();
    historyIndex.recordParentAgentToolUse('toolu_P1', 'Find bug', 'Explore');
    historyIndex.recordParentAgentToolUse('toolu_P2', 'Other', 'Plan');

    const events = watcher.getHistory(historyIndex);
    expect(events.length).toBe(2);
    const byTool: Record<string, TranscriptEvent> = {};
    for (const e of events) byTool[e.data.toolName!] = e;
    expect(byTool['Read'].data.parentAgentToolUseId).toBe('toolu_P1');
    expect(byTool['Read'].data.agentId).toBe('abc');
    expect(byTool['Grep'].data.parentAgentToolUseId).toBe('toolu_P2');
    expect(byTool['Grep'].data.agentId).toBe('def');
  });

  it('live-path flush: buffered subagent events emit in order after parent arrives', async () => {
    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));
    appendLine(subagentsDir, 'abc', toolUseLine('u2', 'toolu_Y', 'Grep', { pattern: 'foo' }));

    watcher.start();
    await wait(100);
    // Negative — safe as a fixed sleep (no parent binding ⇒ no emit possible).
    expect(emitted).toHaveLength(0); // both lines buffered, no parent yet

    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    // Retry the flush until the async read has buffered both lines. This is the
    // exact case that failed on Windows under vitest's parallel pool: the read
    // landed after the fixed 100ms sleep, so flushAllPending() found an empty
    // buffer and the length-2 assertion below saw nothing.
    await vi.waitFor(() => {
      watcher.flushAllPending();
      expect(emitted).toHaveLength(2);
    }, { timeout: SETTLE_MS });
    // Preserved order: first buffered event still emits first.
    expect(emitted[0].data.toolName).toBe('Read');
    expect(emitted[1].data.toolName).toBe('Grep');
    // Both stamped with the correct parent.
    expect(emitted[0].data.parentAgentToolUseId).toBe('toolu_parent');
    expect(emitted[1].data.parentAgentToolUseId).toBe('toolu_parent');
    expect(emitted[0].data.agentId).toBe('abc');
  });
});

// ---------------------------------------------------------------------------
// UTF-8 boundary safety (2026-07-10 review) — mirrors the TranscriptWatcher
// byte-carry fix: a multi-byte char split across two reads must reassemble.
// ---------------------------------------------------------------------------
describe('SubagentWatcher read integrity', () => {
  let tmpRoot: string;
  let subagentsDir: string;
  let index: SubagentIndex;
  let emitted: TranscriptEvent[];
  let watcher: SubagentWatcher;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-utf8-'));
    subagentsDir = path.join(tmpRoot, 'subagents');
    fs.mkdirSync(subagentsDir, { recursive: true });
    index = new SubagentIndex();
    emitted = [];
    watcher = new SubagentWatcher({
      sessionId: 'sess-utf8',
      subagentsDir,
      index,
      emit: e => emitted.push(e),
    });
  });

  afterEach(() => {
    watcher.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('preserves a multi-byte UTF-8 character split across two reads', async () => {
    writeMeta(subagentsDir, 'utf8', 'Emoji task', 'claude');
    index.recordParentAgentToolUse('toolu_parent_utf8', 'Emoji task', 'claude');

    const line = JSON.stringify({
      type: 'assistant',
      uuid: 'u-emoji',
      isSidechain: true,
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'result 😀 done' }],
        stop_reason: null,
      },
    });
    const full = Buffer.from(line + '\n', 'utf8');
    const emojiStart = full.indexOf(Buffer.from('😀', 'utf8'));
    const splitAt = emojiStart + 2;
    const jsonlPath = path.join(subagentsDir, 'agent-utf8.jsonl');

    // First half (cut mid-emoji), then start + read — leaves a partial carry.
    fs.writeFileSync(jsonlPath, full.subarray(0, splitAt));
    watcher.start();
    await wait(150);
    expect(emitted).toHaveLength(0);

    // Second half completes the line. Poll the reread until the carried bytes
    // reassemble (was a 20x50ms loop — a 1s ceiling is the same fixed-budget bet).
    fs.appendFileSync(jsonlPath, full.subarray(splitAt));
    await vi.waitFor(() => {
      watcher.forceRereadFor('utf8');
      expect(emitted.length).toBeGreaterThan(0);
    }, { timeout: SETTLE_MS });

    const text = emitted.find(e => e.type === 'assistant-text');
    expect(text).toBeDefined();
    expect(text!.data.text).toContain('😀');
    expect(text!.data.text).not.toContain('�');
  });
});

// ---------------------------------------------------------------------------
// Timer lifecycle (2026-07-10 perf pass): event-driven kick + poll settle.
// The old behavior leaked one 1s dir poll per session forever (even sessions
// that never ran a subagent) and a 2s stat-poll per subagent file that was
// never pruned — the main "idle CPU creeps up over a long day" candidate.
// ---------------------------------------------------------------------------
describe('SubagentWatcher timer lifecycle', () => {
  let tmpRoot: string;
  let subagentsDir: string;
  let index: SubagentIndex;
  let emitted: TranscriptEvent[];
  let watcher: SubagentWatcher;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-timers-'));
    subagentsDir = path.join(tmpRoot, 'subagents');
    index = new SubagentIndex();
    emitted = [];
    watcher = new SubagentWatcher({
      sessionId: 'sess-timers',
      subagentsDir,
      index,
      emit: e => emitted.push(e),
    });
  });

  afterEach(() => {
    watcher.stop();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('kickScan discovers a brand-new subagent dir immediately (no poll wait)', async () => {
    // Dir does not exist at start — the bootstrap poll is now slow (5s), so
    // without the kick the first subagent's output would sit undiscovered.
    watcher.start();

    fs.mkdirSync(subagentsDir, { recursive: true });
    writeMeta(subagentsDir, 'kick', 'Kicked task', 'claude');
    index.recordParentAgentToolUse('toolu_parent_kick', 'Kicked task', 'claude');
    appendLine(subagentsDir, 'kick', toolUseLine('u-kick', 'toolu_K', 'Read', { file_path: '/k' }));

    watcher.kickScan();
    await vi.waitFor(() => {
      expect(emitted.some(e => e.data.agentId === 'kick')).toBe(true);
    }, { timeout: SETTLE_MS });
  });

  it('settleByParent stops the file poll but keeps fs.watch delivering late writes', async () => {
    fs.mkdirSync(subagentsDir, { recursive: true });
    writeMeta(subagentsDir, 'done', 'Finished task', 'claude');
    index.recordParentAgentToolUse('toolu_parent_done', 'Finished task', 'claude');
    appendLine(subagentsDir, 'done', toolUseLine('u-d1', 'toolu_D1', 'Read', { file_path: '/d' }));

    watcher.start();
    await vi.waitFor(() => expect(emitted.length).toBeGreaterThanOrEqual(1), { timeout: SETTLE_MS });
    expect(watcher.hasActivePoll('done')).toBe(true);

    await watcher.settleByParent('toolu_parent_done');
    expect(watcher.hasActivePoll('done')).toBe(false);

    // Late write after settle must still arrive (fs.watch stays attached —
    // the settle only removes the belt-and-suspenders stat poll).
    const before = emitted.length;
    appendLine(subagentsDir, 'done', toolUseLine('u-d2', 'toolu_D2', 'Grep', { pattern: 'x' }));
    // fs.watch delivery of an external append — the old 20x50ms (1s) ceiling was
    // far under macOS FSEvents coalescing latency on a loaded runner.
    await vi.waitFor(() => expect(emitted.length).toBeGreaterThan(before), { timeout: WATCH_MS });
  });

  it('settleByParent for an unknown parent is a harmless no-op', async () => {
    watcher.start();
    await expect(watcher.settleByParent('toolu_never_seen')).resolves.toBeUndefined();
  });
});
