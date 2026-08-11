// HarnessSession Phase 2 — the multi-step agentic turn driver (Plan A, Task 9).
// These tests DEFINE the contract for the tool loop: emitted transcript-event
// ORDER, history grouping, the exact permission sequencing (validate → doom →
// guards → decide → ask → execute), budgets (max_steps), doom-loop detection,
// step-level retry, and interrupt semantics. The v0 emit surface is FROZEN —
// this suite only ever asserts existing TranscriptEventType values; max_steps
// and doom_loop surface as permission ASKS (askUser), never as new events.
import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { HarnessSession } from '../src/main/harness/harness-session';
import { MAX_IMAGES_PER_TURN, MAX_IMAGE_BYTES_PER_TURN } from '../src/main/harness/image-support';
import type { HarnessManifest } from '../src/shared/harness-manifest';
import type { TranscriptEvent } from '../src/shared/types';
import type { PermissionDecision } from '../src/shared/permission-types';
import type { AskRequest, AskDecision } from '../src/main/harness/permission-broker';
// Scripted-mock builders live in a shared helper — the history-rebuild test
// (Task 10) drives the same mock model so its deep-equal contract exercises the
// exact grouping this suite pins.
import { textChunks, toolCallChunk, finishChunk, stream, scriptedModel } from './helpers/scripted-model';
// Session-construction scaffolding (HARNESS/makeOpts/fakeTool) lives in a shared
// helper so the profile-driven driver test (Task 5) reuses the exact same setup.
import { HARNESS, makeOpts, fakeTool } from './helpers/harness-fakes';

function collect(session: HarnessSession): TranscriptEvent[] {
  const events: TranscriptEvent[] = [];
  session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
  return events;
}
function types(events: TranscriptEvent[]) { return events.map((e) => e.type); }

const ALLOW: PermissionDecision = { action: 'allow', denyListed: false };

