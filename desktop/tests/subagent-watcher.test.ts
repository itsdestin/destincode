import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

function wait(ms = 50): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

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
    await wait(100);

    expect(emitted).toHaveLength(1);
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
    await wait(1500); // allow fs.watch/poll to fire

    const stamped = emitted.find(e => e.type === 'tool-use');
    expect(stamped?.data.parentAgentToolUseId).toBe('toolu_parent');
  });

  it('streams new lines appended to an existing subagent file', async () => {
    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));

    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    watcher.start();
    await wait(100);
    expect(emitted).toHaveLength(1);

    appendLine(subagentsDir, 'abc', toolUseLine('u2', 'toolu_Y', 'Grep', { pattern: 'foo' }));
    await wait(1500);

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
    expect(emitted).toHaveLength(0); // buffered

    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    watcher.flushPendingFor('abc');
    await wait(50);

    expect(emitted).toHaveLength(1);
    expect(emitted[0].data.parentAgentToolUseId).toBe('toolu_parent');
  });

  it('dedups on re-reading the same lines (seen-uuid window)', async () => {
    writeMeta(subagentsDir, 'abc', 'Find bug', 'Explore');
    appendLine(subagentsDir, 'abc', toolUseLine('u1', 'toolu_X', 'Read', { file_path: '/a' }));

    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    watcher.start();
    await wait(100);
    expect(emitted).toHaveLength(1);

    // Simulate file-size shrink then re-growth (e.g. poll triggers redundant read).
    watcher.forceRereadFor('abc');
    await wait(50);
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
    expect(emitted).toHaveLength(0); // both lines buffered, no parent yet

    index.recordParentAgentToolUse('toolu_parent', 'Find bug', 'Explore');
    watcher.flushAllPending();
    await wait(50);

    expect(emitted).toHaveLength(2);
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

    // Second half completes the line.
    fs.appendFileSync(jsonlPath, full.subarray(splitAt));
    for (let i = 0; i < 20 && emitted.length === 0; i++) {
      watcher.forceRereadFor('utf8');
      await wait(50);
    }

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
    await wait(150);

    expect(emitted.some(e => e.data.agentId === 'kick')).toBe(true);
  });

  it('settleByParent stops the file poll but keeps fs.watch delivering late writes', async () => {
    fs.mkdirSync(subagentsDir, { recursive: true });
    writeMeta(subagentsDir, 'done', 'Finished task', 'claude');
    index.recordParentAgentToolUse('toolu_parent_done', 'Finished task', 'claude');
    appendLine(subagentsDir, 'done', toolUseLine('u-d1', 'toolu_D1', 'Read', { file_path: '/d' }));

    watcher.start();
    await wait(150);
    expect(emitted.length).toBeGreaterThanOrEqual(1);
    expect(watcher.hasActivePoll('done')).toBe(true);

    await watcher.settleByParent('toolu_parent_done');
    expect(watcher.hasActivePoll('done')).toBe(false);

    // Late write after settle must still arrive (fs.watch stays attached —
    // the settle only removes the belt-and-suspenders stat poll).
    const before = emitted.length;
    appendLine(subagentsDir, 'done', toolUseLine('u-d2', 'toolu_D2', 'Grep', { pattern: 'x' }));
    for (let i = 0; i < 20 && emitted.length === before; i++) await wait(50);
    expect(emitted.length).toBeGreaterThan(before);
  });

  it('settleByParent for an unknown parent is a harmless no-op', async () => {
    watcher.start();
    await expect(watcher.settleByParent('toolu_never_seen')).resolves.toBeUndefined();
  });
});
