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

export function makeOpts(over: Partial<HarnessSessionOpts>): HarnessSessionOpts {
  return {
    sessionId: 's-1', cwd: 'C:/x', harness: HARNESS,
    binding: { providerId: 'openrouter', modelId: 'm' },
    retryDelays: [1, 1, 1],   // test hook: near-zero backoff so the suite stays fast
    ...over,
  } as HarnessSessionOpts;
}

// One scripted step: optional leading text, zero+ tool calls, optional usage.
// scriptModel turns each into ONE streamText consumption (a driver step).
export interface ScriptStep {
  text?: string;
  toolCalls?: { name: string; input: unknown }[];
  usage?: { inputTokens?: number; outputTokens?: number };
}

// Build a fake model whose Nth doStream call replays the Nth scripted step. Once
// the turn OUTRUNS the scripted steps (e.g. the driver loops once more after a
// doom-loop denial), it emits a natural STOP instead of repeating the last —
// possibly tool-calling — step forever, so higher-level tests can't wedge.
export function scriptModel(steps: ScriptStep[]) {
  const scripts = steps.map((s, i) => {
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

export interface MakeSessionOver {
  profile?: CapabilityProfile;
  askUser?: (req: AskRequest) => Promise<AskDecision>;
  model?: any;                       // a scriptModel()/scriptedModel() fake
  contextLength?: number | null;
  tools?: NativeTool[];
  decide?: (tool: string, subject: string | undefined) => Promise<PermissionDecision>;
  systemPrompt?: string;
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
    decide: over.decide ?? (async () => ({ action: 'allow', denyListed: false })),
    ...(over.askUser ? { askUser: over.askUser } : {}),
    ...(over.profile ? { profile: over.profile } : {}),
    ...(over.contextLength !== undefined ? { contextLength: over.contextLength } : {}),
    ...(over.systemPrompt ? { systemPrompt: over.systemPrompt } : {}),
  };
  return new HarnessSession(opts, async () => model as any);
}

// Drive one user turn to completion.
export async function drainTurn(session: HarnessSession, text: string): Promise<void> {
  await session.send(text);
}
