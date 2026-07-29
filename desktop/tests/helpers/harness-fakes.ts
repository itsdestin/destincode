// Shared HarnessSession test scaffolding — extracted from
// harness-session-loop.test.ts (which now re-imports HARNESS/makeOpts/fakeTool)
// so the profile-driven driver test (Task 5) and later tasks build a REAL
// HarnessSession over a scripted model without duplicating this setup. Kept
// deliberately minimal; later tasks extend it.
import { z } from 'zod';
import { MockLanguageModelV4, simulateReadableStream } from 'ai/test';
import { HarnessSession, type HarnessSessionOpts } from '../../src/main/harness/harness-session';
import type { HarnessManifest } from '../../src/shared/harness-manifest';
import type { NativeTool } from '../../src/main/harness/tools/types';
import type { PermissionDecision } from '../../src/shared/permission-types';
import type { AskRequest, AskDecision } from '../../src/main/harness/permission-broker';
import type { CapabilityProfile } from '../../src/main/harness/capability-profile';
import { textChunks, toolCallChunk, finishChunk, stream } from './scripted-model';

// Default harness manifest for driver tests (matches the loop suite's).
export const HARNESS: HarnessManifest = {
  schema: 1, id: 'agent', name: 'Agent', systemPrompt: 'sys', tools: [],
  permissionPolicy: 'ask', limits: { maxTokens: 256 },
};

// A permissive fake tool that RECORDS executions. subject undefined by default
// (so tool-layer guards are skipped and decide() is the sole gate). Default
// schema requires file_path — override `schema` for tools with other args.
export function fakeTool(name: string, over: Partial<NativeTool> & { schema?: z.ZodType; onExecute?: (args: any, ctx: any) => any } = {}): NativeTool {
  const calls: any[] = [];
  const t: NativeTool = {
    name,
    description: `fake ${name}`,
    inputSchema: over.schema ?? z.object({ file_path: z.string() }),
    permissionSubject: over.permissionSubject ?? (() => undefined),
    ...(over.interactive ? { interactive: over.interactive } : {}),
    async execute(args, ctx) {
      calls.push(args);
      if (over.onExecute) return over.onExecute(args, ctx);
      return { text: `${name} ran` };
    },
  };
  (t as any).calls = calls;
  return t;
}

/** An installed-skill source that finds nothing.
 *
 *  DEFAULT for every test session, because without it `syncSkillTool` falls back
 *  to `createSkillCatalog()` — which scans the REAL `~/.claude`. That makes the
 *  attached tool set depend on the machine running the suite: it passed locally
 *  and on macOS/Windows CI (where the scan found nothing) and failed on Ubuntu CI
 *  with "expected 10 tools, got 11" (2026-07-29). A test that reaches the
 *  developer's home directory is not a test of the code.
 *
 *  Tests that care about skills pass their own catalog and override this. */
export const EMPTY_SKILL_CATALOG = {
  list: () => [],
  load: (id: string) => { throw new Error(`no skills installed (test catalog): ${id}`); },
};

export function makeOpts(over: Partial<HarnessSessionOpts>): HarnessSessionOpts {
  return {
    sessionId: 's-1', cwd: 'C:/x', harness: HARNESS,
    binding: { providerId: 'openrouter', modelId: 'm' },
    retryDelays: [1, 1, 1],   // test hook: near-zero backoff so the suite stays fast
    skillCatalog: EMPTY_SKILL_CATALOG,
    ...over,
  } as HarnessSessionOpts;
}

// One scripted step: optional leading text, zero+ tool calls, optional usage.
// scriptModel turns each into ONE streamText consumption (a driver step).
// `throwError` makes that consumption's stream surface an error part (which the
// driver throws) — used to test the compaction fail-safe (a summary model call
// that explodes must NOT brick the turn). A throwError step ignores text/tools.
export interface ScriptStep {
  text?: string;
  toolCalls?: { name: string; input: unknown }[];
  usage?: { inputTokens?: number; outputTokens?: number };
  throwError?: string;
}

// Build a fake model whose Nth doStream call replays the Nth scripted step. Once
// the turn OUTRUNS the scripted steps (e.g. the driver loops once more after a
// doom-loop denial), it emits a natural STOP instead of repeating the last —
// possibly tool-calling — step forever, so higher-level tests can't wedge.
export function scriptModel(steps: ScriptStep[]) {
  const scripts = steps.map((s, i) => {
    // An error step: emit a single error part (same shape the retry test uses).
    // streamText surfaces it on fullStream AND textStream, so both the driver's
    // consumeStep and generateSummary see the throw. doStream itself still
    // RESOLVES cleanly, so the SDK does not retry it (the error is mid-stream).
    if (s.throwError !== undefined) return stream({ type: 'error', error: new Error(s.throwError) });
    const chunks: any[] = [];
    if (s.text) chunks.push(...textChunks(`t${i}`, s.text));
    (s.toolCalls ?? []).forEach((tc, j) => chunks.push(toolCallChunk(`c${i}-${j}`, tc.name, tc.input)));
    const reason = (s.toolCalls?.length ?? 0) > 0 ? 'tool-calls' : 'stop';
    chunks.push(finishChunk(reason, s.usage?.inputTokens ?? 1, s.usage?.outputTokens ?? 1));
    return stream(...chunks);
  });
  const terminal = stream(finishChunk('stop'));   // implicit end when the script runs out
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      const chunks = call < scripts.length ? scripts[call] : terminal;
      call++;
      return { stream: simulateReadableStream({ chunks }) };
    },
  });
}

