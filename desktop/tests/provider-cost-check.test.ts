// Does our arithmetic agree with the provider's own bill? (Plan Task 27.)
//
// `costForUsage` multiplies tokens by a published rate card. Nothing checked
// that answer against the only authority that matters — what the provider
// actually charged. OpenRouter reports its own per-request figure in the usage
// block of every response, so the app can now check itself.
//
// THE RULE THIS FILE EXISTS TO ENFORCE: an absent provider figure must never
// read as zero, and never as agreement. Only OpenRouter-shaped providers report
// one. A local model, an Anthropic key, a plain OpenAI-compatible endpoint —
// all report nothing, and "nothing" is a different state from "we checked and
// it matched" (the same distinction pricing.ts already draws between null and
// absent).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { streamText } from 'ai';
import { NativeHome } from '../src/main/native-home';
import { SecretsStore } from '../src/main/providers/secrets-store';
import { ProviderRegistry } from '../src/main/providers/provider-registry';
import {
  providerCostFromMetadata, costDisagreement,
  COST_DISAGREEMENT_THRESHOLD, COST_COMPARE_FLOOR_USD,
} from '../src/main/harness/pricing';

// A streamed OpenRouter response, byte-for-byte in the wire shape OpenRouter
// publishes for it. PROVENANCE, stated plainly so no later reader over-trusts
// it: the usage block is OpenRouter's own documented example (Usage Accounting,
// openrouter.ai/docs/use-cases/usage-accounting, fetched 2026-08-27), NOT a
// capture of a live billed request — nobody here has spent real money on a real
// model to record one. It pins that we read the shape OpenRouter documents; it
// does NOT establish that our dollar figure matches a real bill.
function openRouterSse(usage: Record<string, unknown> | null): string {
  const lines = [
    `data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', model: 'openai/gpt-4o', choices: [{ index: 0, delta: { role: 'assistant', content: 'hi' }, finish_reason: null }] })}`,
    `data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', model: 'openai/gpt-4o', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
  ];
  if (usage) {
    // OpenRouter sends the usage block in its LAST SSE message, in a chunk with
    // an empty choices array — the case a naive extractor skips.
    lines.push(`data: ${JSON.stringify({ id: 'gen-1', object: 'chat.completion.chunk', model: 'openai/gpt-4o', choices: [], usage })}`);
  }
  lines.push('data: [DONE]');
  return lines.map((l) => `${l}\n\n`).join('');
}

/** The full usage block from OpenRouter's documented example. */
const RECORDED_USAGE = {
  completion_tokens: 2,
  completion_tokens_details: { reasoning_tokens: 0 },
  cost: 0.95,
  cost_details: { upstream_inference_cost: 19 },
  prompt_tokens: 194,
  prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 100, audio_tokens: 0 },
  total_tokens: 196,
};

/** A usage block from a plain OpenAI-compatible server: token counts, no cost.
 *  This is the shape EVERY non-OpenRouter provider produces. */
const USAGE_WITHOUT_COST = { completion_tokens: 2, prompt_tokens: 194, total_tokens: 196 };

function sseResponse(body: string): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

describe('reading the provider’s own cost off a recorded response', () => {
  let root: string; let reg: ProviderRegistry;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-provcost-'));
    reg = new ProviderRegistry(new NativeHome(root), new SecretsStore(root));
    await reg.init();
    await reg.setKey('openrouter', 'sk-or-test');
  });
  afterEach(() => { vi.unstubAllGlobals(); fs.rmSync(root, { recursive: true, force: true }); });

  /** Runs one real streamText turn against a stubbed HTTP response and returns
   *  what the provider metadata carried. This is the only way to express a raw
   *  `cost` field in a test: every other stub in this repo returns SDK-level
   *  doStream parts, which sit ABOVE where `usage.cost` lives on the wire. */
  async function turnAgainst(body: string): Promise<{ meta: any; sentBody: any }> {
    let sentBody: any;
    vi.stubGlobal('fetch', async (_url: any, init: any) => {
      sentBody = JSON.parse(init.body);
      return sseResponse(body);
    });
    const model = await reg.languageModel({ providerId: 'openrouter', modelId: 'openai/gpt-4o' });
    const result = streamText({ model: model as any, prompt: 'hi' });
    for await (const _ of result.textStream) { /* drain */ }
    return { meta: await result.providerMetadata, sentBody };
  }

  it('surfaces OpenRouter’s own per-request cost as provider metadata', async () => {
    const { meta } = await turnAgainst(openRouterSse(RECORDED_USAGE));
    expect(providerCostFromMetadata(meta)).toBeCloseTo(0.95, 10);
  });

  it('reports NOTHING — not zero — when the response carries no cost field', async () => {
    const { meta } = await turnAgainst(openRouterSse(USAGE_WITHOUT_COST));
    // The distinction this whole file is about: undefined, never 0.
    expect(providerCostFromMetadata(meta)).toBeUndefined();
  });

  it('reports NOTHING when the response carries no usage block at all', async () => {
    const { meta } = await turnAgainst(openRouterSse(null));
    expect(providerCostFromMetadata(meta)).toBeUndefined();
  });

  it('keeps a genuine zero — a :free model billed nothing IS a reported figure', async () => {
    const { meta } = await turnAgainst(openRouterSse({ ...RECORDED_USAGE, cost: 0 }));
    expect(providerCostFromMetadata(meta)).toBe(0);
  });
});

describe('providerCostFromMetadata', () => {
  it('returns undefined for absent, empty, or non-numeric metadata', () => {
    expect(providerCostFromMetadata(undefined)).toBeUndefined();
    expect(providerCostFromMetadata({})).toBeUndefined();
    expect(providerCostFromMetadata({ openrouter: {} })).toBeUndefined();
    expect(providerCostFromMetadata({ openrouter: { costUsd: 'lots' } } as any)).toBeUndefined();
    expect(providerCostFromMetadata({ openrouter: { costUsd: NaN } })).toBeUndefined();
    // Another provider's metadata is not a cost report.
    expect(providerCostFromMetadata({ anthropic: { costUsd: 3 } } as any)).toBeUndefined();
  });
});

describe('costDisagreement', () => {
  it('is null when the provider reported nothing — absence is never agreement', () => {
    expect(costDisagreement(1, undefined)).toBeNull();
  });

  it('is null when we have no figure of our own (no published rate, or free)', () => {
    expect(costDisagreement(null, 1)).toBeNull();
    expect(costDisagreement(undefined, 1)).toBeNull();
  });

  it('is null below the comparison floor, where rounding dominates the ratio', () => {
    expect(costDisagreement(0, COST_COMPARE_FLOOR_USD / 2)).toBeNull();
    expect(costDisagreement(1, 0)).toBeNull();
  });

  it('is the relative gap against the provider’s figure, which is the authority', () => {
    expect(costDisagreement(0.9, 1)!).toBeCloseTo(0.1, 10);
    expect(costDisagreement(1.1, 1)!).toBeCloseTo(0.1, 10);   // symmetric — over-reporting counts
    expect(costDisagreement(1, 1)).toBe(0);
  });

  it('has a threshold above the few-percent band the two formulas can honestly differ by', () => {
    expect(COST_DISAGREEMENT_THRESHOLD).toBeGreaterThan(0.02);
    expect(COST_DISAGREEMENT_THRESHOLD).toBeLessThan(0.5);
  });
});

// ---------------------------------------------------------------------------
// Threading the provider's figure through a turn, beside the one we compute.
//
// THE STEP-VS-TURN TRAP (named by the plan): the provider reports per REQUEST,
// while `costForUsage` prices a whole TURN of N steps. Summing both sides is
// only honest while the two sums cover the SAME steps. A turn where some steps
// reported a cost and some did not would compare part of a bill against all of
// a turn — silently, and in the cheap direction. The rule pinned below is that
// such a turn reports NO provider figure at all.
// ---------------------------------------------------------------------------
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { HarnessSession } from '../src/main/harness/harness-session';
import { makeOpts, fakeTool } from './helpers/harness-fakes';
import { textChunks, stream } from './helpers/scripted-model';
import { log } from '../src/main/logger';

vi.mock('../src/main/logger', () => ({ log: vi.fn(), rotateLog: vi.fn() }));

/** One step's finish part, optionally carrying an OpenRouter cost the way the
 *  metadataExtractor above delivers it. `cost: undefined` stages a provider
 *  that reported nothing — the common case. */
function finishWithCost(reason: string, inTok: number, outTok: number, cost?: number) {
  return {
    type: 'finish',
    finishReason: { unified: reason, raw: reason },
    usage: { inputTokens: { total: inTok }, outputTokens: { total: outTok } },
    ...(cost === undefined ? {} : { providerMetadata: { openrouter: { costUsd: cost } } }),
  };
}

/** A model that replays one scripted step per doStream call. Each step names
 *  its own token counts and (optionally) the provider's own cost figure. */
function costScriptedModel(steps: { inTok: number; outTok: number; cost?: number; tool?: boolean }[]) {
  let call = 0;
  const scripts = steps.map((s, i) => stream(
    ...textChunks(`t${i}`, 'ok'),
    ...(s.tool ? [{ type: 'tool-call', toolCallId: `c${i}`, toolName: 'Noop', input: JSON.stringify({ file_path: 'f' }) }] : []),
    finishWithCost(s.tool ? 'tool-calls' : 'stop', s.inTok, s.outTok, s.cost),
  ));
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = scripts[Math.min(call, scripts.length - 1)];
      call++;
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

/** Runs ONE turn and returns the turn-complete usage payload. */
async function turnUsage(
  steps: { inTok: number; outTok: number; cost?: number; tool?: boolean }[],
  over: Record<string, unknown> = {},
) {
  const model = costScriptedModel(steps);
  const session = new HarnessSession(
    makeOpts({
      tools: [fakeTool('Noop')],
      decide: async () => ({ action: 'allow' }) as any,
      pricing: { in: 1_000_000, out: 2_000_000 },   // $1/token in, $2/token out
      ...over,
    }),
    async () => model as any,
  );
  const seen: any[] = [];
  session.on('transcript-event', (e: any) => seen.push(e));
  await session.send('hello');
  return seen.find((e) => e.type === 'turn-complete')!.data.usage;
}

describe('the provider’s figure rides the turn beside ours', () => {
  beforeEach(() => { vi.mocked(log).mockClear(); });

  it('sums the provider’s per-request figures across the turn’s steps', async () => {
    // Two steps, each billed by the provider. Ours: (1+1) in + (1+1) out
    // = $2 + $4 = $6, which is what a 3%-off provider figure is compared to.
    const usage = await turnUsage([
      { inTok: 1, outTok: 1, cost: 3, tool: true },
      { inTok: 1, outTok: 1, cost: 3 },
    ]);
    expect(usage.costUsd).toBeCloseTo(6, 10);
    expect(usage.providerCostUsd).toBeCloseTo(6, 10);
  });

  it('omits the provider figure entirely when the provider reported nothing', async () => {
    const usage = await turnUsage([{ inTok: 1, outTok: 1 }]);
    expect(usage.costUsd).toBeCloseTo(3, 10);
    // Absent, NOT 0 — a provider that said nothing did not say "free".
    expect('providerCostUsd' in usage).toBe(false);
  });

  it('omits it when only SOME steps reported one — never compares a step to a turn', async () => {
    const usage = await turnUsage([
      { inTok: 1, outTok: 1, cost: 3, tool: true },
      { inTok: 1, outTok: 1 },                       // this one reported nothing
    ]);
    expect(usage.costUsd).toBeCloseTo(6, 10);
    // A $3 figure covering one of two steps must not be published beside a
    // $6 figure covering both. Absent is the only honest answer.
    expect('providerCostUsd' in usage).toBe(false);
  });

  it('keeps a reported zero — a free model that billed nothing DID report', async () => {
    // `free` is resolved by the HOST from the provider type, not derived here
    // from the rate card, so the fixture states both the way the host would.
    const usage = await turnUsage([{ inTok: 1, outTok: 1, cost: 0 }], { pricing: { in: 0, out: 0 }, free: true });
    expect(usage.free).toBe(true);
    expect(usage.costUsd).toBeNull();
    expect(usage.providerCostUsd).toBe(0);
  });

  it('logs a diagnostic line when the two figures disagree beyond the threshold', async () => {
    // Ours: $3. Provider: $6 — 50% apart, far above the 5% threshold.
    await turnUsage([{ inTok: 1, outTok: 1, cost: 6 }]);
    const warned = vi.mocked(log).mock.calls.filter((c) => /cost/i.test(String(c[2])));
    expect(warned).toHaveLength(1);
    expect(warned[0][0]).toBe('WARN');
    // The line must carry BOTH figures — a gap with no numbers is undiagnosable.
    expect(warned[0][3]).toMatchObject({ ourCostUsd: 3, providerCostUsd: 6 });
  });

  it('stays silent when the two agree, and when there is nothing to compare', async () => {
    await turnUsage([{ inTok: 1, outTok: 1, cost: 3 }]);        // exact agreement
    await turnUsage([{ inTok: 1, outTok: 1 }]);                 // provider said nothing
    await turnUsage([{ inTok: 1, outTok: 1, cost: 3 }], { pricing: null });  // we have no rate
    expect(vi.mocked(log).mock.calls.filter((c) => /cost/i.test(String(c[2])))).toHaveLength(0);
  });
});
