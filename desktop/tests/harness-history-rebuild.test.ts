// Task 10 — the RESUME contract (spec §2.5). rebuildHistory() must reconstruct
// the SAME ModelMessage[] the driver accumulated live, from nothing but the
// persisted transcript events. The deep-equal assertions below are the ARBITER
// of every grouping choice in both harness-session.ts (the live pushes) and
// history-rebuild.ts (the replay): if the two ever diverge on a COMPLETED turn,
// one side is wrong. Interrupt partials are the one documented exception —
// pinned as semantic (same text), not byte-identical, form (see that test).
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { HarnessSession, type HarnessSessionOpts } from '../src/main/harness/harness-session';
import { rebuildHistory } from '../src/main/harness/history-rebuild';
import { NativeHome } from '../src/main/native-home';
import { SessionStore, type NativeSessionHeader } from '../src/main/harness/session-store';
import type { HarnessManifest } from '../src/shared/harness-manifest';
import type { NativeTool } from '../src/main/harness/tools/types';
import type { TranscriptEvent } from '../src/shared/types';
import type { PermissionDecision } from '../src/shared/permission-types';
import type { AskDecision } from '../src/main/harness/permission-broker';
import { MockLanguageModelV4 } from 'ai/test';
import { textChunks, toolCallChunk, finishChunk, stream, scriptedModel } from './helpers/scripted-model';

// Permissive fake tool (mirrors the loop suite's helper) — records executions,
// subject undefined so tool-layer guards are skipped and decide() is the gate.
function fakeTool(name: string, over: { onExecute?: (a: any, c: any) => any } = {}): NativeTool {
  return {
    name,
    description: `fake ${name}`,
    inputSchema: z.object({ file_path: z.string() }),
    permissionSubject: () => undefined,
    async execute(args, ctx) {
      if (over.onExecute) return over.onExecute(args, ctx);
      return { text: `${name} ran` };
    },
  };
}

function collect(session: HarnessSession): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
  return events;
}

const HARNESS: HarnessManifest = {
  schema: 1, id: 'agent', name: 'Agent', systemPrompt: 'sys', tools: [],
  permissionPolicy: 'ask', limits: { maxTokens: 256 },
};
function makeOpts(over: Partial<HarnessSessionOpts>): HarnessSessionOpts {
  return {
    sessionId: 's-1', cwd: 'C:/x', harness: HARNESS,
    binding: { providerId: 'openrouter', modelId: 'm' },
    retryDelays: [1, 1, 1],
    ...over,
  } as HarnessSessionOpts;
}
const ALLOW: PermissionDecision = { action: 'allow', denyListed: false };

const HEADER: NativeSessionHeader = {
  v: 1, sessionId: 's-1', harnessId: 'chat',
  binding: { providerId: 'openrouter', modelId: 'm' }, cwd: 'C:/proj', createdAt: 1,
};

/** Persist the emitted events through a REAL SessionStore and read them back —
 *  this is exactly what NativeSessionHost.resume feeds rebuildHistory (deltas
 *  coalesced per partId, tool events verbatim). Proves the production resume
 *  path — not just the raw in-memory stream — reconstructs history faithfully. */