// A model whose FIRST doStream call HANGS forever — its stream never emits and
// never closes, simulating a stalled local model (the exact case the summary
// abort-race + timeout must survive). `onFirstCall` fires once the hang begins so
// a test can then interrupt(). Every later call stops cleanly, so the turn can
// still unwind after the interrupt without wedging on a repeated hang.
export function hangingFirstCallModel(onFirstCall: () => void) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      call++;
      if (call === 1) {
        onFirstCall();
        // Never enqueue, never close → textStream.next() never resolves on its own.
        return { stream: new ReadableStream<any>({ start() { /* intentionally idle */ } }) };
      }
      return { stream: simulateReadableStream({ chunks: stream(finishChunk('stop')) }) };
    },
  });
}

export interface MakeSessionOver {
  profile?: CapabilityProfile;
  askUser?: (req: AskRequest) => Promise<AskDecision>;
  model?: any;                       // a scriptModel()/scriptedModel() fake
  contextLength?: number | null;
  tools?: NativeTool[];
  decide?: (tool: string, subject: string | undefined) => Promise<PermissionDecision>;
  systemPrompt?: string;
  // Subscribe to the session's transcript-event stream (each emitted event is
  // forwarded here) — lets a test assert on the frozen emit surface directly.
  onEvent?: (e: any) => void;
  // Pre-fill history with ~this-many tokens of large user/assistant messages
  // (alternating roles). The bulk is PROTECTED non-tool content, so pruning
  // frees almost nothing — this is how a compaction test forces the SUMMARIZE
  // branch (pruning insufficient) instead of the cheap prune-only path.
  seedBulkHistoryTokens?: number;
}

// Construct a real HarnessSession over a scripted model. Defaults: an allow-all
// decide() and a Glob+Read tool set, so a scripted tool call actually executes
// (and the doom-loop, not a permission ask, is what trips) unless overridden.
export function makeSession(over: MakeSessionOver = {}): HarnessSession {
  const model = over.model ?? scriptModel([{ text: 'ok' }]);
  const tools = over.tools ?? [
    fakeTool('Glob', { schema: z.object({ pattern: z.string() }) }),
    fakeTool('Read'),
  ];
  const opts: HarnessSessionOpts = {
    sessionId: 's-1', cwd: 'C:/x', harness: HARNESS,
    binding: { providerId: 'openrouter', modelId: 'm' },
    retryDelays: [1, 1, 1],
    tools,
    // Same reason as makeOpts: without this, buildAiTools scans the real
    // ~/.claude and the tool set becomes machine-dependent.
    skillCatalog: EMPTY_SKILL_CATALOG,
    decide: over.decide ?? (async () => ({ action: 'allow', denyListed: false })),
    ...(over.askUser ? { askUser: over.askUser } : {}),
    ...(over.profile ? { profile: over.profile } : {}),
    ...(over.contextLength !== undefined ? { contextLength: over.contextLength } : {}),
    ...(over.systemPrompt ? { systemPrompt: over.systemPrompt } : {}),
  };
  const session = new HarnessSession(opts, async () => model as any);
  // Forward every transcript event to the test's listener (before any turn runs).
  if (over.onEvent) session.on('transcript-event', over.onEvent);
  // Seed protected bulk history so a later compaction check must SUMMARIZE.
  if (over.seedBulkHistoryTokens && over.seedBulkHistoryTokens > 0) {
    const filler = 'x'.repeat(4000);   // ~1000 tokens per message (chars/4)
    const msgs: any[] = [];
    let tokens = 0;
    for (let i = 0; tokens < over.seedBulkHistoryTokens; i++) {
      // Alternate roles so the history has ≥2 user-delimited turns — the summarize
      // cut needs the 2nd-to-last user message to sit at index > 0 (starting on an
      // assistant keeps the first seeded user off index 0). Big content per message.
      const role = i % 2 === 0 ? 'assistant' : 'user';
      const content = `bulk ${i} ${filler}`;
      msgs.push({ role, content });
      tokens += Math.ceil(content.length / 4);
    }
    session.seedHistory(msgs);
  }
  return session;
}

// Drive one user turn to completion.
export async function drainTurn(session: HarnessSession, text: string): Promise<void> {
  await session.send(text);
}
