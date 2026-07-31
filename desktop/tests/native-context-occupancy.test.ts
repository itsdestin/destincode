// What the context gauge is allowed to measure.
//
// Destin, 2026-07-28, on a live local session: "the 'prompt' with claude.md alone
// said it was 7000 tokens, so why would context only be 300/whatever?" The pill
// read `367 / 128.0k`. Two separate defects produced that number:
//
//   1. the provider was never asked for token counts (see provider-registry.test),
//      so inputTokens was 0 on every turn ever recorded, and
//   2. the gauge summed in+out ACROSS STEPS of a single turn — a quantity that
//      both re-counts the whole history once per step AND resets each turn, so it
//      could never answer "how full is the window?".
//
// This file pins (2): turn-complete must carry the OCCUPANCY of the window.
import { describe, it, expect } from 'vitest';
import { HarnessSession } from '../src/main/harness/harness-session';
import type { TranscriptEvent } from '../src/shared/types';
import type { PermissionDecision } from '../src/shared/permission-types';
import { textChunks, toolCallChunk, finishChunk, stream, scriptedModel } from './helpers/scripted-model';
import { makeOpts, fakeTool } from './helpers/harness-fakes';

const ALLOW: PermissionDecision = { action: 'allow', denyListed: false };

function usageOf(events: TranscriptEvent[]) {
  return events.find((e) => e.type === 'turn-complete')!.data.usage as any;
}

describe('turn-complete usage — occupancy vs turn total', () => {
  it('reports the LAST step\'s prompt + reply, not the sum across steps', async () => {
    // Two steps. Each step re-sends the whole conversation, so the second step's
    // prompt (1,200) already CONTAINS the first step's — summing them to 2,200
    // would claim the model holds nearly twice what it does.
    const read = fakeTool('Read');
    const model = scriptedModel([
      stream(...textChunks('a', 'Reading.'), toolCallChunk('c1', 'Read', { file_path: 'x.ts' }), finishChunk('tool-calls', 1000, 50)),
      stream(...textChunks('b', 'Done.'), finishChunk('stop', 1200, 80)),
    ]);
    const session = new HarnessSession(makeOpts({ tools: [read], decide: async () => ALLOW }), async () => model as any);
    const events: TranscriptEvent[] = [];
    session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
    await session.send('go');

    const usage = usageOf(events);
    expect(usage.contextUsedTokens).toBe(1280);       // 1200 prompt + 80 reply
    expect(usage.inputTokens).toBe(2200);             // the turn total is still reported…
    expect(usage.contextUsedTokens).not.toBe(usage.inputTokens + usage.outputTokens);  // …but never drives the gauge
  });

  it('a single-step turn reports that step, so the two agree', async () => {
    const model = scriptedModel([stream(...textChunks('a', 'hi'), finishChunk('stop', 900, 40))]);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events: TranscriptEvent[] = [];
    session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
    await session.send('go');

    expect(usageOf(events).contextUsedTokens).toBe(940);
  });

  it('falls back to an estimate when the provider reports no prompt tokens', async () => {
    // A server that ignores stream_options reports nothing. Showing an eternally
    // empty window would be worse than a rough number, so we estimate from what
    // we know we sent rather than claiming 0.
    const model = scriptedModel([stream(...textChunks('a', 'hi'), finishChunk('stop', 0, 0))]);
    const session = new HarnessSession(makeOpts({}), async () => model as any);
    const events: TranscriptEvent[] = [];
    session.on('transcript-event', (e: TranscriptEvent) => events.push(e));
    await session.send('go');

    const usage = usageOf(events);
    expect(usage.inputTokens).toBe(0);
    expect(usage.contextUsedTokens).toBeGreaterThan(0);   // the system prompt alone is not free
  });
});