async function throughStore(events: TranscriptEvent[]): Promise<TranscriptEvent[]> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-rebuild-'));
  try {
    const store = new SessionStore(new NativeHome(root));
    await store.create(HEADER);
    for (const e of events) await store.append(HEADER.cwd, { ...e, sessionId: 's-1' } as any);
    await store.flushAll();
    return store.readEvents('s-1', HEADER.cwd);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('rebuildHistory — the resume deep-equal contract', () => {
  it('two-step tool turn: rebuild(emitted) deep-equals the live history', async () => {
    const read = fakeTool('Read');
    const model = scriptedModel([
      stream(...textChunks('a', 'Let me read.'), toolCallChunk('c1', 'Read', { file_path: 'x.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'All done.'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    await session.send('go');

    const live = (session as any).history as any[];

    // (1) Raw emitted stream rebuilds to the live history byte-for-byte. (The
    // single-delta mock means each partId appears once, so the raw stream
    // already matches what the store coalesces.)
    expect(rebuildHistory(events)).toEqual(live);

    // (2) The PRODUCTION path — events persisted and read back through the store
    // — rebuilds identically. This is what resume() actually does.
    expect(rebuildHistory(await throughStore(events))).toEqual(live);

    // Sanity: the live history really is the multi-step tool shape we expect.
    expect(live).toEqual([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Let me read.' },
        { type: 'tool-call', toolCallId: 'c1', toolName: 'Read', input: { file_path: 'x.ts' } },
      ] },
      { role: 'tool', content: [
        { type: 'tool-result', toolCallId: 'c1', toolName: 'Read', output: { type: 'text', value: 'Read ran' } },
      ] },
      { role: 'assistant', content: [{ type: 'text', text: 'All done.' }] },
    ]);
  });

  it('multi-step: step 2 text does NOT merge into step 1 assistant message', async () => {
    // Two tool steps then a text stop → three assistant/tool boundaries. The
    // tool-result between steps must flush step 1, so step 2 opens a fresh
    // assistant message (the exact grouping bug rebuildHistory is designed against).
    const read = fakeTool('Read');
    const model = scriptedModel([
      stream(...textChunks('a', 'step1'), toolCallChunk('c1', 'Read', { file_path: 'a.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'step2'), toolCallChunk('c2', 'Read', { file_path: 'b.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('c', 'final'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    const live = (session as any).history as any[];
    const rebuilt = rebuildHistory(events);
    expect(rebuilt).toEqual(live);
    // 'step2' lives in its OWN assistant message, never appended to 'step1'.
    const assistantTexts = rebuilt
      .filter((m) => m.role === 'assistant' && Array.isArray(m.content))
      .map((m) => (m.content as any[]).filter((p) => p.type === 'text').map((p) => p.text).join(''));
    expect(assistantTexts).toEqual(['step1', 'step2', 'final']);
  });

  it('text-only turn rebuilds exactly like v0 (plain user/assistant exchange)', async () => {
    const model = scriptedModel([stream(...textChunks('a', 'Hi there'), finishChunk('stop'))]);
    const session = new HarnessSession(makeOpts({}), async () => model as any); // no tools → v0 path
    const events = collect(session);
    await session.send('hi');
    const live = (session as any).history as any[];
    const rebuilt = rebuildHistory(events);
    expect(rebuilt).toEqual(live);
    // Semantically identical to v0's bare-string assistant message — streamText
    // accepts both the array and bare-string forms (Task 1 contract).
    expect(rebuilt).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hi there' }] },
    ]);
  });

  it('skips event types that never enter model history (thinking, compact-summary, unknown)', () => {
    const mk = (type: string, data: any): TranscriptEvent => ({ type: type as any, sessionId: 's-1', uuid: type, timestamp: 0, data });
    const rebuilt = rebuildHistory([
      mk('user-message', { text: 'q' }),
      mk('assistant-thinking', { text: 'reasoning...', partId: 'r1' }), // reasoning never entered history
      mk('assistant-text', { text: 'answer', partId: 'p1' }),
      mk('compact-summary', { summary: 'compacted' }),                  // display-only marker
      mk('future-unknown-type', { text: 'ignore me' }),                // forward-compat: skipped
      mk('turn-complete', { stopReason: 'end_turn' }),
    ]);
    expect(rebuilt).toEqual([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
    ]);
  });

  it('seedHistory clears readRegistry + todos on resume (read-registry is NOT reconstructed)', async () => {
    // The reset-on-resume ruling (spec §2.5): read-before-edit mtimes and the
    // todo list are per-session RUNTIME state, never persisted. A resumed
    // session must start with neither — a stale mtime could wrongly satisfy the
    // read-before-edit gate on the first edit after resume.
    const session = new HarnessSession(makeOpts({ tools: [fakeTool('Read')] }), async () => ({} as any));
    (session as any).readRegistry.set('C:/proj/a.ts', 123456);
    (session as any).todos.push({ content: 'stale', status: 'pending', activeForm: 'x' });

    const events: TranscriptEvent[] = [
      { type: 'user-message', sessionId: 's-1', uuid: 'u', timestamp: 0, data: { text: 'hi' } },
      { type: 'assistant-text', sessionId: 's-1', uuid: 'a', timestamp: 0, data: { text: 'ok', partId: 'p1' } },
      { type: 'turn-complete', sessionId: 's-1', uuid: 't', timestamp: 0, data: {} },
    ];
    session.seedHistory(rebuildHistory(events));

    expect((session as any).readRegistry.size).toBe(0); // NOT reconstructed
    expect((session as any).todos.length).toBe(0);
    // History itself WAS seeded from the events.
    expect((session as any).history).toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
    ]);
  });

  it('interrupt partial: SEMANTIC equivalence (same text), not byte-identical form', async () => {
    // Live: the interrupt path pushes a BARE-STRING assistant message (the
    // partial). Rebuild produces the ARRAY form ([{type:'text',text}]) from the
    // emitted assistant-text event. Both are accepted by streamText (Task 1), so
    // this divergence is acceptable — but ONLY for interrupt partials, and the
    // assertion here is honest about it: same text content, different container.
    const never = new ReadableStream({
      start(controller) {
        controller.enqueue({ type: 'stream-start', warnings: [] });
        controller.enqueue({ type: 'text-start', id: 'p1' });
        controller.enqueue({ type: 'text-delta', id: 'p1', delta: 'partial answer' });
        // never closes → the turn stays in flight until interrupt()
      },
    });
    const model = new MockLanguageModelV4({ doStream: async () => ({ stream: never as any }) });
    const session = new HarnessSession(makeOpts({ tools: [] }), async () => model as any);
    const events = collect(session);
    const p = session.send('go');
    // Wait until the partial delta has been emitted, then interrupt.
    while (!events.some((e) => e.type === 'assistant-text')) await new Promise((r) => setTimeout(r, 2));
    session.interrupt();
    await p;

    const live = (session as any).history as any[];
    const rebuilt = rebuildHistory(events);

    // Byte-identical form does NOT hold here (bare string vs array) — that's the
    // documented exception.
    expect(rebuilt).not.toEqual(live);

    // Semantic equivalence DOES: same roles, same flattened text per message.
    const flatten = (m: any): string =>
      typeof m.content === 'string' ? m.content
        : (m.content as any[]).filter((p) => p.type === 'text').map((p) => p.text).join('');
    expect(rebuilt.map((m) => m.role)).toEqual(live.map((m) => m.role));
    expect(rebuilt.map(flatten)).toEqual(live.map(flatten));
    expect(flatten(rebuilt[rebuilt.length - 1])).toBe('partial answer');
  });

  it('canceled-ask back-fill round-trips: dangling tool-call gets its tool-result', async () => {
    // The CRITICAL regression from the loop suite, seen through the RESUME lens:
    // a canceled permission ask back-fills a canceled tool-result event, so the
    // persisted transcript carries a matching result for the assistant tool-call.
    // rebuildHistory must therefore reconstruct a valid (non-dangling) history.
    const write = fakeTool('Write');
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: 'x.ts' }), finishChunk('tool-calls')),
    ]);
    const askUser = async (): Promise<AskDecision> => ({ behavior: 'canceled' });
    const session = new HarnessSession(makeOpts({ tools: [write], decide: async () => ({ action: 'ask', denyListed: false }), askUser }), async () => model as any);
    const events = collect(session);
    await session.send('go');

    const rebuilt = rebuildHistory(await throughStore(events));
    // Every assistant tool-call has a matching tool-result in the rebuilt history
    // (a dangling tool_call would make the next provider request 400).
    const callIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const m of rebuilt) {
      if (!Array.isArray(m.content)) continue;
      for (const part of m.content as any[]) {
        if (part?.type === 'tool-call') callIds.add(part.toolCallId);
        if (part?.type === 'tool-result') resultIds.add(part.toolCallId);
      }
    }
    expect(callIds.size).toBeGreaterThan(0);
    for (const id of callIds) expect(resultIds.has(id)).toBe(true);
    expect(rebuilt).toEqual((session as any).history);
  });
});
