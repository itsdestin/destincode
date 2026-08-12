import { describe, it, expect } from 'vitest';
import { runCase } from '../src/main/harness/eval/run-case';
import { BATTERY_PROMPT } from '../src/main/harness/eval/battery';
import { scriptModel, fakeTool, capturingFactory } from './helpers/harness-fakes';
import { ASSISTANT_DEFAULT_BODY } from '../src/main/harness/prompts/assistant-default';
import { collectRunFacts, renderRunFacts } from '../src/main/harness/eval/run-facts';

describe('runCase inputs', () => {
  it('sends the prompt it was given, not the battery prompt', async () => {
    const model = scriptModel([{ text: 'done' }]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'test/model', label: 'test',
      prompt: 'Just say done.',
      contextLength: 64_000,
    });
    const firstUser = run.events.find((e) => e.type === 'user-message');
    expect(firstUser?.data.text).toBe('Just say done.');
    expect(firstUser?.data.text).not.toContain('battery');
  });

  it('defaults to the battery prompt when none is given', async () => {
    const model = scriptModel([{ text: 'done' }]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'test/model', label: 'test',
      contextLength: 64_000,
    });
    expect(run.events.find((e) => e.type === 'user-message')?.data.text).toBe(BATTERY_PROMPT);
  });

  // WHY this shape and not `tools: []` + `toolsUsed`: the old version scripted
  // no tool call at all, so `toolsUsed` was `[]` regardless of whether
  // `opts.tools` was wired up, ignored, or never added — it discriminated
  // nothing (Fix pass 1, Finding 1). `toolsUsed` also can't discriminate even
  // with a real call: harness-session.ts emits the 'tool-use' event (which
  // feeds toolsUsed) for the toolName the MODEL asked for, before checking
  // whether that name is registered at all (harness-session.ts ~1370 vs
  // ~1778's `toolByName.get`) — so the event fires identically whether the
  // session's actual tool set came from `opts.tools` or a hardcoded
  // CORE_TOOLS. What DOES differ is which tool actually executed and what it
  // returned: this test hands runCase a single fake 'Read' tool (same name as
  // the real one in CORE_TOOLS, built with the existing fakeTool helper) that
  // returns a fixed marker instead of touching the filesystem, and scripts a
  // call to 'Read' with a path that doesn't exist. If `opts.tools` reaches the
  // session, the fake runs and the marker comes back. If the wiring regresses
  // to a hardcoded CORE_TOOLS, the model's call instead reaches the REAL Read
  // tool, which stats the missing path and returns an ENOENT failure message
  // — a different, verifiably-absent string. See the Task 2 report's Fix pass
  // 1 for the mutation run that confirms this actually fails under that
  // regression.
  it('attaches the tools it was given, not the CORE_TOOLS default', async () => {
    const fakeRead = fakeTool('Read', { onExecute: () => ({ text: 'FAKE_READ_MARKER' }) });
    const model = scriptModel([
      { toolCalls: [{ name: 'Read', input: { file_path: 'does-not-exist.txt' } }] },
      { text: 'done' },
    ]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'test/model', label: 'test',
      tools: [fakeRead],
      contextLength: 64_000,
    });
    const toolResult = run.events.find((e) => e.type === 'tool-result');
    expect(toolResult?.data.toolResult).toBe('FAKE_READ_MARKER');
  });
});

describe('system prompt assembly', () => {
  it('runs on the real assistant prompt body, not the one-line fallback', async () => {
    const captured: string[] = [];
    const run = await runCase({
      modelFactory: capturingFactory(captured), // records the system prompt it was handed
      modelId: 'test/model', label: 'test', prompt: 'hi', contextLength: 64_000,
    });
    expect(captured[0]).toContain(ASSISTANT_DEFAULT_BODY.slice(0, 60));
    expect(captured[0]).not.toBe('You are a helpful, careful assistant inside YouCoded.');
    expect(run.outcome).toBeDefined();
  });

  it('injects instructions through the real project-instructions path', async () => {
    const captured: string[] = [];
    await runCase({
      modelFactory: capturingFactory(captured),
      modelId: 'test/model', label: 'test', prompt: 'hi', contextLength: 64_000,
      instructions: '# Test rules\n\nAlways say banana.',
    });
    expect(captured[0]).toContain('<project-instructions source="CLAUDE.md">');
    expect(captured[0]).toContain('Always say banana.');
  });

  it('omits the project-instructions block when given none', async () => {
    const captured: string[] = [];
    await runCase({
      modelFactory: capturingFactory(captured),
      modelId: 'test/model', label: 'test', prompt: 'hi', contextLength: 64_000,
    });
    expect(captured[0]).not.toContain('<project-instructions');
  });
});

// WHY both assertions in one test: a version that only checked the custom
// floor would pass even if the default silently broke (e.g. a required
// second argument, or a default of 0). The default-still-applies line is the
// one that actually distinguishes "per-task floor" from "floor ignored".
describe('collectRunFacts per-task floor', () => {
  it('uses the per-task floor when one is given', () => {
    const run = { review: '', metrics: { toolCalls: 3, toolsUsed: [] }, outcome: 'complete' } as any;
    expect(collectRunFacts(run, 2).belowFloor).toBe(false);
    expect(collectRunFacts(run).belowFloor).toBe(true); // default 10 still applies
  });
});

// WHY this test exists separately from run-facts's own describe blocks: the
// warning text quotes the floor number, and a caller who threads a custom
// floor into collectRunFacts but forgets to thread it into renderRunFacts
// would print a warning that quotes 10 against a run that was actually
// judged against 2 — a false statement in a report a human is meant to
// trust. Assert both the custom-floor wording and that the default wording
// (still "10") is untouched, for the same reason as the floor test above.
describe('renderRunFacts per-task floor', () => {
  const belowCustomFloor = {
    review: '', metrics: { toolCalls: 3, toolsUsed: [], asks: 0, stepGates: 0, thinkingEvents: 0, outputTokens: 0, wallClockMs: 0 },
    outcome: 'complete', unbackedClaims: [], belowFloor: true,
  } as any;

  it('quotes the custom floor it was measured against, not the default', () => {
    const out = renderRunFacts(belowCustomFloor, 2);
    expect(out).toContain('below the 2 ');
    expect(out).not.toContain('below the 10 ');
  });

  it('quotes the default floor when none is passed', () => {
    const out = renderRunFacts(belowCustomFloor);
    expect(out).toContain('below the 10 ');
  });
});