describe('HarnessSession — multi-step turn driver', () => {
  it('happy path: emits user-message → text → tool-use → tool-result → text → turn-complete IN ORDER', async () => {
    const read = fakeTool('Read');
    const model = scriptedModel([
      stream(...textChunks('a', 'Let me read.'), toolCallChunk('c1', 'Read', { file_path: 'x.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'All done.'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    await session.send('go');

    expect(types(events)).toEqual([
      'user-message', 'assistant-text', 'tool-use', 'tool-result', 'assistant-text', 'turn-complete',
    ]);
    // Distinct partIds per step's text bubble.
    const texts = events.filter((e) => e.type === 'assistant-text');
    expect(texts[0].data.partId).toBeTruthy();
    expect(texts[1].data.partId).toBeTruthy();
    expect(texts[1].data.partId).not.toBe(texts[0].data.partId);
    // tool-use / tool-result carry the Read call.
    const use = events.find((e) => e.type === 'tool-use')!;
    expect(use.data.toolName).toBe('Read');
    expect(use.data.toolInput).toEqual({ file_path: 'x.ts' });
    const res = events.find((e) => e.type === 'tool-result')!;
    expect(res.data.toolName).toBe('Read');
    expect(res.data.isError).toBe(false);
    expect(res.data.toolResult).toBe('Read ran');
    // The tool actually executed.
    expect((read as any).calls).toHaveLength(1);
  });

  it('builds history: user / assistant(text+tool-call) / tool(result) / assistant(text)', async () => {
    const read = fakeTool('Read');
    const seen: any[] = [];
    const model = scriptedModel([
      stream(...textChunks('a', 'reading'), toolCallChunk('c1', 'Read', { file_path: 'x.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'done'), finishChunk('stop')),
    ], seen);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    collect(session);
    await session.send('go');
    // The SECOND step's prompt is the accumulated history — it must contain the
    // assistant tool-call and the tool-result output value.
    const p = JSON.stringify(seen[1]);
    expect(p).toContain('go');            // user
    expect(p).toContain('reading');       // assistant text
    expect(p).toContain('tool-call');     // assistant tool-call part
    expect(p).toContain('Read ran');      // tool-result output value
  });

  it('parallel calls in ONE step: ALL tool-use events precede ALL tool-result events; history is assistant[text,c1,c2] + tool[r1,r2]', async () => {
    // Task 10 seam fix: a multi-call step must emit use(c1),use(c2) FIRST, then
    // result(c1),result(c2) — NOT interleaved use→result→use→result. This is
    // what lets rebuildHistory (pure event-adjacency) reconstruct the SAME
    // step-grouped history the driver pushes (one assistant message with both
    // tool-calls, one tool message with both results).
    const read = fakeTool('Read');
    const model = scriptedModel([
      stream(
        ...textChunks('a', 'reading two'),
        toolCallChunk('c1', 'Read', { file_path: 'a.ts' }),
        toolCallChunk('c2', 'Read', { file_path: 'b.ts' }),
        finishChunk('tool-calls'),
      ),
      stream(...textChunks('b', 'done'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    // Event order: both uses, THEN both results (in call order).
    const toolEvents = events.filter((e) => e.type === 'tool-use' || e.type === 'tool-result');
    expect(toolEvents.map((e) => `${e.type}:${e.data.toolUseId}`)).toEqual([
      'tool-use:c1', 'tool-use:c2', 'tool-result:c1', 'tool-result:c2',
    ]);
    // History: ONE assistant message [text, c1, c2], then ONE tool message [r1, r2].
    const history = (session as any).history as any[];
    expect(history[1].role).toBe('assistant');
    expect(history[1].content.map((p: any) => p.type)).toEqual(['text', 'tool-call', 'tool-call']);
    expect(history[1].content.filter((p: any) => p.type === 'tool-call').map((p: any) => p.toolCallId)).toEqual(['c1', 'c2']);
    expect(history[2].role).toBe('tool');
    expect(history[2].content.map((p: any) => p.toolCallId)).toEqual(['c1', 'c2']);
    expect((read as any).calls).toHaveLength(2);   // both executed serially
  });

  it('decide() deny → isError tool-result with the blocked message; model sees refusal; loop continues', async () => {
    const write = fakeTool('Write');
    const seen: any[] = [];
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: 'x.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ], seen);
    const session = new HarnessSession(makeOpts({ tools: [write], decide: async () => ({ action: 'deny', denyListed: false }) }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    const res = events.find((e) => e.type === 'tool-result')!;
    expect(res.data.isError).toBe(true);
    expect(res.data.toolResult).toMatch(/blocked by a permission rule/);
    expect((write as any).calls).toHaveLength(0);       // never executed
    expect(JSON.stringify(seen[1])).toMatch(/blocked by a permission rule/); // model receives it
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);       // loop continued to completion
  });

  it('decide() ask → askUser; allow executes, deny returns "user declined" and does NOT execute', async () => {
    // Scenario A: ask → allow → executes.
    {
      const write = fakeTool('Write');
      const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({ behavior: 'allow' }));
      const model = scriptedModel([
        stream(toolCallChunk('c1', 'Write', { file_path: 'x.ts' }), finishChunk('tool-calls')),
        stream(...textChunks('b', 'ok'), finishChunk('stop')),
      ]);
      const session = new HarnessSession(makeOpts({ tools: [write], decide: async () => ({ action: 'ask', denyListed: false }), askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');
      expect(askUser).toHaveBeenCalledTimes(1);
      expect(askUser.mock.calls[0][0].toolName).toBe('Write');
      expect((write as any).calls).toHaveLength(1);
      expect(events.find((e) => e.type === 'tool-result')!.data.isError).toBe(false);
    }
    // Scenario B: ask → deny → refusal, not executed.
    {
      const write = fakeTool('Write');
      const askUser = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'deny' }));
      const model = scriptedModel([
        stream(toolCallChunk('c1', 'Write', { file_path: 'x.ts' }), finishChunk('tool-calls')),
        stream(...textChunks('b', 'ok'), finishChunk('stop')),
      ]);
      const session = new HarnessSession(makeOpts({ tools: [write], decide: async () => ({ action: 'ask', denyListed: false }), askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');
      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.isError).toBe(true);
      expect(res.data.toolResult).toMatch(/user declined/i);
      expect((write as any).calls).toHaveLength(0);
    }
  });

  it('askUser canceled → user-interrupt, turn ends, NO turn-complete', async () => {
    const write = fakeTool('Write');
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: 'x.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ]);
    const askUser = async (): Promise<AskDecision> => ({ behavior: 'canceled' });
    const session = new HarnessSession(makeOpts({ tools: [write], decide: async () => ({ action: 'ask', denyListed: false }), askUser }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    expect(events.some((e) => e.type === 'user-interrupt')).toBe(true);
    expect(events.some((e) => e.type === 'turn-complete')).toBe(false);
    expect((write as any).calls).toHaveLength(0);
  });

  it('invalid args (schema mismatch) → isError corrective result, tool NOT executed, loop continues', async () => {
    const write = fakeTool('Write', { schema: z.object({ file_path: z.string() }) });
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: 123 }), finishChunk('tool-calls')),  // wrong type
      stream(...textChunks('b', 'fixed'), finishChunk('stop')),
    ]);
    const decide = vi.fn(async () => ALLOW);
    const session = new HarnessSession(makeOpts({ tools: [write], decide }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    const res = events.find((e) => e.type === 'tool-result')!;
    expect(res.data.isError).toBe(true);
    expect(res.data.toolResult).toMatch(/Invalid arguments/);
    expect((write as any).calls).toHaveLength(0);
    expect(decide).not.toHaveBeenCalled();               // validation precedes permission
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);
  });

  it('doom loop: 3 identical calls → askUser(doom_loop); allow resets window, deny → corrective error', async () => {
    // deny path: three identical Read calls, then the doom ask denies.
    {
      const read = fakeTool('Read');
      const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({ behavior: 'deny' }));
      const dup = () => stream(toolCallChunk('c', 'Read', { file_path: 'same.ts' }), finishChunk('tool-calls'));
      const model = scriptedModel([dup(), dup(), dup(), stream(...textChunks('z', 'stop'), finishChunk('stop'))]);
      const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW, askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');
      const doomAsk = askUser.mock.calls.find((c) => c[0].toolName === 'doom_loop');
      expect(doomAsk).toBeTruthy();
      const results = events.filter((e) => e.type === 'tool-result');
      const last = results[results.length - 1];
      expect(last.data.isError).toBe(true);
      expect(last.data.toolResult).toMatch(/repeated 3 times/);   // threshold-accurate (default profile → 3)
      expect((read as any).calls).toHaveLength(2);       // 3rd never executed (doom denied)
    }
    // allow path: doom ask allows, window resets, tool executes.
    {
      const read = fakeTool('Read');
      const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({ behavior: 'allow' }));
      const dup = () => stream(toolCallChunk('c', 'Read', { file_path: 'same.ts' }), finishChunk('tool-calls'));
      const model = scriptedModel([dup(), dup(), dup(), stream(...textChunks('z', 'stop'), finishChunk('stop'))]);
      const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW, askUser }), async () => model as any);
      collect(session);
      await session.send('go');
      expect(askUser.mock.calls.some((c) => c[0].toolName === 'doom_loop')).toBe(true);
      expect((read as any).calls).toHaveLength(3);        // 3rd executed after allow
    }
  });

  it('maxSteps: allow → loop continues (counter resets); deny → turn-complete stopReason max_steps', async () => {
    const twoStepHarness: HarnessManifest = { ...HARNESS, limits: { maxSteps: 2, maxTokens: 256 } };
    // deny path: two tool-calls hit the budget, ask denies → stopReason max_steps.
    {
      const write = fakeTool('Write');
      const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({ behavior: 'deny' }));
      const tc = () => stream(toolCallChunk('c', 'Write', { file_path: 'x.ts' }), finishChunk('tool-calls'));
      const model = scriptedModel([tc(), tc(), tc()]);
      const session = new HarnessSession(makeOpts({ harness: twoStepHarness, tools: [write], decide: async () => ALLOW, askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');
      expect(askUser.mock.calls.some((c) => c[0].toolName === 'max_steps')).toBe(true);
      const done = events.find((e) => e.type === 'turn-complete')!;
      expect(done.data.stopReason).toBe('max_steps');
    }
    // allow path: budget ask allows, counter resets, model then stops normally.
    {
      const write = fakeTool('Write');
      const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({ behavior: 'allow' }));
      const tc = () => stream(toolCallChunk('c', 'Write', { file_path: 'x.ts' }), finishChunk('tool-calls'));
      const model = scriptedModel([tc(), tc(), stream(...textChunks('z', 'stop'), finishChunk('stop'))]);
      const session = new HarnessSession(makeOpts({ harness: twoStepHarness, tools: [write], decide: async () => ALLOW, askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');
      expect(askUser.mock.calls.some((c) => c[0].toolName === 'max_steps')).toBe(true);
      const done = events.find((e) => e.type === 'turn-complete')!;
      expect(done.data.stopReason).toBe('end_turn');    // continued past the budget, ended normally
    }
  });

  it('usage: per-step usages SUM into the turn-complete usage', async () => {
    const read = fakeTool('Read');
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Read', { file_path: 'x.ts' }), finishChunk('tool-calls', 5, 3)),
      stream(...textChunks('b', 'done'), finishChunk('stop', 7, 4)),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    const done = events.find((e) => e.type === 'turn-complete')!;
    expect(done.data.usage).toMatchObject({ inputTokens: 12, outputTokens: 7 });
    expect(typeof done.data.usage!.tokensPerSecond).toBe('number');
  });

  it('interrupt mid-execute: tool sees aborted signal; user-interrupt emitted, no turn-complete', async () => {
    let started = false;
    // A tool that blocks until the abort signal fires (i.e. until interrupt()).
    const slow = fakeTool('Write', {
      onExecute: (_args, ctx) => new Promise((resolve) => {
        started = true;
        ctx.signal.addEventListener('abort', () => resolve({ text: 'Canceled: the user interrupted this operation.', isError: true }));
      }),
    });
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: 'x.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'unreached'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [slow], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    const p = session.send('go');
    // Wait for the tool to start executing, then interrupt.
    while (!started) await new Promise((r) => setTimeout(r, 2));
    session.interrupt();
    await p;
    expect(events.some((e) => e.type === 'user-interrupt')).toBe(true);
    expect(events.some((e) => e.type === 'turn-complete')).toBe(false);
  });

  it('retry: attempt 1 errors immediately, attempt 2 streams clean → completes, no dup events', async () => {
    const retryable = Object.assign(new Error('temporary upstream'), { statusCode: 503 });
    const model = scriptedModel([
      stream({ type: 'error', error: retryable }),                    // attempt 1: immediate error, emits nothing
      stream(...textChunks('a', 'Hello!'), finishChunk('stop')),      // attempt 2: clean
    ]);
    const session = new HarnessSession(makeOpts({ tools: [], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    const texts = events.filter((e) => e.type === 'assistant-text');
    expect(texts.map((e) => e.data.text).join('')).toBe('Hello!');    // no duplicate from attempt 1
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);
    expect(events.some((e) => e.type === 'session-error')).toBe(false);
  });

  it('tool-layer guard: path OUTSIDE cwd forces an ask even when decide() allows (external_directory)', async () => {
    // permissionSubject returns an absolute path outside the session cwd (C:/x)
    // → checkPathGuard verdict 'external' → forced ask, short-circuiting decide().
    const write = fakeTool('Write', { permissionSubject: (a: any) => a.file_path });
    const decide = vi.fn(async () => ALLOW);
    const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({ behavior: 'allow' }));
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: 'C:/other/secrets-elsewhere.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [write], decide, askUser }), async () => model as any);
    collect(session);
    await session.send('go');
    expect(askUser).toHaveBeenCalledTimes(1);            // external forced the ask
    expect(askUser.mock.calls[0][0].toolName).toBe('Write');
    expect(decide).not.toHaveBeenCalled();               // external short-circuits configured decision
    expect((write as any).calls).toHaveLength(1);        // ask allowed → executed
  });

  it('tool-layer guard: a secret path hard-denies BEFORE any permission consultation', async () => {
    // C:/x/.env is a dotenv file → isSensitivePath → checkPathGuard 'deny'.
    const write = fakeTool('Write', { permissionSubject: (a: any) => a.file_path });
    const decide = vi.fn(async () => ALLOW);
    const askUser = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'allow' }));
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: 'C:/x/.env' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [write], decide, askUser }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    const res = events.find((e) => e.type === 'tool-result')!;
    expect(res.data.isError).toBe(true);
    expect(res.data.toolResult).toMatch(/blocked/i);
    expect(decide).not.toHaveBeenCalled();               // guard precedes configuration
    expect(askUser).not.toHaveBeenCalled();
    expect((write as any).calls).toHaveLength(0);         // never executed
  });

  it('CRITICAL regression: a canceled ask back-fills tool-results so the NEXT send ships valid history', async () => {
    const write = fakeTool('Write');
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: 'x.ts' }), finishChunk('tool-calls')),  // turn 1 step 1
      stream(...textChunks('b', 'ok'), finishChunk('stop')),                                    // turn 2 step 1
    ]);
    const askUser = async (): Promise<AskDecision> => ({ behavior: 'canceled' });
    const session = new HarnessSession(makeOpts({ tools: [write], decide: async () => ({ action: 'ask', denyListed: false }), askUser }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    // A synthesized canceled tool-result was emitted (transcript agrees with history).
    const synth = events.find((e) => e.type === 'tool-result' && e.data.toolResult === 'Canceled: the user interrupted this action.');
    expect(synth).toBeTruthy();
    expect(synth!.data.isError).toBe(true);
    expect(synth!.data.toolUseId).toBe('c1');

    // History-shape invariant: NO assistant tool-call without a following tool
    // message carrying a matching toolCallId (a dangling tool_call → provider 400).
    const history = (session as any).history as any[];
    const callIds = new Set<string>();
    const resultIds = new Set<string>();
    for (const m of history) {
      if (!Array.isArray(m.content)) continue;
      for (const part of m.content) {
        if (part?.type === 'tool-call') callIds.add(part.toolCallId);
        if (part?.type === 'tool-result') resultIds.add(part.toolCallId);
      }
    }
    expect(callIds.size).toBeGreaterThan(0);
    for (const id of callIds) expect(resultIds.has(id)).toBe(true);

    // And the follow-up turn must complete cleanly on that valid history.
    await session.send('again');
    expect(events.filter((e) => e.type === 'turn-complete')).toHaveLength(1);
  });

  it('absent askUser on an ask decision → decline RESULT (config error), not an interrupt', async () => {
    const write = fakeTool('Write');
    const model = scriptedModel([
      stream(toolCallChunk('c1', 'Write', { file_path: 'x.ts' }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'ok'), finishChunk('stop')),
    ]);
    // decide → ask, but NO askUser handler wired.
    const session = new HarnessSession(makeOpts({ tools: [write], decide: async () => ({ action: 'ask', denyListed: false }) }), async () => model as any);
    const events = collect(session);
    await session.send('go');
    const res = events.find((e) => e.type === 'tool-result')!;
    expect(res.data.isError).toBe(true);
    expect(res.data.toolResult).toMatch(/No approval handler is wired/);
    expect(events.some((e) => e.type === 'user-interrupt')).toBe(false);   // NOT masqueraded as a cancel
    expect(events.some((e) => e.type === 'turn-complete')).toBe(true);     // loop continues
    expect((write as any).calls).toHaveLength(0);
  });

  describe('interactive tools (AskUserQuestion)', () => {
    // A minimal interactive fake matching the AskUserQuestion contract the driver
    // reads: interactive:true, a questions schema, no permission subject. execute
    // RECORDS so we can prove it is never reached.
    function fakeInteractive(over: Partial<NativeTool> & { schema?: z.ZodType } = {}): NativeTool {
      const calls: any[] = [];
      const t: NativeTool = {
        name: 'AskUserQuestion',
        description: 'ask',
        inputSchema: over.schema ?? z.object({
          questions: z.array(z.object({
            question: z.string().min(1),
            header: z.string().min(1).max(12),
            options: z.array(z.object({ label: z.string().min(1), description: z.string().optional() })).min(2).max(4),
            multiSelect: z.boolean(),
          })).min(1).max(4),
        }),
        permissionSubject: () => undefined,
        interactive: true,
        async execute(args) { calls.push(args); return { text: 'execute reached' }; },
      };
      (t as any).calls = calls;
      return t;
    }
    const oneQuestion = () => ({
      questions: [{ question: 'Which color?', header: 'Color', multiSelect: false, options: [{ label: 'Blue' }, { label: 'Red' }] }],
    });

    it('routes to askUser, skips decide, returns formatted answers; call/result pair recorded; turn ends', async () => {
      const ask = fakeInteractive();
      const decide = vi.fn(async () => ALLOW);
      const askUser = vi.fn(async (_r: AskRequest): Promise<AskDecision> => ({
        behavior: 'allow', updatedInput: { questions: [], answers: { 'Which color?': 'Blue' } },
      }));
      const model = scriptedModel([
        stream(toolCallChunk('c1', 'AskUserQuestion', oneQuestion()), finishChunk('tool-calls')),
        stream(...textChunks('b', 'thanks'), finishChunk('stop')),
      ]);
      const session = new HarnessSession(makeOpts({ tools: [ask], decide, askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');

      expect(askUser).toHaveBeenCalledTimes(1);
      expect(askUser.mock.calls[0][0].toolName).toBe('AskUserQuestion');
      expect(decide).not.toHaveBeenCalled();          // interactive skips decide
      expect((ask as any).calls).toHaveLength(0);      // execute() never reached
      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.isError).toBeFalsy();
      expect(res.data.toolResult).toContain('Blue');
      expect(res.data.toolResult).toContain('Which color?');
      // call/result pair present in history.
      const history = (session as any).history as any[];
      const callIds = new Set<string>(); const resultIds = new Set<string>();
      for (const m of history) {
        if (!Array.isArray(m.content)) continue;
        for (const part of m.content) {
          if (part?.type === 'tool-call') callIds.add(part.toolCallId);
          if (part?.type === 'tool-result') resultIds.add(part.toolCallId);
        }
      }
      expect(callIds.has('c1')).toBe(true);
      expect(resultIds.has('c1')).toBe(true);
      expect(events.some((e) => e.type === 'turn-complete')).toBe(true);   // turn ended
    });

    it('deny (dismissal) → error result telling the model the question was dismissed; loop continues', async () => {
      const ask = fakeInteractive();
      const askUser = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'deny' }));
      const seen: any[] = [];
      const model = scriptedModel([
        stream(toolCallChunk('c1', 'AskUserQuestion', oneQuestion()), finishChunk('tool-calls')),
        stream(...textChunks('b', 'ok'), finishChunk('stop')),
      ], seen);
      const session = new HarnessSession(makeOpts({ tools: [ask], decide: async () => ALLOW, askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');
      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.isError).toBe(true);
      expect(res.data.toolResult).toMatch(/dismiss|without answering/i);
      expect(JSON.stringify(seen[1])).toMatch(/dismiss|without answering/i);   // model sees it on the next step
      expect(events.some((e) => e.type === 'turn-complete')).toBe(true);
    });

    it('canceled (interrupt) → back-filled canceled result + user-interrupt, no turn-complete', async () => {
      const ask = fakeInteractive();
      const askUser = async (): Promise<AskDecision> => ({ behavior: 'canceled' });
      const model = scriptedModel([
        stream(toolCallChunk('c1', 'AskUserQuestion', oneQuestion()), finishChunk('tool-calls')),
        stream(...textChunks('b', 'unreached'), finishChunk('stop')),
      ]);
      const session = new HarnessSession(makeOpts({ tools: [ask], decide: async () => ALLOW, askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');
      // Same unwind as a canceled permission ask: back-filled canceled tool-result + user-interrupt.
      const synth = events.find((e) => e.type === 'tool-result' && e.data.toolResult === 'Canceled: the user interrupted this action.');
      expect(synth).toBeTruthy();
      expect(synth!.data.toolUseId).toBe('c1');
      expect(synth!.data.isError).toBe(true);
      expect(events.some((e) => e.type === 'user-interrupt')).toBe(true);
      expect(events.some((e) => e.type === 'turn-complete')).toBe(false);
    });

    it('multi-call step, interactive cancel on the FIRST call → BOTH calls back-filled canceled + user-interrupt', async () => {
      // A step with two tool-calls; the first is AskUserQuestion and its ask is
      // canceled. The unwind must back-fill canceled results for the AskUserQuestion
      // AND the still-un-executed second call (the "this call AND every remaining
      // call in the step" invariant), else the second tool-call dangles → 400.
      const ask = fakeInteractive();
      const read = fakeTool('Read');
      const askUser = async (): Promise<AskDecision> => ({ behavior: 'canceled' });
      const model = scriptedModel([
        stream(
          toolCallChunk('c1', 'AskUserQuestion', oneQuestion()),
          toolCallChunk('c2', 'Read', { file_path: 'x.ts' }),
          finishChunk('tool-calls'),
        ),
        stream(...textChunks('b', 'unreached'), finishChunk('stop')),
      ]);
      const session = new HarnessSession(makeOpts({ tools: [ask, read], decide: async () => ALLOW, askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');
      // BOTH calls get a back-filled canceled tool-result.
      const canceled = events.filter((e) => e.type === 'tool-result' && e.data.toolResult === 'Canceled: the user interrupted this action.');
      expect(canceled.map((e) => e.data.toolUseId).sort()).toEqual(['c1', 'c2']);
      expect(canceled.every((e) => e.data.isError === true)).toBe(true);
      expect(events.some((e) => e.type === 'user-interrupt')).toBe(true);
      expect(events.some((e) => e.type === 'turn-complete')).toBe(false);
      expect((read as any).calls).toHaveLength(0);   // second call never executed
      // Pairing invariant: every tool-call in history has a matching tool-result.
      const history = (session as any).history as any[];
      const callIds = new Set<string>(); const resultIds = new Set<string>();
      for (const m of history) {
        if (!Array.isArray(m.content)) continue;
        for (const part of m.content) {
          if (part?.type === 'tool-call') callIds.add(part.toolCallId);
          if (part?.type === 'tool-result') resultIds.add(part.toolCallId);
        }
      }
      for (const id of callIds) expect(resultIds.has(id)).toBe(true);
    });

    it('invalid questions shape → corrective validation result; askUser NOT called', async () => {
      const ask = fakeInteractive();
      const askUser = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'allow' }));
      const model = scriptedModel([
        stream(toolCallChunk('c1', 'AskUserQuestion', { questions: [] }), finishChunk('tool-calls')),  // zero questions
        stream(...textChunks('b', 'fixed'), finishChunk('stop')),
      ]);
      const session = new HarnessSession(makeOpts({ tools: [ask], decide: async () => ALLOW, askUser }), async () => model as any);
      const events = collect(session);
      await session.send('go');
      const res = events.find((e) => e.type === 'tool-result')!;
      expect(res.data.isError).toBe(true);
      expect(res.data.toolResult).toMatch(/Invalid arguments/);
      expect(askUser).not.toHaveBeenCalled();          // validation precedes the interactive ask
    });
  });

  it('no tools configured (tools absent) → v0 plain-text turn; no tool plumbing invoked', async () => {
    const decide = vi.fn(async () => ALLOW);
    const askUser = vi.fn(async (): Promise<AskDecision> => ({ behavior: 'allow' }));
    const model = scriptedModel([stream(...textChunks('a', 'Hi there'), finishChunk('stop'))]);
    const session = new HarnessSession(makeOpts({ decide, askUser }), async () => model as any); // no `tools`
    const events = collect(session);
    await session.send('hi');
    expect(types(events)).toEqual(['user-message', 'assistant-text', 'turn-complete']);
    expect(events.some((e) => e.type === 'tool-use')).toBe(false);
    expect(decide).not.toHaveBeenCalled();
    expect(askUser).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// tok/s measures GENERATION, not the turn's wall-clock. Found by the 2026-07-28
// audit: `startedAt` is stamped at the top of the turn and the denominator was
// (now - startedAt), so prefill, tool execution and permission waits all diluted
// it. A turn that generated 300 tokens in 10s of decoding but spent 30s in a
// Bash call reported ~7 tok/s instead of ~30.
// ---------------------------------------------------------------------------
describe('turn-complete tokensPerSecond', () => {
  it('excludes time spent OUTSIDE the stream (tool execution)', async () => {
    const slowTool = fakeTool('Read', {
      onExecute: async () => { await new Promise((r) => setTimeout(r, 120)); return { text: 'done' }; },
    });
    const model = scriptedModel([
      stream(...textChunks('a', 'x'.repeat(80)), toolCallChunk('c1', 'Read', { file_path: 'a.ts' }), finishChunk('tool-calls', 10, 100)),
      stream(...textChunks('b', 'y'.repeat(80)), finishChunk('stop', 10, 100)),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [slowTool], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    await session.send('go');

    const usage = events.find((e) => e.type === 'turn-complete')!.data.usage as any;
    // 200 output tokens. The tool alone burned 120ms of wall-clock; if that were
    // in the denominator the rate would be dragged toward ~1,600 tok/s or below.
    // Generation time is a small fraction of the turn, so the rate must be HIGHER
    // than the wall-clock rate would give.
    expect(usage.tokensPerSecond).toBeGreaterThan(0);
    const wallClockRate = 200 / 0.12;   // an upper bound on what wall-clock could yield
    expect(usage.tokensPerSecond).toBeGreaterThan(wallClockRate);
  });

  it('a turn with no output reports 0 rather than dividing by zero', async () => {
    const model = scriptedModel([stream(finishChunk('stop', 10, 0))]);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events = collect(session);
    await session.send('go');
    const usage = events.find((e) => e.type === 'turn-complete')!.data.usage as any;
    expect(Number.isFinite(usage.tokensPerSecond)).toBe(true);
    expect(usage.tokensPerSecond).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Image tool-results (2026-08-11 spec, Task 5): the driver turns a tool's
// promised image PATHS (ToolResultPayload.images, Task 4) into a canonical
// content-type tool-result output, charging a per-turn budget and deduping
// repeat fetches of an unchanged file — every skip gets a NAMED note in the
// same text the model and transcript both see, so promise and delivery can
// never disagree.
// ---------------------------------------------------------------------------
describe('image tool-results (2026-08-11 spec)', () => {
  // Real files on disk: resolveToolImages calls fs.statSync/readFileSync
  // directly (no injection seam like history-rebuild's fakeReader), so the
  // dedupe/vanish contracts need a real mtime and a real disappearance.
  function tmpImage(dir: string, name: string): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])); // bytes are arbitrary — readImageFromDisk never decodes
    return p;
  }

  it('a delivered image lands as a content-type output AND its path on the event', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-img-'));
    const imgPath = tmpImage(dir, 'x.png');
    const read = fakeTool('Read', { onExecute: () => ({ text: 'Read image', images: [imgPath] }) });
    const model = scriptedModel([
      stream(...textChunks('a', 'reading'), toolCallChunk('c1', 'Read', { file_path: imgPath }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'done'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    const events = collect(session);
    await session.send('go');

    // findLast is ES2023; this file's tsconfig lib target doesn't guarantee it
    // (brief note) — manual reverse-scan via filter().pop() instead.
    const history = (session as any).history as any[];
    const toolMsg = history.filter((m) => m.role === 'tool').pop();
    const output = toolMsg.content[0].output;
    expect(output.type).toBe('content');
    expect(output.value[0]).toEqual({ type: 'text', text: expect.stringContaining('Read image') });
    expect(output.value[1]).toEqual({ type: 'file', mediaType: 'image/png', data: { type: 'data', data: expect.any(Buffer) } });

    const ev = events.find((e) => e.type === 'tool-result');
    expect(ev!.data.images).toEqual([imgPath]);
  });

  it('an unchanged re-fetch is deduped with a named note, no second copy', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-img-'));
    const imgPath = tmpImage(dir, 'x.png');
    const read = fakeTool('Read', { onExecute: () => ({ text: 'Read image', images: [imgPath] }) });
    const model = scriptedModel([
      stream(...textChunks('a', 'reading'), toolCallChunk('c1', 'Read', { file_path: imgPath }), finishChunk('tool-calls')), // turn 1 step 1
      stream(...textChunks('b', 'done'), finishChunk('stop')),                                                               // turn 1 step 2
      stream(...textChunks('c', 'reading again'), toolCallChunk('c2', 'Read', { file_path: imgPath }), finishChunk('tool-calls')), // turn 2 step 1
      stream(...textChunks('d', 'done again'), finishChunk('stop')),                                                         // turn 2 step 2
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    collect(session);
    await session.send('go');
    await session.send('go again');   // same unchanged file, requested again in a second turn

    const history = (session as any).history as any[];
    const toolMsgs = history.filter((m) => m.role === 'tool');
    expect(toolMsgs).toHaveLength(2);
    const secondToolMsg = toolMsgs[toolMsgs.length - 1];   // last tool message of turn 2
    expect(secondToolMsg.content[0].output.type).toBe('text');   // deduped → no second image, stays text-only
    expect(secondToolMsg.content[0].output.value).toContain('already visible earlier');
  });

  it('the per-turn image count budget skips with a named note', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-img-'));
    // MAX_IMAGES_PER_TURN distinct, never-before-seen images fill the budget
    // exactly; one more in the SAME turn must be skipped with a budget note.
    const paths = Array.from({ length: MAX_IMAGES_PER_TURN + 1 }, (_, i) => tmpImage(dir, `img${i}.png`));
    const read = fakeTool('Read', { onExecute: (args: any) => ({ text: `Read ${args.file_path}`, images: [args.file_path] }) });
    const toolCalls = paths.map((p, i) => toolCallChunk(`c${i}`, 'Read', { file_path: p }));
    const model = scriptedModel([
      stream(...toolCalls, finishChunk('tool-calls')),   // one step, N+1 parallel calls — same turn, shared budget
      stream(...textChunks('b', 'done'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    collect(session);
    await session.send('go');

    const history = (session as any).history as any[];
    const toolMsg = history.filter((m) => m.role === 'tool').pop();
    const lastOutput = toolMsg.content[toolMsg.content.length - 1].output;   // the (N+1)th call's result — the one over budget
    expect(lastOutput.type).toBe('text');   // budget skip → no image attached, stays text-only
    expect(lastOutput.value).toContain('images-per-turn budget');
  });

  it('a file that vanished between promise and delivery gets a named note, not silence', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-img-'));
    const goneP = path.join(dir, 'gone.png');
    fs.writeFileSync(goneP, Buffer.from([1, 2, 3]));
    // Simulate the tool having stat'd the file before promising it, but the
    // file vanishing before the DRIVER delivers it: delete it inside execute()
    // itself, right before returning the promise — the driver's own
    // fs.statSync (resolveToolImages) then finds nothing.
    const read = fakeTool('Read', {
      onExecute: () => { fs.unlinkSync(goneP); return { text: 'Read image', images: [goneP] }; },
    });
    const model = scriptedModel([
      stream(...textChunks('a', 'reading'), toolCallChunk('c1', 'Read', { file_path: goneP }), finishChunk('tool-calls')),
      stream(...textChunks('b', 'done'), finishChunk('stop')),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    collect(session);
    await session.send('go');

    const history = (session as any).history as any[];
    const toolMsg = history.filter((m) => m.role === 'tool').pop();
    const output = toolMsg.content[0].output;
    expect(output.type).toBe('text');   // no image attached
    expect(output.value).toContain('no longer readable');
  });

  // The count budget (tested above) and the byte budget are two DISTINCT `if`
  // branches in resolveToolImages — a passing count-budget test gives zero
  // coverage of the byte one. Driving it through a full turn would mean
  // writing >20 MB of fixture images to disk per run; instead this calls the
  // private method directly (same pattern this file already uses for
  // `(session as any).history`) with the budget pre-loaded to just under the
  // cap, so one small image is enough to tip it over.
  it('the per-turn image byte budget skips with a named note, independent of the count budget', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-img-'));
    const imgPath = tmpImage(dir, 'x.png');
    const fileSize = fs.statSync(imgPath).size;
    const session = new HarnessSession(makeOpts({ decide: async () => ALLOW }), async () => ({}) as any);
    const budget = { count: 0, bytes: MAX_IMAGE_BYTES_PER_TURN - fileSize + 1 };   // one byte short of room for this file
    const result = (session as any).resolveToolImages({ text: 'Read image', images: [imgPath] }, budget);
    expect(result.images).toHaveLength(0);
    expect(result.text).toContain('MB-per-turn image budget');
  });
});
