// HarnessSession — the native runtime's multi-step agentic turn driver
// (spec §2.3/§2.4). Phase 2 (Task 9) replaced v0's single streamText call with a
// step LOOP: each step is one streamText consumption; tool-calls are validated,
// permission-gated, and executed serially; results feed the next step until the
// model stops (no tool calls) or a budget/interrupt ends the turn.
//
// The v0 outer shell survives verbatim: the re-entrancy guard, the abort-race
// stream iterator (providers can ignore abort signals — racing guarantees
// interrupt() always ends the turn), the delta partId semantics, and the
// catch → user-interrupt vs session-error split. The transcript-event emit
// surface is FROZEN — this driver emits ONLY the pre-existing TranscriptEventType
// values; max_steps and doom_loop surface as PERMISSION ASKS (askUser), never as
// new event types.
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { streamText, tool, zodSchema, jsonSchema, type LanguageModel, type ModelMessage } from 'ai';
import type { TranscriptEvent } from '../../shared/types';
import type { ModelBinding } from '../../shared/provider-types';
import type { HarnessManifest } from '../../shared/harness-manifest';
import type { PermissionDecision } from '../../shared/permission-types';
import type { NativeTool, ToolContext, ToolResultPayload, ToolServices } from './tools/types';
import { stepBudgetFor } from './model-step-budget';
import { checkPathGuard } from './tools/guards';
import { readImageFromDisk, MAX_IMAGES_PER_TURN, MAX_IMAGE_BYTES_PER_TURN } from './image-support';

// Tools whose permission SUBJECT is not a filesystem path. Bash's is a command
// string; Skill's is a skill id. Both would be canonicalized against cwd and run
// through the credential denylist by checkPathGuard, and matched against rule
// globs by injectPathTriggers — neither is meaningful for a non-path.
//
// This used to be spelled inline as `toolName !== 'Bash'`, which silently gave
// Skill the wrong treatment the moment it was added (found in the 2026-07-28
// branch review). Naming the set means the next non-path-subject tool has one
// place to declare itself instead of inheriting file-tool behavior by default.
const NON_PATH_SUBJECT_TOOLS = new Set(['Bash', 'Skill']);
import { formatAnswers } from './tools/ask-user-question';
import type { AskRequest, AskDecision } from './permission-broker';
import { CLOUD_DEFAULT, type CapabilityProfile } from './capability-profile';
import { planCompaction, pruneToolOutputs, summarizePrompt, estimateTokens, type CompactionConfig } from './compaction';
import { toReport, type PrefillProgress } from '../providers/prefill-progress';
import { messageTokens, messagesTokens, APPROX_CHARS_PER_TOKEN } from './message-size';
import { createSkillTool } from './tools/skill';
import { createSkillCatalog, type SkillCatalog } from './skills/skill-catalog';
import { fitInjection } from './injection/injection-budget';
import type { TriggerIndex } from './injection/path-triggers';
import { mcpToolsFor, estimateToolSchemaTokens } from './mcp/mcp-tools';
import type { ReadyServer } from './mcp/mcp-manager';
import { log } from '../logger';

export interface HarnessSessionOpts {
  sessionId: string; cwd: string; harness: HarnessManifest; binding: ModelBinding;
  /** Model context window (from the catalog); null → conservative 32k default. */
  contextLength?: number | null;
  // --- Plan A (Task 9) additions — all injected by NativeSessionHost: ---
  /** The tool set this session may call. Absent/[] = v0 chat behavior (the
   *  Chat-preset path: plain text, no tool plumbing invoked). */
  tools?: NativeTool[];
  /** Pure permission decision for (tool, subject) — the configured layers
   *  (preset/mode/deny-list/remembered). Absent → every gated tool asks. */
  decide?: (tool: string, subject: string | undefined) => Promise<PermissionDecision>;
  /** Raise an interactive permission ask (broker.ask bound to this session).
   *  Also the surface for the max_steps / doom_loop budget asks. */
  askUser?: (req: AskRequest) => Promise<AskDecision>;
  /** System prompt assembled ONCE at init (Task 11); falls back to the
   *  harness's own systemPrompt for the Chat preset. */
  systemPrompt?: string;
  /** Runtime services threaded into every tool's ToolContext (spec §3.2).
   *  Injected by NativeSessionHost (e.g. { search } → WebSearch). */
  toolServices?: ToolServices;
  /** Test hook: step-level retry backoff (ms). Defaults to [1000, 2000, 4000]. */
  retryDelays?: number[];
  /** Test hook: streaming inactivity watchdog timings (ms). Silence past
   *  `stallWarningMs` warns the user; a further `stallCountdownMs` of silence
   *  triggers the auto-retry / session-error. Default 60_000 / 15_000. */
  stallWarningMs?: number;
  stallCountdownMs?: number;
  /** Test hook: the TIME-TO-FIRST-TOKEN budget, which is separate from (and much
   *  larger than) `stallWarningMs` because prefill on a local model legitimately
   *  runs to minutes. Defaults to prefillBudgetMs(promptTokens). */
  prefillWarningMs?: number;
  /** Resolved capability profile (Task 5): steers the doom-loop window and
   *  whether tools are attached at all. Absent → CLOUD_DEFAULT (full posture). */
  profile?: CapabilityProfile;
  /** Installed-skill source for the Skill tool (M3 item 1). Injected so tests can
   *  supply a fake instead of scanning the real ~/.claude — and so a machine with
   *  no skills is an expressible state rather than an environment accident.
   *  Absent → the real filesystem catalog. */
  skillCatalog?: SkillCatalog;
  /** Project rules + nested project instructions, indexed by path (M3 item 3).
   *  Absent → no path-triggered injection, which is exactly the pre-M3 behavior
   *  every existing caller and test relies on. */
  triggers?: TriggerIndex;
  /** The MCP servers this session may use (Task 6), acquired by
   *  NativeSessionHost from the process-level McpManager at create/resume.
   *  Absent/[] → no MCP tools attached, exactly the pre-Task-6 behavior. */
  mcpServers?: ReadyServer[];
}
// The opts second arg carries per-turn model construction hints. `serialToolCalls`
// (Task 10 / spec §4.2) tells the local-engine factory to inject
// parallel_tool_calls:false; cloud factories ignore it.
export type ModelFactory = (
  binding: ModelBinding,
  opts?: { serialToolCalls?: boolean; onPrefillProgress?: (p: PrefillProgress) => void },
) => Promise<LanguageModel>;

// One collected tool-call from a step's stream (input already PARSED to an
// object by streamText — see the ai@7 contract test).
interface ToolCall { toolCallId: string; toolName: string; input: any }
// Normalized per-step usage (v7's nested cache details flattened into our fixed
// transcript usage shape).
interface StepUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
// What one consumed step returns to the loop.
interface StepResult {
  text: string; toolCalls: ToolCall[]; usage: StepUsage;
  finishReason: string | undefined; interrupted: boolean;
  /** Milliseconds from this step's FIRST real output chunk to the end of its
   *  stream — i.e. time actually spent generating. Excludes prefill (before the
   *  first chunk) and everything outside the stream (tool execution, permission
   *  waits). 0 when the step produced no output. */
  generationMs: number;
}

// v7 stream parts carry the chunk in .text (verified against ai@7.0.22:
// TextStreamTextDeltaPart / TextStreamReasoningDeltaPart both expose `.text`).
// Read through ONE accessor so any future field rename stays here. The
// `?? part.delta` fallback is for the RAW LanguageModelV4 stream-part shape
// (which uses `.delta`) — the transformed fullStream we iterate here only ever
// carries `.text`, so `.delta` never actually fires; it's belt-and-suspenders.
function deltaText(part: any): string { return part.text ?? part.delta ?? ''; }

// AI SDK finishReason -> CC transcript stopReason names (the bubble footer
// gate filters 'end_turn' as the normal case).
function mapStopReason(finishReason: string | undefined): string {
  switch (finishReason) {
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    case 'content-filter': return 'refusal';
    default: return finishReason ?? 'unknown';
  }
}

/** Widening advice per tool, in that tool's OWN vocabulary.
 *
 *  WHY (2026-08-06, Task 18): this path appended "Re-run with offset/limit, or
 *  use Grep" to EVERY oversized tool result, including Bash and WebSearch,
 *  which accept neither parameter. It is the same defect the bounds contract
 *  removed from the defineTool path (tools/registry.ts) — and it fires
 *  precisely when output is largest, so it was the most likely advice a model
 *  would ever act on. Two models testing the harness followed it into a dead
 *  end. Tools absent from this map get a bare statement with no advice, which
 *  is the honest fallback per docs/error-message-standards.md — never a guess. */
const FIT_MORE_HINT: Record<string, string> = {
  Read: 'Re-run with a narrower offset/limit window',
  Bash: 'Re-run piping through head, tail, or wc -l',
  Grep: 'Re-run with a narrower pattern or output_mode: "count"',
  Glob: 'Re-run with a narrower glob pattern',
  WebSearch: 'Re-run with a narrower query',
  WebFetch: 'Fetch a more specific URL or section',
};

// Shrink a role:'tool' message's result text to fit `maxChars`, splitting the
// allowance evenly when one message carries several results. Used only by
// fitToContext's oversized-tail salvage — the ordinary path never rewrites
// content. The trailing notice matters: without it a model reads a hard-cut
// file as complete and confidently answers from a fragment. Exported so Task
// 18's tests can drive it directly without recreating a whole oversized
// history through fitToContext.
export function truncateToolMessage(msg: ModelMessage, maxChars: number): ModelMessage {
  if (msg.role !== 'tool' || !Array.isArray(msg.content)) return msg;
  const parts = msg.content as any[];
  const results = parts.filter((p) => p?.type === 'tool-result');
  if (results.length === 0) return msg;
  const per = Math.max(500, Math.floor(maxChars / results.length));
  return {
    ...msg,
    content: parts.map((p: any) => {
      if (p?.type !== 'tool-result') return p;
      const value = p.output?.value;
      if (typeof value !== 'string' || value.length <= per) return p;
      const dropped = value.length - per;
      // Derived from the RESULT'S OWN toolName, not a shared default — see
      // FIT_MORE_HINT above. Nothing is appended when the tool isn't in the map.
      const hint = FIT_MORE_HINT[p.toolName];
      return {
        ...p,
        output: {
          ...p.output,
          value: value.slice(0, per) +
            `\n\n[truncated — ${dropped.toLocaleString()} more characters were dropped because this result alone exceeds the model's context window.${hint ? ` ${hint}.` : ''}]`,
        },
      };
    }),
  } as ModelMessage;
}

// Turn a caught provider/SDK error into the most ACTIONABLE message we can show
// (docs/error-message-standards.md — surface the real detail, never a generic
// wrapper). The AI SDK wraps a provider HTTP failure as AI_APICallError (with
// `.statusCode` + a `.responseBody` JSON string) and its retry layer as
// AI_RetryError (with `.lastError`). The bare `.message` is useless
// ("Provider returned error" / "Failed after 3 attempts") — the real, usually
// user-fixable detail lives in the body. OpenRouter, for example, nests the
// upstream reason at `error.metadata.raw` (e.g. "<model> is temporarily
// rate-limited upstream. Please retry shortly, or add your own key…").
// A "message" that is blank, or is the literal text '[object Object]', carries
// zero information — the second case is what a naive `String(nonError)` or
// `${nonError}` template interpolation produces (confirmed: runStreamOnce used
// to do exactly that before the 2026-08-10 fix, and produced this literal
// string as a real session-error's ENTIRE text). Treat both as "no message"
// rather than parroting either back — error-message-standards.md requires
// every user-facing error to be specific+accurate OR general+non-committal;
// '[object Object]' is neither.
function isUsableMessage(s: unknown): s is string {
  return typeof s === 'string' && s.trim().length > 0 && s.trim() !== '[object Object]';
}

export function describeProviderError(err: any): string {
  // A thrown value isn't always an object at all — `throw 'rate limited'` is
  // legal JS and describeProviderError must not turn that into the generic
  // fallback when the string itself is the real, useful detail.
  if (typeof err === 'string') {
    return isUsableMessage(err) ? err.trim() : 'The model request failed.';
  }
  const api = err?.lastError ?? err;            // unwrap the retry wrapper
  const status = api?.statusCode ?? api?.status;
  let detail: string | undefined;
  // responseBody is usually a JSON string; some providers pre-parse into `.data`.
  const parsedBody = (() => {
    if (api?.data && typeof api.data === 'object') return api.data;
    if (typeof api?.responseBody === 'string') {
      try { return JSON.parse(api.responseBody); } catch { /* non-JSON body */ }
    }
    return undefined;
  })();
  const errObj = parsedBody?.error ?? parsedBody;
  detail = errObj?.metadata?.raw ?? errObj?.message ?? parsedBody?.message;
  if (isUsableMessage(detail)) {
    return status ? `${detail.trim()} (provider error ${status})` : detail.trim();
  }
  // No structured detail (network error, etc.) — the SDK message beats nothing,
  // as long as it's not itself the poisoned '[object Object]' literal.
  const sdkMessage = api?.message ?? err?.message;
  return isUsableMessage(sdkMessage) ? sdkMessage.trim() : 'The model request failed.';
}
// Back-filled into a tool-result when a turn is interrupted mid-step (during a
// permission ask). Every collected tool-call MUST get a matching tool-result or
// the persisted history ends on a dangling tool_call that provider APIs reject.
const CANCELED_TOOL_TEXT = 'Canceled: the user interrupted this action.';

// Streaming inactivity watchdog (native runtime). The abort-race below only
// breaks the stream on a USER interrupt — a provider that holds the socket open
// but stops emitting (OpenRouter keep-alive pings while an upstream stalls, or a
// half-open connection after a network/suspend blip) sends no chunk, no finish,
// and no error, so the turn would hang forever with the "Thinking" spinner up
// and ESC the only escape. The watchdog bounds that silence: warn the user after
// STALL_WARNING_MS, then act after a further STALL_RETRY_COUNTDOWN_MS grace.
const STALL_WARNING_MS = 60_000;          // silence tolerated before we warn
const STALL_RETRY_COUNTDOWN_MS = 15_000;  // grace after the warning before acting
// consumeStep's retry sentinel: the stream stalled but NOTHING had streamed yet,
// so the step can be safely re-run once (re-running after content streamed would
// duplicate it — fixed partIds mean the retry's deltas can't merge with the old).
const STALL_RETRY = Symbol('stall-retry');
// Thrown when silence outlasts the countdown AND a retry isn't safe (content
// already streamed, or the one allowed retry was already spent). Routes through
// send()'s catch → session-error. Message is specific + accurate (we KNOW it's a
// timeout — docs/error-message-standards.md: never guess an unverified cause).
export class StreamStallError extends Error {
  /** `phase` distinguishes the two very different silences this watchdog sees.
   *  Saying "stopped responding" while a local model is still reading a large
   *  prompt is a guessed cause — it never started, and nothing is wrong. */
  constructor(totalMs: number, phase: 'prefill' | 'streaming' = 'streaming', promptTokens = 0) {
    const secs = Math.round(totalMs / 1000);
    super(
      phase === 'prefill'
        ? `The model didn't begin responding within ${secs} seconds while reading a `
          + `${promptTokens.toLocaleString()}-token prompt. Local models process long prompts slowly; `
          + `a shorter prompt (read less of the file, or use Grep) will start faster.`
        : `The model stopped responding — no data received for ${secs} seconds. `
          + `The provider may be stalled; send your message again to retry.`,
    );
    this.name = 'StreamStallError';
  }
}

// Time-to-FIRST-token is a different animal from a mid-stream gap, and conflating
// them is what made a healthy local model look dead (Destin, 2026-07-26: a 25k-token
// ROADMAP.md prompt tripped the 75s watchdog while llama.cpp was still doing prefill).
//
// Prefill cost scales with prompt size and hardware. Rather than guess a throughput
// per backend, allow a floor plus a conservative per-token budget: PREFILL_MS_PER_TOKEN
// assumes only ~50 tokens/sec of prompt processing, far below what any real setup
// manages, so the watchdog stays a genuine liveness check without ever calling a
// working model dead. Bounded so a truly hung server still surfaces.
//
// Applied to EVERY provider, not just local: a cloud model with a small prompt lands
// at ~the old timeout anyway, and a huge cloud prompt legitimately takes longer too.
// One rule beats a provider branch that has to be kept in sync.
// Only ANNOUNCE prompt processing when the prompt is big enough that the wait
// could plausibly look like a hang. Emitting a "reading your prompt" heartbeat
// for a 30-token turn would flicker for a few hundred milliseconds and tell the
// user nothing, while adding an event to every single step of the FROZEN emit
// surface (pinned by harness-session-loop.test.ts's ordering contract).
const PROMPT_PROCESSING_NOTICE_TOKENS = 2_000;
// Covers the silent window BEFORE prefill even starts: llama-server loads the
// model on the first request, and a 122B Q4 is tens of gigabytes off disk. The
// harness gets no signal for that (nothing in here knows about model residency),
// so the base has to be generous enough to sit through it — Destin hit the
// watchdog on a 122B while it was still loading (2026-07-26).
//
// A generous base costs little now that ANY prefill progress re-arms the clock:
// the only genuinely silent window left is the load itself, and a truly dead
// server still surfaces once this elapses with nothing at all having happened.
const PREFILL_BASE_MS = 240_000;
const PREFILL_MS_PER_TOKEN = 20;          // ≈50 tok/s of prompt processing
const PREFILL_MAX_MS = 15 * 60_000;       // a hung server must still surface

export function prefillBudgetMs(promptTokens: number): number {
  const scaled = PREFILL_BASE_MS + Math.max(0, promptTokens) * PREFILL_MS_PER_TOKEN;
  return Math.min(scaled, PREFILL_MAX_MS);
}

// CONCURRENCY PRECONDITION: `send()` is NOT re-entrant. `abort`, `interrupted`,
// and `history` are single-slot per session — a second send() before the first
// resolves would corrupt turn state. Callers MUST serialize sends per session
// (NativeSessionHost does). send() hard-throws on overlap so a wiring bug
// surfaces loudly instead of silently scrambling history.
export class HarnessSession extends EventEmitter {
  private history: ModelMessage[] = [];
  private abort: AbortController | null = null;
  private interrupted = false;
  // Prompt tokens as of the PREVIOUS step of this turn. Used to report how much
  // context is genuinely NEW — llama.cpp reuses the cached prefix, so only the
  // appended messages actually get prefilled. Reset per turn; 0 means "next step
  // is a full prefill" (first step, or history rewritten by compaction, which
  // invalidates the cached prefix).
  private lastStepPromptTokens = 0;
  binding: ModelBinding;

  // Tool runtime state (Task 9). readRegistry + todos are per-SESSION runtime
  // state — NOT persisted transcript. seedHistory() clears both on resume.
  private toolByName: Map<string, NativeTool>;
  private readRegistry = new Map<string, number>();  // canonical path → mtimeMs at last Read
  private todos: ToolContext['todos'] = [];
  /** Scoped-persistence shell cwd (ROADMAP 2026-07-17): where the next Bash call
   *  starts. null → the session root. Session runtime like readRegistry/todos —
   *  never persisted to the transcript, so it resets on resume. */
  private shellCwd: string | null = null;
  private retryDelays: number[];
  // Resolved capability profile (Task 5). Drives the doom-loop window + tool
  // attachment; re-assigned by setBinding on a mid-session model swap.
  private profile: CapabilityProfile;
  /** Trigger ids already injected in this session. Survives across turns on
   *  purpose — a rule is a standing instruction, not a per-turn reminder. */
  private readonly injectedTriggerIds = new Set<string>();
  /** Delivered-image dedupe: canonical path → mtimeMs at delivery. A model that
   *  re-Reads the SAME unchanged file gets "already visible" text, not a second
   *  ~1.6k-token copy; a CHANGED file (new mtime) is delivered again. Reset on
   *  resume alongside readRegistry — after a rebuild the images in history came
   *  from a fresh disk read anyway. */
  private shownImages = new Map<string, number>();
  /** Read-only view of the resolved profile. The host needs the injection budget
   *  to size a /skill-name body, and re-resolving it there would risk drifting
   *  from what this session actually runs with (setBinding can have changed it). */
  get profileSnapshot(): Readonly<CapabilityProfile> { return this.profile; }

  // Ids of MCP servers left off the LAST buildAiTools() pass for budget reasons
  // (Task 6) — recomputed every call, so a UI reading this after buildAiTools
  // always sees the CURRENT reason, not a stale one from a prior model/binding.
  private _droppedMcpServers: string[] = [];
  /** Read-only view for the UI (a later task wires the actual surface — this
   *  task only guarantees the field exists and is accurate). Empty when every
   *  configured MCP server fit the budget. */
  get droppedMcpServers(): readonly string[] { return this._droppedMcpServers; }

  // Tool names CURRENTLY attached by syncMcpTools (not merely name-prefixed
  // "mcp__*") — tracked rather than pattern-matched so a tool that HAPPENS to
  // be named like an MCP tool but was placed in toolByName some other way
  // (e.g. harness-raw-schema.test.ts injects one directly via `extraTools` to
  // test schema passthrough in isolation, with opts.mcpServers empty) is never
  // touched by this sync. Only opts.mcpServers is this method's domain.
  // (Fix pass 1 / Finding 5: moved up here with the rest of the Task 6 MCP
  // fields — it was declared mid-class, between unrelated methods.)
  private mcpToolNames = new Set<string>();
  /** Fix pass 1 / Finding 4: the (budget, servers-array-identity) pair
   *  syncMcpTools last computed itself against — its cheap dirty-check. undefined
   *  until the first sync runs. See syncMcpTools' header for why this exists. */
  private mcpSyncedFor: { budget: number; servers: ReadyServer[] | undefined } | undefined;

  constructor(private opts: HarnessSessionOpts, private modelFactory: ModelFactory) {
    super();
    this.binding = opts.binding;
    this.toolByName = new Map((opts.tools ?? []).map((t) => [t.name, t]));
    this.retryDelays = opts.retryDelays ?? [1000, 2000, 4000];
    this.profile = opts.profile ?? CLOUD_DEFAULT;
  }

  /** Resume path: NativeSessionHost rebuilds history from stored events. */
  seedHistory(messages: ModelMessage[]): void {
    this.history = messages;
    // Reset-on-resume (spec §2.5 — Task 10 relies on this): a resumed session
    // has NO live read-before-edit state and NO todo list. Those are process/
    // session runtime, never persisted to the transcript. Clearing here prevents
    // a stale mtime (or a leftover todo list) from a prior process from wrongly
    // satisfying the read-before-edit gate on the first edit after resume.
    this.readRegistry.clear();
    this.shownImages.clear();
    this.todos.length = 0;
    this.shellCwd = null; // a resumed session starts back at the workspace root
  }

  /** Mid-session model swap (next turn uses the new binding). A swap can cross
   *  capability tiers (e.g. cloud → small local), so the host re-resolves the
   *  profile and passes it in; applied only when provided. */
  setBinding(binding: ModelBinding, contextLength?: number | null, profile?: CapabilityProfile): void {
    this.binding = binding;
    if (contextLength !== undefined) this.opts.contextLength = contextLength;
    if (profile) this.profile = profile;
  }

  /** Effective system prompt: the assembled one (Task 11) or the harness's own. */
  private get systemText(): string { return this.opts.systemPrompt ?? this.opts.harness.systemPrompt; }

  /** Chars/4 estimate of everything the model currently holds — system prompt plus
   *  the whole history. ONLY a fallback for when the provider reports no usage;
   *  a measured prompt-token count is always preferred. */
  private estimateContextTokens(): number {
    return Math.ceil(this.systemText.length / APPROX_CHARS_PER_TOKEN)
      + messagesTokens(this.history);   // binary-aware — see message-size.ts
  }

  private emitEvent(type: TranscriptEvent['type'], data: TranscriptEvent['data']): void {
    const event: TranscriptEvent = { type, sessionId: this.opts.sessionId, uuid: randomUUID(), timestamp: Date.now(), data };
    this.emit('transcript-event', event);
  }

  /** Append any project rules / nested project instructions that the paths this
   *  step touched activate (M3 item 3).
   *
   *  As a MESSAGE, never a system-prompt edit. prompt-assembly.ts is byte-stable
   *  by construction and a mid-session change would discard the KV cache prefix
   *  every local model reuses, turning a cheap follow-up turn into a full
   *  re-prefill of the entire conversation.
   *
   *  ONCE per trigger per session. A rule re-sent after every Read of a matching
   *  file would dominate the conversation and blow the window it was sized
   *  against — and repetition does not make a model follow a rule harder.
   *
   *  Bash is skipped: its permission subject is a command string, not a path,
   *  so feeding it to a path matcher would be a category error.
   */
  private injectPathTriggers(calls: ToolCall[]): void {
    const index = this.opts.triggers;
    if (!index) return;
    for (const call of calls) {
      // Same reasoning as the path guard: matching a rule glob against a bash
      // command or a skill id is a category error, not a near-miss.
      if (NON_PATH_SUBJECT_TOOLS.has(call.toolName)) continue;
      const tool = this.toolByName.get(call.toolName);
      const subject = tool?.permissionSubject(call.input as any);
      if (!subject) continue;
      for (const t of index.match(subject)) {
        if (this.injectedTriggerIds.has(t.id)) continue;
        this.injectedTriggerIds.add(t.id);
        const fitted = fitInjection(t.body, this.profile.injectionBudgetTokens);
        this.history.push({
          role: 'user',
          content: `<project-rule source="${t.source}">\n${fitted.text}\n</project-rule>`,
        });
      }
    }
  }

  /** Add or remove the Skill tool to match the CURRENT profile (M3 item 1).
   *
   *  Skill is the one conditional tool: its description lists every offered
   *  skill's id and one-liner, and that rides the schema on every turn, so a
   *  small window cannot afford it. Those sessions still reach skills through
   *  the user-invoked /skill-name path.
   *
   *  Run per buildAiTools rather than once in the constructor because
   *  setBinding() re-resolves the profile on a model swap: a tool attached under
   *  a 128k model must come back OFF when the user switches to an 8k one, and
   *  back on when they switch back. The has()/delete() pair makes both
   *  directions idempotent, so the filesystem scan happens once per attachment,
   *  not once per turn.
   */
  private syncSkillTool(): void {
    const wanted = this.profile.exposeSkillCatalog;
    if (!wanted) { this.toolByName.delete('Skill'); return; }
    if (this.toolByName.has('Skill')) return;

    const catalog = this.opts.skillCatalog ?? createSkillCatalog();
    const allow = this.opts.harness.skills;
    // Per-preset allowlist (the manifest's `skills` field, dead until now):
    // Assistant may offer fewer skills than Coder. load() stays unscoped — an
    // allowlist decides what the model is TOLD about, and a request for anything
    // outside it can't arrive because it was never advertised.
    const scoped: SkillCatalog = allow
      ? { list: () => catalog.list().filter((s) => allow.includes(s.id)), load: (id) => catalog.load(id) }
      : catalog;

    // No offerable skills → no tool. A catalog that lists nothing still reads as
    // "you may load a skill", which invites the model to invent an id and burn a
    // step discovering it doesn't exist.
    if (scoped.list().length === 0) return;
    this.toolByName.set('Skill', createSkillTool(scoped));
  }

  /** Add or remove MCP server tools to match the CURRENT profile's budget
   *  (Task 6, spec §6).
   *
   *  WHOLE SERVERS ONLY: a server whose search tool is attached but whose send
   *  tool is not is worse than an absent server — the model plans against a
   *  capability it then cannot complete. So this walks registry order
   *  accumulating cost, and the FIRST server that would push spend over
   *  budget stops the walk entirely (`break`, not `continue`) — every server
   *  from that point on is dropped too, which is what keeps the kept set a
   *  contiguous PREFIX of registry order (pinned by
   *  mcp-gating.test.ts "drops from the END…") rather than a scattered
   *  best-fit subset. Drop order is registry order from the END so the user
   *  controls what survives by ordering their own list.
   *
   *  Re-run per buildAiTools (not once in the constructor) for the same
   *  reason syncSkillTool is: setBinding() re-resolves the profile on a model
   *  swap, so a server attached under a 128k model must come back OFF on a
   *  swap to an 8k one, and back on when swapping back.
   *
   *  Fix pass 1 / Finding 4: buildAiTools() runs on every turn (see its own
   *  call site), and until this fix syncMcpTools rebuilt from scratch on
   *  EVERY one of those calls regardless of whether anything actually
   *  changed — mcpToolsFor() re-allocates every tool closure and
   *  estimateToolSchemaTokens() re-JSON.stringifies every server's raw schema,
   *  which is real, avoidable work on the common case (no binding swap this
   *  turn). syncSkillTool has a real dirty-check (`toolByName.has('Skill')`);
   *  this one didn't, despite the header above claiming the same "re-run
   *  per buildAiTools" reasoning. mcpSyncedFor restores that parity: only the
   *  budget VALUE and the mcpServers ARRAY REFERENCE are compared (not deep
   *  equality), because those are the only two things this method's output
   *  depends on — setBinding() always hands in a freshly resolved profile
   *  object when the budget changes (mcp-gating.test.ts's re-gate test below
   *  relies on exactly that), and opts.mcpServers only ever gets a new array
   *  reference from NativeSessionHost re-acquiring (create/resume), never
   *  mid-session. Clearing this sync's OWN previously-attached names first
   *  (on an actual re-sync) makes both directions idempotent. */
  private syncMcpTools(): void {
    const rawServers = this.opts.mcpServers;
    const budget = this.profile.mcpToolBudgetTokens;
    // Nothing this method reads has changed since the last sync — skip the
    // teardown/rebuild entirely. `rawServers` (not `servers` below) is the
    // comparison target: defaulting to `[]` here would allocate a NEW empty
    // array on every undefined-mcpServers call, which would never compare
    // equal to itself and defeat the whole point of the check.
    if (this.mcpSyncedFor && this.mcpSyncedFor.budget === budget && this.mcpSyncedFor.servers === rawServers) return;
    this.mcpSyncedFor = { budget, servers: rawServers };

    for (const name of this.mcpToolNames) this.toolByName.delete(name);
    this.mcpToolNames.clear();
    const servers = rawServers ?? [];
    this._droppedMcpServers = [];
    let spent = 0;
    for (let i = 0; i < servers.length; i++) {
      const server = servers[i];
      const tools = mcpToolsFor(server);
      const cost = estimateToolSchemaTokens(tools);
      if (spent + cost > this.profile.mcpToolBudgetTokens) {
        // Everything from HERE ON is dropped (see header) — not just this one
        // server — so the recorded list must cover the whole remaining tail,
        // or the UI would under-report what the user actually lost.
        this._droppedMcpServers = servers.slice(i).map((s) => s.id);
        // Fix (Finding 5): droppedMcpServers has had zero non-test consumers
        // since it was written — a UI reading it is still a later task, but
        // until one exists this is the ONLY place a dropped-for-budget server
        // is observable at all. One line naming the whole dropped tail.
        log('WARN', 'HarnessSession', 'MCP server(s) dropped from this session — over the tool budget', {
          sessionId: this.opts.sessionId, droppedServerIds: this._droppedMcpServers, mcpToolBudgetTokens: this.profile.mcpToolBudgetTokens,
        });
        break;
      }
      spent += cost;
      for (const t of tools) { this.toolByName.set(t.name, t); this.mcpToolNames.add(t.name); }
    }
  }

  /** NativeTool → ai `tool({description, inputSchema})` WITHOUT execute, keyed by
   *  name. No execute => the SDK emits 'tool-call' parts and finishes with
   *  'tool-calls' WITHOUT looping (verified ai@7 contract) — WE own the loop. */
  private buildAiTools(): Record<string, any> {
    // Plain-chat model (profile.supportsTools === false): attach NO tools so the
    // SDK never sends a tool schema. WHY: a small local model the registry marks
    // tool-less would otherwise emit malformed tool-calls we can't honor. Also
    // clear any stale drop list from a PRIOR (tool-capable) binding — "no tools
    // at all" is a different reason than "dropped for budget", and leaving the
    // old list around would misreport why MCP servers are unavailable.
    if (!this.profile.supportsTools) { this._droppedMcpServers = []; return {}; }
    this.syncSkillTool();
    this.syncMcpTools();
    // Simplified presentation (spec §4.2): small local models get each tool's
    // compact shortDescription (falling back to the full description when a tool
    // defines none) so the schema stays small enough for a weak model to follow.
    // The tool SET is identical either way — we only shrink the wording.
    const simplified = this.profile.maxToolPresentation === 'simplified';
    const out: Record<string, any> = {};
    for (const t of this.toolByName.values()) {
      // MCP tools carry the server's own JSON Schema; everything else is zod.
      const schema = t.rawInputSchema ? jsonSchema(t.rawInputSchema as any) : zodSchema(t.inputSchema);
      // descriptionFor lets a tool vary its wording by capability (Read + vision).
      // Simplified presentation still wins for small local models — shortDescription
      // stays the schema-size escape hatch.
      const full = t.descriptionFor?.({ supportsVision: this.profile.supportsVision }) ?? t.description;
      out[t.name] = tool({ description: simplified ? (t.shortDescription ?? full) : full, inputSchema: schema });
    }
    return out;
  }

  /** Assistant history message: text part (if any) + one tool-call part per call.
   *  Shape pinned by the ai@7 contract test (input is the PARSED object). */
  private assistantMessage(text: string, toolCalls: ToolCall[]): ModelMessage {
    const content: any[] = [];
    if (text) content.push({ type: 'text', text });
    for (const c of toolCalls) content.push({ type: 'tool-call', toolCallId: c.toolCallId, toolName: c.toolName, input: c.input });
    return { role: 'assistant', content } as ModelMessage;
  }

  /** Tool-result history part. The `output: { type:'text', value }` shape is
   *  pinned (Task 1) — `result`/other field names throw AI_InvalidPromptError.
   *  `images` defaults to `[]` so every existing caller (including the interrupt
   *  back-fill, which passes only `text`) keeps emitting the byte-identical
   *  text-only shape. When images ARE present, the output becomes ai@7's
   *  'content' shape — @ai-sdk/anthropic maps it to native tool_result image
   *  blocks; every other wire is rewritten by adaptForWire (wire-adapter.ts). */
  private toolResultPart(call: ToolCall, text: string, images: Array<{ mediaType: string; data: Buffer }> = []): any {
    if (!images.length) {
      return { type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: { type: 'text', value: text } };
    }
    return {
      type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName,
      output: {
        type: 'content',
        value: [
          { type: 'text', text },
          ...images.map((i) => ({ type: 'file', mediaType: i.mediaType, data: { type: 'data', data: i.data } })),
        ],
      },
    };
  }

  /** Oldest-first truncation to fit the context window. Always keeps the
   *  newest user message; chars/4 is a deliberate estimate, not a tokenizer. */
  private fitToContext(messages: ModelMessage[]): ModelMessage[] {
    const ctx = this.opts.contextLength ?? 32_768;
    const budgetTokens = ctx - (this.opts.harness.limits?.maxTokens ?? 4096) - 1024; // output + margin
    // Degenerate case: a tiny contextLength (a real Plan B possibility — a small
    // local model with, say, a 2k window) can make budgetTokens zero or negative.
    // The `kept.length > 0` gate below means we ALWAYS keep the newest message
    // regardless of budget, so history collapses to that single message rather
    // than erroring. That's intentional — one turn through a tiny model beats a
    // hard failure — so no clamp is applied here.
    const total0 = Math.ceil(this.systemText.length / APPROX_CHARS_PER_TOKEN);
    let total = total0;
    const kept: ModelMessage[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const size = messageTokens(messages[i]);   // binary-aware — see message-size.ts
      if (kept.length > 0 && total + size > budgetTokens) break;
      kept.unshift(messages[i]);
      total += size;
    }
    // Pair-aware front trim: oldest-first truncation can cut BETWEEN an
    // assistant(tool-call) and its paired tool result, leaving the window
    // starting on an orphaned role:'tool' message OR an assistant tool-call
    // whose result got dropped — both are unpaired tool_calls that provider
    // APIs 400 on. Drop leading messages until the window starts on a user or
    // plain-text-assistant message. (An assistant tool-call and its adjacent
    // tool result are dropped together as a pair.)
    while (kept.length > 0) {
      const first = kept[0];
      const isOrphanToolResult = first.role === 'tool';
      const isToolCallOpener = first.role === 'assistant' && Array.isArray(first.content)
        && first.content.some((p: any) => p && p.type === 'tool-call');
      if (isOrphanToolResult || isToolCallOpener) { kept.shift(); continue; }
      break;
    }
    // The two rules above are individually right and together could return NOTHING:
    // the size loop always keeps the newest message even when it alone blows the
    // budget ("history collapses to that single message rather than erroring"),
    // but if that survivor is a tool result, the pair-aware trim then drops it as
    // an orphan — and the driver sends an empty prompt, which providers reject
    // with "Invalid prompt: messages must not be empty".
    //
    // Found 2026-07-26 dogfooding: asking a local model to read ROADMAP.md
    // returned a 100 KB tool result (read.ts raises its own cap to 100_000 chars)
    // that exceeded the window on its own, and the turn died. Latent on master,
    // not introduced by Plan C — Plan C just made big local reads routine.
    if (kept.length === 0) return this.salvageOversizedTail(messages, budgetTokens, total0);
    return kept;
  }

  /** Last resort for fitToContext: the newest exchange doesn't fit even alone.
   *
   *  Rather than dropping the tool result (which leaves the model staring at its
   *  own unanswered request — it just re-runs the same call until the doom-loop
   *  guard trips) we keep the PAIR intact and shrink the result's text to the
   *  budget. Truncating tool output to fit is exactly what compaction's
   *  pruneToolOutputs does, so this is the established shape, not a new idea.
   *
   *  Returns [user?, assistant(tool-call), tool(truncated)] — a valid window that
   *  preserves the pairing invariant the front trim exists to protect. */
  private salvageOversizedTail(messages: ModelMessage[], budgetTokens: number, systemTokens: number): ModelMessage[] {
    const toolIdx = messages.map((m) => m.role).lastIndexOf('tool');
    // No tool message means the oversized survivor was a plain user/assistant
    // message, which the front trim never drops — keep the newest and move on.
    if (toolIdx < 0) return messages.slice(-1);

    const call = messages[toolIdx - 1];
    const hasCall = !!call && call.role === 'assistant';
    // The user turn that started this exchange, when there is one — it is what
    // tells the model WHY the tool ran, and it is small.
    let userIdx = -1;
    for (let i = (hasCall ? toolIdx - 2 : toolIdx - 1); i >= 0; i--) {
      if (messages[i].role === 'user') { userIdx = i; break; }
    }
    const head: ModelMessage[] = [];
    if (userIdx >= 0) head.push(messages[userIdx]);
    if (hasCall) head.push(call);

    // Whatever budget is left after the system prompt and the head goes to the
    // tool output. Floored at a usable amount so a hostile budget still yields a
    // readable fragment rather than an empty string.
    const usedTokens = systemTokens + head.reduce((n, m) => n + messageTokens(m), 0);   // binary-aware
    const availableChars = Math.max(2_000, (budgetTokens - usedTokens) * APPROX_CHARS_PER_TOKEN);
    return [...head, truncateToolMessage(messages[toolIdx], availableChars)];
  }

  // Below this many tokens a span isn't worth a model round-trip to summarize
  // (spends a call to save almost nothing). Also the thrash floor — see I3 note
  // in maybeCompact.
  private static readonly MIN_SUMMARIZE_SPAN_TOKENS = 500;

  /** Compaction thresholds scaled to the model window. Big models protect ~40k
   *  and only prune when it saves ≥20k; tiny local windows scale those down so
   *  the trigger/prune/protect bands are actually REACHABLE in an 8k (or smaller)
   *  window — otherwise a small model would never compact until it 400'd.
   *  CAVEAT (very small windows, ctx ~4–8k): fitToContext's own budget
   *  (ctx − maxTokens − 1024) can land at or below protectedTokens here, so a
   *  freshly-written summary may be largely re-truncated by fitToContext anyway.
   *  Accepted — one degraded turn beats a hard 400 — but documented so it isn't
   *  mistaken for a bug. */
  private compactionConfig(): CompactionConfig {
    const ctx = this.opts.contextLength ?? 32_768;
    const big = ctx >= 100_000;
    return { contextLength: ctx, triggerRatio: 0.75, protectedTokens: big ? 40_000 : Math.floor(ctx * 0.4), minPruneSavings: big ? 20_000 : Math.floor(ctx * 0.1), pruneToChars: 2000 };
  }

  /** Two-stage compaction (spec §4.4). PRUNE first (nearly lossless, shrinks the
   *  summarize span too); if pruning can't get under budget, SUMMARIZE the condensed
   *  span, keeping the last 2 user-delimited turns verbatim, and emit compact-summary.
   *  FAIL-SAFE: a summary that throws or comes back empty leaves the pruned history —
   *  fitToContext (in consumeStep) is the hard floor, so the turn never bricks. */
  private async maybeCompact(model: LanguageModel, lastInputTokens: number): Promise<void> {
    const cfg = this.compactionConfig();
    const decision = planCompaction(this.history, cfg, lastInputTokens);
    if (decision.action === 'none') return;
    this.history = pruneToolOutputs(this.history, cfg);   // always prune first
    if (decision.action === 'prune') return;
    const cut = this.summarizeCutIndex();
    if (cut <= 0) return;                                  // nothing safely condensable → pruned history stands
    const keep = this.history.slice(cut);
    const span = this.history.slice(0, cut);              // already pruned
    // I3 thrash guard: if the last-2-turns `keep` span ALONE exceeds the trigger
    // (e.g. a fresh 6k-token tool result in an 8k window), the condensable `span`
    // is tiny yet planCompaction keeps saying 'summarize' every step. Re-summarizing
    // a near-empty span burns a model call + emits a dead compact-summary each step
    // (~25/turn). Bail when the span is trivial — the pruned history stands and
    // fitToContext remains the floor.
    if (span.length <= 1 || estimateTokens(span) < HarnessSession.MIN_SUMMARIZE_SPAN_TOKENS) return;
    let summary = '';
    try { summary = await this.generateSummary(model, span); } catch { summary = ''; }
    if (!summary.trim()) return;                          // FAIL-SAFE: no summary → leave pruned history
    // Existing frozen event (no new type). `summary` is the canonical field the
    // renderer reads (types.ts / App.tsx / BubbleFeed.tsx). `autoCompaction` tags
    // this as a SPONTANEOUS native compaction so the renderer surfaces the marker
    // even though the manual-/compact `compactionPending` flag was never set —
    // CC's own compact-summary events never carry it, so the manual path is
    // untouched.
    this.emitEvent('compact-summary', { summary, autoCompaction: true });
    this.history = [{ role: 'user', content: `[Earlier conversation summary]\n${summary}` } as ModelMessage, ...keep];
  }

  // Live prefill progress from llama.cpp, forwarded onto the SAME
  // assistant-thinking notice the size-only estimate already drives — the UI
  // upgrades in place from "reading N tokens" to a real fraction + countdown.
  //
  // Throttled: llama-server reports roughly once per batch, but a small batch on
  // fast hardware can produce a burst, and every emit crosses IPC and re-renders
  // the indicator. One update per 400ms is well past the eye's ability to read a
  // changing number. The FINAL reading always goes through, so the bar cannot be
  // left stranded at 87%.
  private lastPrefillEmitAt = 0;
  /** Re-arm hook for the CURRENT step's stall watchdog, installed by
   *  runStreamOnce. Prefill progress is proof of life and must reset the clock —
   *  without this a slow-but-healthy prefill trips the watchdog, gets KILLED and
   *  RETRIED from scratch, which is what made progress appear to reset itself
   *  (Destin, 2026-07-26). */
  private rearmStallWatchdog: (() => void) | null = null;
  private emitPrefillProgress(p: PrefillProgress): void {
    // Prefill progress after the first token would be describing work the user
    // can already see the result of; the notice is a pre-output affordance only.
    if (this.abort == null) return;
    // Proof of life FIRST, before any throttling — a throttled-away report must
    // still reset the stall clock, or the throttle itself could cause a stall.
    this.rearmStallWatchdog?.();
    const report = toReport(p);
    const isFinal = report.newProcessed >= report.newTotal;
    const now = Date.now();
    if (!isFinal && now - this.lastPrefillEmitAt < 400) return;
    this.lastPrefillEmitAt = now;
    this.emitEvent('assistant-thinking', {
      promptProcessing: {
        // NEW work, not the whole prompt — matching the pre-progress notice's own
        // `newTokens` estimate, so the denominator does not jump (and the
        // percentage fall) the moment the first live report replaces it.
        promptTokens: report.newTotal,
        budgetMs: 0,
        source: this.prefillSource,
        processed: report.newProcessed,
        cached: report.cache,
        etaMs: report.etaMs,
        // The renderer extrapolates between these sparse per-batch reports and
        // needs the measured rate, which is processed/timeMs.
        timeMs: report.timeMs,
      },
    });
  }

  /** What grew the context for the CURRENT step — set when the step opens so the
   *  async progress callbacks can label themselves without re-deriving it. */
  private prefillSource: 'prompt' | 'tool-output' = 'prompt';

  /** USER-INITIATED compaction (the /compact command and the Context popup's
   *  "Compact conversation" button), as opposed to maybeCompact's automatic,
   *  threshold-driven one.
   *
   *  Differences from maybeCompact, all deliberate:
   *   - No `planCompaction` trigger check and no MIN_SUMMARIZE_SPAN thrash guard.
   *     Those exist to stop the AUTOMATIC path burning model calls on its own
   *     initiative; when the user explicitly asks, "you're not full enough yet"
   *     would be the app second-guessing an explicit instruction.
   *   - Emits `compact-summary` WITHOUT `autoCompaction`. That flag exists purely
   *     to let a spontaneous compaction bypass the renderer's `compactionPending`
   *     guard. The manual path already sets `compactionPending` (the dispatcher
   *     does it before calling us), so it must take the ORDINARY route — setting
   *     `auto` here would make the manual marker skip its own pending state.
   *   - Returns a REASON on refusal rather than resolving silently, so the caller
   *     can tell the user why nothing happened (docs/error-message-standards.md).
   *     A silent no-op is what this whole milestone exists to delete.
   *
   *  Takes `this.abort` for the duration: that makes the summary stream
   *  interruptible via interrupt() exactly like a turn's, and makes a concurrent
   *  send() hit the existing re-entrancy guard instead of mutating history
   *  underneath us. Cleared in a finally so a throw can't brick the session. */
  async compactNow(): Promise<{ ok: true } | { ok: false; reason: 'turn-in-flight' | 'nothing-to-compact' | 'summary-failed' }> {
    if (this.abort) return { ok: false, reason: 'turn-in-flight' };
    this.abort = new AbortController();
    try {
      const cfg = this.compactionConfig();
      // Prune first — same order as the automatic path, and it shrinks the span
      // the model has to read before we pay for a summary.
      this.history = pruneToolOutputs(this.history, cfg);
      const cut = this.summarizeCutIndex();
      // <2 user turns means there is no boundary we can cut on without risking
      // splitting a tool-call/result pair, so there is genuinely nothing to do.
      if (cut <= 0) return { ok: false, reason: 'nothing-to-compact' };
      const keep = this.history.slice(cut);
      const span = this.history.slice(0, cut);
      if (span.length === 0) return { ok: false, reason: 'nothing-to-compact' };
      let summary = '';
      try {
        const model = await this.modelFactory(this.binding, {
          serialToolCalls: this.profile.constrainToolArgs && !this.profile.supportsParallelToolCalls,
        });
        summary = await this.generateSummary(model, span);
      } catch {
        summary = '';
      }
      // FAIL-SAFE, same as the automatic path: a failed or empty summary leaves
      // the PRUNED history in place rather than discarding anything. The user
      // still gets a real (if smaller) reduction, and never a lost conversation.
      if (!summary.trim()) return { ok: false, reason: 'summary-failed' };
      this.emitEvent('compact-summary', { summary });
      this.history = [{ role: 'user', content: `[Earlier conversation summary]\n${summary}` } as ModelMessage, ...keep];
      return { ok: true };
    } finally {
      this.abort = null;
    }
  }

  /** /clear as a CONTEXT BARRIER (M3 item 2, Destin's call 2026-07-26).
   *
   *  The session JSONL is append-only with a write-once header, so "clear"
   *  genuinely cannot erase history. Instead it drops the model's in-memory
   *  history and appends a `context-clear` marker; `rebuildHistory` treats that
   *  marker as a barrier on resume, so the model never sees anything before it
   *  while the conversation keeps its file, its id and its full readable
   *  scrollback. Chosen over "start a new session" so a reset doesn't scatter
   *  half-conversations through the user's history.
   *
   *  Refuses while a turn is in flight rather than yanking history out from
   *  under a running turn — the same reasoning (and the same honest coded
   *  refusal) as compactNow. */
  clearHistory(): { ok: true } | { ok: false; reason: 'turn-in-flight' } {
    if (this.abort) return { ok: false, reason: 'turn-in-flight' };
    this.history = [];
    // Emitted (not just persisted) so the store appends it through the host's
    // normal chain AND every attached surface — other windows, the remote web
    // client — learns the conversation was cleared. On replay this same event
    // resets the visible timeline, keeping what the user sees after a restart
    // identical to what they saw when they cleared.
    this.emitEvent('context-clear', {});
    return { ok: true };
  }

  /** Index where the last 2 user-message-delimited turns begin (0 if <2 turns). */
  private summarizeCutIndex(): number {
    const userIdx: number[] = [];
    this.history.forEach((m, i) => { if ((m as any).role === 'user') userIdx.push(i); });
    return userIdx.length < 2 ? 0 : userIdx[userIdx.length - 2];
  }

  /** Model-generated summary of the condensed span. Bounds the span first so the
   *  summary call itself can't overflow (hard-trim oldest messages until it fits ~60%
   *  of the window). The caller wraps this in try/catch (fail-safe).
   *
   *  C1 — the summary runs on the SAME (possibly stalled) local model this whole
   *  branch targets, so we consume it EXACTLY like consumeStep does: an explicit
   *  iterator raced against BOTH the turn's abort signal AND a wall-clock timeout.
   *  A plain `for await` would block forever on a provider that stops emitting
   *  without honoring abort — ESC could not break it, send() would never resolve,
   *  and this.abort would stay non-null, bricking every future send() via the
   *  re-entrancy guard. On abort OR timeout we stop consuming and return whatever
   *  partial text we have (the fail-safe tolerates ''): the summary never wedges
   *  the turn. */
  private async generateSummary(model: LanguageModel, span: ModelMessage[]): Promise<string> {
    const cfg = this.compactionConfig();
    let bounded = span;
    while (estimateTokens(bounded) > cfg.contextLength * 0.6 && bounded.length > 1) bounded = bounded.slice(1);
    const result = streamText({ model, system: 'You compress conversation history. Be faithful and concise.', messages: [...bounded, { role: 'user', content: summarizePrompt() } as ModelMessage], abortSignal: this.abort!.signal });

    // Race iterator.next() against the abort signal AND a 30s wall-clock floor —
    // the same hardening consumeStep uses, since a stalled local stream honors
    // neither on its own.
    const iterator = (result.textStream as AsyncIterable<string>)[Symbol.asyncIterator]();
    const abortSignal = this.abort!.signal;
    const stopPromise = new Promise<'stop'>((resolve) => {
      if (abortSignal.aborted) { resolve('stop'); return; }
      const timer = setTimeout(() => resolve('stop'), 30_000);
      abortSignal.addEventListener('abort', () => { clearTimeout(timer); resolve('stop'); }, { once: true });
    });

    let text = '';
    while (true) {
      const nextPromise = iterator.next();
      const chunk = await Promise.race([nextPromise, stopPromise]);
      if (chunk === 'stop') {
        // Abort or timeout won: release the reader/socket (a provider that ignores
        // abort would otherwise leak it) and stop with the partial text so far.
        nextPromise.catch(() => {});
        iterator.return?.().catch(() => {});
        break;
      }
      if (chunk.done) break;
      if (chunk.value) text += chunk.value;
    }
    // WHY the summary call's tokens are NOT folded into turnUsage: awaiting
    // result.usage would only settle once the stream ends cleanly — on the
    // abort/timeout break above it may never settle, which would reintroduce the
    // exact hang C1 exists to prevent. Under-reporting the (small) summary-call
    // tokens is the accepted trade for a summary that can never wedge the turn.
    return text.trim();
  }

  /** Run a user-invoked skill (/skill-name, M3 item 1).
   *
   *  Same turn machinery as send(), with ONE difference that matters: the
   *  transcript event is `skill-invoked`, not `user-message`. The model's history
   *  gets the full instructions; the UI gets a compact card. Sending the body as
   *  a user message rendered 26k characters of SKILL.md as a chat bubble
   *  (Destin, 2026-07-28) — the timeline should show what the user DID.
   *
   *  The body is persisted on the event so `rebuildHistory` can restore the same
   *  model history on resume. Without it a resumed conversation would replay a
   *  turn whose opening move has no visible cause.
   */
  async runSkill(inv: { skillId: string; displayName: string; body: string; args?: string; skillPath?: string }): Promise<void> {
    const historyText = inv.args ? `${inv.body}\n\n${inv.args}` : inv.body;
    return this.beginTurn(historyText, () => this.emitEvent('skill-invoked', {
      skillId: inv.skillId, displayName: inv.displayName, args: inv.args,
      body: inv.body, skillPath: inv.skillPath,
    }));
  }

  /** `attachments` are absolute paths to files the user attached in the composer.
   *  Image ones become image parts on the user message when the model can see
   *  them; everything else is ignored here and reaches the model as the path
   *  text the composer already put in `text`.
   *
   *  WHY images ride ALONGSIDE the text rather than replacing it: `text` is the
   *  dedup key. The renderer's optimistic bubble is confirmed by an EXACT match
   *  against the `user-message` event's text (see native-send.ts), so the string
   *  must stay byte-identical to what the composer built. The paths therefore
   *  remain in the text AND the pixels are attached — the model gets both, and
   *  the bubble still resolves. */
  async send(text: string, attachments: string[] = []): Promise<void> {
    // Attachments ride the persisted event (paths only — events carry no binary)
    // so rebuildHistory can restore the pixels on resume. Emitted only when
    // present to keep the no-attachment event byte-identical to before (#290
    // follow-up fix 2).
    return this.beginTurn(text, () => this.emitEvent('user-message', attachments.length ? { text, attachments } : { text }), attachments);
  }

  /** Image parts for a user message, or [] when the model cannot see images / none
   *  were attached. Unreadable or oversized files are SKIPPED rather than thrown:
   *  a turn must not die because one attachment went missing between the composer
   *  and the send, and the path is still in the message text either way. */
  private imagePartsFor(attachments: string[]): Array<{ type: 'file'; mediaType: string; data: Buffer }> {
    if (!attachments.length || !this.profile.supportsVision) return [];
    const parts: Array<{ type: 'file'; mediaType: string; data: Buffer }> = [];
    for (const p of attachments) {
      const img = readImageFromDisk(p);   // shared reader — one table, one cap (fix 3)
      if (img) parts.push({ type: 'file', mediaType: img.mediaType, data: img.data });
    }
    return parts;
  }

  /** Resolve a tool's promised image paths into deliverable parts, charging the
   *  per-turn budget and the per-session dedupe, and AMENDING the result text
   *  with a named note for every skip — the note rides the same text the model
   *  and the transcript see, so promise and delivery can never disagree.
   *  `budget` is a beginTurn-scoped local shared across every tool call in the
   *  turn (mutated in place), which is what makes the count/byte caps PER-TURN
   *  rather than per-call. */
  private resolveToolImages(
    payload: ToolResultPayload,
    budget: { count: number; bytes: number },
  ): { text: string; images: Array<{ path: string; mediaType: string; data: Buffer }> } {
    const paths = payload.images ?? [];
    if (!paths.length) return { text: payload.text, images: [] };
    let text = payload.text;
    const images: Array<{ path: string; mediaType: string; data: Buffer }> = [];
    for (const p of paths) {
      // The tool already stat'd this file before promising it (resolve-before-
      // promise, Task 4) — but time passed between that stat and this delivery,
      // so it can have vanished. Re-stat rather than trust the promise.
      let mtime: number;
      try { mtime = fs.statSync(p).mtimeMs; } catch {
        text += `\n[image not attached: ${p} is no longer readable]`; continue;
      }
      if (this.shownImages.get(p) === mtime) {
        text += `\n[image not re-attached: ${p} is unchanged and already visible earlier in this conversation]`; continue;
      }
      if (budget.count >= MAX_IMAGES_PER_TURN) {
        text += `\n[image not attached: over the ${MAX_IMAGES_PER_TURN}-images-per-turn budget — ask again next turn if you still need it]`; continue;
      }
      const img = readImageFromDisk(p);
      if (!img) { text += `\n[image not attached: ${p} vanished or exceeds the per-image size limit]`; continue; }
      if (budget.bytes + img.data.length > MAX_IMAGE_BYTES_PER_TURN) {
        text += `\n[image not attached: over the ${MAX_IMAGE_BYTES_PER_TURN / (1024 * 1024)} MB-per-turn image budget]`; continue;
      }
      budget.count += 1; budget.bytes += img.data.length;
      this.shownImages.set(p, mtime);
      images.push({ path: p, mediaType: img.mediaType, data: img.data });
    }
    return { text, images };
  }

  /** The turn driver. `emit` names how this turn ENTERED the conversation — a
   *  typed message, or a skill invocation — which is the only thing that differs
   *  between send() and runSkill(). Everything downstream is identical. */
  private async beginTurn(text: string, emit: () => void, attachments: string[] = []): Promise<void> {
    // Re-entrancy guard: a non-null abort means a turn is already streaming.
    // Throw loudly rather than corrupt the single-slot turn state (see the
    // class-level CONCURRENCY PRECONDITION note).
    if (this.abort) {
      throw new Error('HarnessSession: a turn is already in flight — callers must serialize send()/runSkill() per session.');
    }
    this.interrupted = false;
    emit();
    // A plain string when there are no image parts — that is the byte-identical
    // shape every existing test and rebuildHistory() already assert on, so the
    // no-attachment path must not become a one-element parts array.
    const imageParts = this.imagePartsFor(attachments);
    this.history.push(imageParts.length
      ? { role: 'user', content: [{ type: 'text', text }, ...imageParts] } as any
      : { role: 'user', content: text });
    this.abort = new AbortController();
    this.lastStepPromptTokens = 0;   // a new turn always begins with a full prefill

    const startedAt = Date.now();
    const turnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    // Time spent GENERATING, summed over the turn's steps. Not wall-clock: a turn
    // includes prefill, tool execution and permission waits, and dividing output
    // tokens by all of that reports a decode speed several times slower than the
    // model's real one (found in the 2026-07-28 audit).
    let generationMs = 0;
    const recentCalls: string[] = [];           // doom-loop window (turn-level)
    const imageBudget = { count: 0, bytes: 0 };  // per-turn image delivery budget (spec "Budgets")
    // Budget precedence: an explicit harness override wins; otherwise the step
    // ceiling is chosen by MODEL tier (frontier models sustain longer autonomous
    // runs than the conservative 25 — see model-step-budget.ts).
    const maxSteps = this.opts.harness.limits?.maxSteps ?? stepBudgetFor(this.binding.modelId);
    let stepsSinceApproval = 0;
    let stopReason = 'end_turn';
    // Latest step's partial text — the ONLY thing the catch pushes to history
    // (earlier steps already pushed their assistant + tool messages). Reset per
    // step; on an immediate-error retry it stays '' so no duplicate is pushed.
    let partialAssistantText = '';

    try {
      // Serial-only when the profile constrains args AND the model can't do parallel
      // tool calls (spec §4.2 — small local models): the factory injects
      // parallel_tool_calls:false on the local-engine branch. Cloud factories ignore it.
      const model = await this.modelFactory(this.binding, {
        serialToolCalls: this.profile.constrainToolArgs && !this.profile.supportsParallelToolCalls,
        // Live prefill progress → the same assistant-thinking notice the estimate
        // already drives, so the UI upgrades from "reading N tokens" to a real
        // percentage and countdown without a second event type.
        onPrefillProgress: (p) => this.emitPrefillProgress(p),
      });
      const aiTools = this.buildAiTools();       // {} when no tools → v0 chat path

      // Tracks the LAST step's real input-token count (from provider usage) so
      // the next iteration's compaction check triggers on ACTUAL context pressure
      // rather than a chars/4 estimate. 0 on the first iteration → maybeCompact
      // falls back to an estimate (usually well under trigger for a fresh turn).
      let lastInputTokens = 0;
      // Paired with lastInputTokens to answer "how full is the window?". The LAST
      // step's prompt already contains the whole conversation (system + every
      // prior message + every tool result), so lastIn + lastOut is what the next
      // turn's prompt starts from. The summed turnUsage below CANNOT answer this:
      // it re-counts the entire history once per step, so a 5-step turn reports
      // roughly 5x the real occupancy (Destin, 2026-07-28).
      let lastOutputTokens = 0;
      turnLoop: while (true) {
        // Two-stage compaction FIRST (spec §4.4) — prune, then summarize only if
        // pruning can't get under budget. Inert (returns immediately) below the
        // trigger, so the existing loop behavior is unchanged for normal turns.
        await this.maybeCompact(model, lastInputTokens);
        // Reset per STEP (not per retry attempt inside withRetry): a mid-stream
        // retry after content was already emitted can cosmetically duplicate that
        // partial in a session-error's history push — accepted, since the
        // required immediate-error retry emits nothing before it throws.
        partialAssistantText = '';
        // One step = one streamText consumption. withRetry wraps the whole
        // CONSUMPTION (not just the streamText call): the SDK surfaces provider
        // errors as {type:'error'} fullStream parts AND rejected promises, so
        // only wrapping the call would miss them (verified ai@7 facts).
        const step = await this.withRetry(() =>
          this.consumeStep(model, aiTools, (t) => { partialAssistantText = t; }),
        );

        lastInputTokens = step.usage.inputTokens;   // feed the NEXT compaction check
        lastOutputTokens = step.usage.outputTokens;

        // Accumulate this step's usage into the turn total.
        turnUsage.inputTokens += step.usage.inputTokens;
        turnUsage.outputTokens += step.usage.outputTokens;
        turnUsage.cacheReadTokens += step.usage.cacheReadTokens;
        turnUsage.cacheCreationTokens += step.usage.cacheCreationTokens;
        generationMs += step.generationMs;

        // v0 interrupt semantics: push the partial, emit user-interrupt, return.
        // (An interrupted turn NEVER completes as a normal turn-complete.)
        if (step.interrupted || this.interrupted || this.abort.signal.aborted) {
          if (step.text) this.history.push({ role: 'assistant', content: step.text });
          this.emitEvent('user-interrupt', {});
          return;
        }

        // Record the assistant message (text + any tool-call parts). Skip an
        // empty one (no text and no calls) so we never push a content-less turn.
        if (step.text || step.toolCalls.length > 0) {
          this.history.push(this.assistantMessage(step.text, step.toolCalls));
        }

        if (step.toolCalls.length === 0) {
          // Natural stop. finishReason 'length' (truncated output, including a
          // truncated tool-call) collapses to 'max_tokens' via mapStopReason.
          stopReason = mapStopReason(step.finishReason);
          break;
        }

        // Emit ALL of this step's tool-use events FIRST (one per call, in order),
        // THEN execute serially — so the persisted event stream mirrors the
        // STEP-GROUPED history we push below (assistant[text?, c1, c2] then
        // tool[r1, r2]). If we interleaved use→result→use→result instead,
        // rebuildHistory (pure event-adjacency, Task 10) would wrongly split a
        // multi-call step into assistant[c1]/tool[r1]/assistant[c2]/tool[r2] and
        // NO longer deep-equal live history — and a textless second call would be
        // indistinguishable from a new step. Renderer impact is benign: all tool
        // cards appear up front, results attach by toolUseId (CC's parallel-call
        // behavior). The frozen emit surface is untouched — same event types and
        // fields, only intra-step ordering changes.
        for (const call of step.toolCalls) {
          this.emitEvent('tool-use', { toolUseId: call.toolCallId, toolName: call.toolName, toolInput: call.input });
        }

        // Execute tool calls SERIALLY; collect their results for the next step.
        const resultParts: any[] = [];
        for (let i = 0; i < step.toolCalls.length; i++) {
          const call = step.toolCalls[i];
          const payload = await this.runOneTool(call, recentCalls);   // NEVER throws
          if (payload === 'interrupted') {
            // Interrupt during a permission ask. Back-fill canceled tool-results
            // for THIS call AND every remaining un-executed call in the step
            // (earlier calls already have real results in resultParts + emitted
            // events). Every call's tool-use event was already emitted up front,
            // so each still gets a matching tool-result event here. Without this,
            // the assistant(tool-call) message has no matching tool message — a
            // dangling tool_call that provider APIs hard-reject (HTTP 400) on the
            // NEXT send, bricking the session (the bad message persists in history
            // across sends). CC does the same canceled back-fill. The synthesized
            // tool-result events keep the persisted transcript in agreement with
            // the model-facing history.
            for (let j = i; j < step.toolCalls.length; j++) {
              const rem = step.toolCalls[j];
              this.emitEvent('tool-result', { toolUseId: rem.toolCallId, toolName: rem.toolName, toolResult: CANCELED_TOOL_TEXT, isError: true });
              resultParts.push(this.toolResultPart(rem, CANCELED_TOOL_TEXT));
            }
            this.history.push({ role: 'tool', content: resultParts });
            this.emitEvent('user-interrupt', {});
            return;
          }
          // Turn the tool's promised image paths into deliverable parts, charging
          // the per-turn budget/dedupe and amending the text with a named note
          // for every skip (Task 5 — the driver never promises silently).
          const delivered = this.resolveToolImages(payload, imageBudget);
          this.emitEvent('tool-result', {
            toolUseId: call.toolCallId, toolName: call.toolName,
            toolResult: delivered.text, isError: payload.isError ?? false,
            ...(payload.structuredPatch ? { structuredPatch: payload.structuredPatch } : {}),
            // Paths only — events carry no binary; resume re-reads (history-rebuild.ts).
            ...(delivered.images.length ? { images: delivered.images.map((i) => i.path) } : {}),
          });
          resultParts.push(this.toolResultPart(call, delivered.text, delivered.images));
        }
        this.history.push({ role: 'tool', content: resultParts });
        // Path-triggered content (M3 item 3): a project rule or a nested
        // AGENTS.md/CLAUDE.md governing a path this step just touched. Appended
        // AFTER the tool results so the model reads the rule alongside what it
        // just learned, and before it decides the next step.
        this.injectPathTriggers(step.toolCalls);

        stepsSinceApproval++;
        // Budget gate (spec §2.4) — surfaces as a permission ASK, not a new
        // event. Allow resets the counter and continues; anything else ends the
        // turn with stopReason 'max_steps'; canceled is an interrupt.
        if (stepsSinceApproval >= maxSteps) {
          const d = await this.opts.askUser?.({ sessionId: this.opts.sessionId, toolName: 'max_steps', toolInput: { steps: stepsSinceApproval }, denyListed: false });
          if (d?.behavior === 'canceled') { this.emitEvent('user-interrupt', {}); return; }
          if (d?.behavior !== 'allow') { stopReason = 'max_steps'; break turnLoop; }
          stepsSinceApproval = 0;
        }
      }

      // Denominator is GENERATION time, not the turn's wall-clock. Falls back to
      // wall-clock only when no step ever produced output, where the ratio is 0
      // either way and the fallback just avoids dividing by zero.
      const seconds = Math.max((generationMs || (Date.now() - startedAt)) / 1000, 0.001);
      this.emitEvent('turn-complete', {
        model: this.binding.modelId,
        stopReason,
        // Carry the session's REAL context window (Task 4/5) on the usage payload so
        // the renderer's StatusBar can compute context % without a separate IPC. It's
        // a session constant, but co-locating it with per-turn usage keeps the whole
        // native-chip payload on one existing event (Task 12). null when unknown.
        usage: {
          ...turnUsage,
          tokensPerSecond: Math.round(turnUsage.outputTokens / seconds),
          contextLength: this.opts.contextLength ?? null,
          // How full the window actually is — NOT the same as turnUsage (see the
          // lastOutputTokens declaration). Falls back to a chars/4 estimate when
          // the provider reports nothing, so a server that ignores
          // stream_options still drives a roughly-right gauge instead of
          // reporting an empty window forever.
          contextUsedTokens: lastInputTokens > 0
            ? lastInputTokens + lastOutputTokens
            : this.estimateContextTokens(),
        },
      });
    } catch (err: any) {
      // v0's catch, unchanged: push any in-flight partial, then split
      // interrupt vs error. withRetry has already exhausted retries for a
      // transient provider error before it lands here.
      if (partialAssistantText) this.history.push({ role: 'assistant', content: partialAssistantText });
      if (this.interrupted || err?.name === 'AbortError' || this.abort?.signal.aborted) {
        this.emitEvent('user-interrupt', {});
      } else {
        this.emitEvent('session-error', { text: describeProviderError(err) });
      }
    } finally {
      this.abort = null;
    }
  }

  /** Consume ONE step's stream. Emits assistant-text / assistant-thinking deltas
   *  as they arrive, collects tool-calls + usage, and returns the step result.
   *  Throws on an 'error' stream part or a rejected result promise (→ withRetry).
   *  reportPartial receives the running assistant text so send()'s catch can push
   *  the in-flight partial if the step later throws. */
  private async consumeStep(
    model: LanguageModel,
    aiTools: Record<string, any>,
    reportPartial: (text: string) => void,
  ): Promise<StepResult> {
    // At most ONE auto-retry: attempt 0 stalls with nothing streamed →
    // runStreamOnce returns STALL_RETRY → we re-run. A stall on attempt 1 (or a
    // stall after content streamed) is fatal (StreamStallError), so the loop can
    // iterate at most twice — runStreamOnce only returns STALL_RETRY when it was
    // told this is the first attempt.
    for (let attempt = 0; ; attempt++) {
      const outcome = await this.runStreamOnce(model, aiTools, reportPartial, attempt === 0);
      if (outcome !== STALL_RETRY) return outcome;
      // Auto-retrying after a silent stall: clear the on-screen stall warning
      // back to a plain "Thinking" heartbeat so the countdown doesn't linger at
      // 0 while the fresh stream spins up.
      this.emitEvent('assistant-thinking', {});
    }
  }

  /** Consume ONE stream attempt with an inactivity watchdog. Returns a normal
   *  StepResult, or the STALL_RETRY sentinel when the stream went silent past
   *  the countdown with nothing streamed on a first attempt (caller re-runs).
   *  Throws StreamStallError when a stall isn't safely retryable. */
  private async runStreamOnce(
    model: LanguageModel,
    aiTools: Record<string, any>,
    reportPartial: (text: string) => void,
    isFirstAttempt: boolean,
  ): Promise<StepResult | typeof STALL_RETRY> {
    const streamArgs: any = {
      model,
      system: this.systemText,
      messages: this.fitToContext(this.history),
      maxOutputTokens: this.opts.harness.limits?.maxTokens,
      abortSignal: this.abort!.signal,
      // Fix (2026-08-10 incident): streamText's DEFAULT onError is
      // `({ error }) => console.error(error)` — Node's console.error on a raw
      // Error/object prints its FULL shape (stack, statusCode, responseBody,
      // and responseHeaders — which can include a set-cookie value) as a
      // multi-line dump. That is exactly what the live roster run's CLI
      // printed to the console for an OpenRouter 402: dozens of lines where
      // one would do. describeProviderError() already extracts the real,
      // bounded, actionable detail from ANY error shape (see below) — reuse
      // it here so a stream failure logs ONE legible line instead of the
      // SDK's raw dump. Not silenced: the failure is still visible, and the
      // SAME error still reaches session-error via the 'error' case below.
      onError: ({ error }: { error: unknown }) => {
        console.error(`[harness] stream error: ${describeProviderError(error)}`);
      },
    };
    // Only pass tools when there are any — keeps the no-tools path byte-identical
    // to v0 (no tool plumbing reaches the SDK).
    if (Object.keys(aiTools).length > 0) streamArgs.tools = aiTools;
    const result = streamText(streamArgs);

    let assistantText = '';
    let outputChars = 0;
    const toolCalls: ToolCall[] = [];
    let interrupted = false;
    // Any delta/tool-call this attempt means a retry would DUPLICATE output, so
    // a later stall must fail rather than re-run.
    let emittedAny = false;

    // Consume the stream via an explicit iterator raced against the abort
    // signal. A plain `for await` blocks forever if the underlying provider
    // stream stops emitting without honoring the abort — racing guarantees
    // interrupt() always ends the turn (covers thrown-AbortError AND stream-hang).
    const iterator = (result.fullStream as AsyncIterable<any>)[Symbol.asyncIterator]();
    const abortSignal = this.abort!.signal;
    const abortPromise = new Promise<'aborted'>((resolve) => {
      if (abortSignal.aborted) resolve('aborted');
      else abortSignal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });

    // Inactivity watchdog, raced alongside each chunk read. Stage 1 (silence for
    // STALL_WARNING_MS) emits the stall-warning heartbeat that drives the UI
    // countdown; stage 2 (a further STALL_RETRY_COUNTDOWN_MS of silence) resolves
    // the race with 'stall'. Re-armed on every real chunk so it fires ONLY on a
    // genuinely silent stream — an actively-streaming reasoning model never trips it.
    const warnMs = this.opts.stallWarningMs ?? STALL_WARNING_MS;
    const countdownMs = this.opts.stallCountdownMs ?? STALL_RETRY_COUNTDOWN_MS;
    // PREFILL vs MID-STREAM: until the first chunk arrives the model is reading the
    // prompt, which on a local model legitimately takes minutes. Only once tokens
    // have started does a 60s gap mean something is actually wrong. A test that
    // pins its own stallWarningMs opts out of the scaling and keeps its exact timing.
    // Binary-aware: JSON.stringify on a Buffer is ~4-5 chars per BYTE, so an image
    // turn reported a ~700x inflated prompt-token count to the user.
    const promptTokens = messagesTokens(streamArgs.messages as ModelMessage[])
      + Math.ceil(this.systemText.length / APPROX_CHARS_PER_TOKEN);
    // How much of that is genuinely NEW work. llama.cpp reuses the cached prefix,
    // so a step that appends a 100 KB tool result only prefills the tool result —
    // reporting the whole context would wildly overstate the wait. A SHRINKING
    // total means compaction rewrote history, which invalidates the cached prefix,
    // so that step really is a full prefill again.
    const newTokens = this.lastStepPromptTokens > 0 && promptTokens >= this.lastStepPromptTokens
      ? promptTokens - this.lastStepPromptTokens
      : promptTokens;
    this.lastStepPromptTokens = promptTokens;
    // The BUDGET deliberately scales on the TOTAL, not the increment: cache reuse
    // is an optimistic assumption (a busy slot can evict it), and being generous
    // here only risks a late stall report, whereas being tight risks resurrecting
    // the false "model stopped responding" this whole change exists to kill.
    const firstChunkMs = this.opts.prefillWarningMs ?? this.opts.stallWarningMs ?? prefillBudgetMs(promptTokens);
    // Name what is actually being read, so the copy is true at any step. After a
    // tool call the new context IS the tool output — "your prompt" would be plain
    // wrong there (Destin, 2026-07-26).
    const lastMsg = (streamArgs.messages as ModelMessage[])[streamArgs.messages.length - 1];
    const source: 'prompt' | 'tool-output' = lastMsg?.role === 'tool' ? 'tool-output' : 'prompt';
    this.prefillSource = source;
    this.lastPrefillEmitAt = 0;   // fresh throttle window per step
    let sawFirstChunk = false;
    let firstChunkAt = 0;   // when generation actually began (see StepResult.generationMs)
    let warned = false;
    let stageTimer: ReturnType<typeof setTimeout> | undefined;
    let resolveStall: (v: 'stall') => void;
    const stallPromise = new Promise<'stall'>((resolve) => { resolveStall = resolve; });
    const armWatchdog = () => {
      clearTimeout(stageTimer);
      stageTimer = setTimeout(() => {
        warned = true;
        // willRetry: we can safely re-run only if nothing streamed AND this is
        // the first attempt — otherwise the countdown ends in an error, not a retry.
        const willRetry = !emittedAny && isFirstAttempt;
        this.emitEvent('assistant-thinking', { stallWarning: { retryInMs: countdownMs, willRetry } });
        stageTimer = setTimeout(() => resolveStall('stall'), countdownMs);
      }, sawFirstChunk ? warnMs : firstChunkMs);
    };
    this.rearmStallWatchdog = armWatchdog;
    // Tell the UI the model is READING, not hanging. Without this the user stares
    // at an idle spinner for minutes with nothing to distinguish it from a hang —
    // which is exactly what made the false stall so alarming. Gated on prompt size
    // so ordinary turns keep their existing event sequence exactly.
    // Gate on the NEW tokens: a step that adds almost nothing to a huge cached
    // context returns instantly and needs no explanation, however big the total.
    if (newTokens >= PROMPT_PROCESSING_NOTICE_TOKENS) {
      this.emitEvent('assistant-thinking', {
        promptProcessing: { promptTokens: newTokens, budgetMs: firstChunkMs, source },
      });
    }
    armWatchdog();

    try {
      while (true) {
        const nextPromise = iterator.next();
        const chunk = await Promise.race([nextPromise, abortPromise, stallPromise]);
        if (chunk === 'aborted') {
          // The abort won the race; swallow the pending read's late rejection and
          // release the underlying reader/socket (a provider that IGNORES the abort
          // would otherwise leak it until GC — the exact case this race exists for).
          nextPromise.catch(() => {});
          iterator.return?.().catch(() => {});
          this.interrupted = true;
          interrupted = true;
          break;
        }
        if (chunk === 'stall') {
          // No chunk for the full warn+countdown window. Release the dead reader
          // (same teardown as the abort path), then retry-or-fail. Cancelling the
          // reader can reject the terminal promises with nothing awaiting them —
          // swallow so they don't surface as unhandled rejections.
          nextPromise.catch(() => {});
          iterator.return?.().catch(() => {});
          void Promise.resolve(result.usage).catch(() => {});
          void Promise.resolve(result.finishReason).catch(() => {});
          if (!emittedAny && isFirstAttempt) return STALL_RETRY;
          // Name the phase honestly: a model that never STARTED (prefill) has not
          // "stopped responding", and telling the user it did sends them chasing a
          // provider fault that isn't there.
          throw new StreamStallError(
            (sawFirstChunk ? warnMs : firstChunkMs) + countdownMs,
            sawFirstChunk ? 'streaming' : 'prefill',
            promptTokens,
          );
        }
        if (chunk.done) break;
        // A real chunk arrived → the model is past prefill, so every LATER gap is
        // judged by the strict mid-stream budget rather than the generous one.
        //
        // "Real" EXCLUDES the SDK's synthetic lifecycle parts. streamText emits
        // `start` about 8ms after the stream opens — before the provider has done
        // anything at all — and `start-step` likewise. Counting those flipped this
        // flag almost immediately, which abandoned the prefill budget on every
        // stream and left prompt processing judged by the strict 60s mid-stream
        // window. That is why the stall warning kept firing mid-prefill on a slow
        // local model even after the prefill budget was added (Destin, 2026-07-26):
        // the budget was never actually in force. Verified by logging fullStream
        // part timings against a mock that delays its first real part by 800ms.
        if (chunk.value?.type !== 'start' && chunk.value?.type !== 'start-step') {
          // Stamp the first REAL chunk: generation starts here. Everything before
          // it is prefill, and tok/s must not be diluted by it.
          if (!sawFirstChunk) firstChunkAt = Date.now();
          sawFirstChunk = true;
        }
        // A real chunk arrived → clear any shown warning and re-arm the watchdog.
        if (warned) { warned = false; this.emitEvent('assistant-thinking', {}); }
        armWatchdog();
        const part = chunk.value;
        switch (part.type) {
          case 'text-delta': {
            const t = deltaText(part);
            if (!t) break;
            emittedAny = true;
            assistantText += t; outputChars += t.length;
            reportPartial(assistantText);
            // partId = the SDK's part id (fresh per streamText call). A tool-group
            // segment always separates consecutive text STEPS in the reducer, so a
            // repeated id across steps can't wrongly merge two bubbles.
            this.emitEvent('assistant-text', { text: t, partId: part.id ?? 'text-0' });
            break;
          }
          case 'reasoning-delta': {
            const t = deltaText(part);
            if (!t) break;
            emittedAny = true;
            outputChars += t.length;
            // assistant-thinking WITH data.text → the reducer's reasoning path;
            // payload-less would stay a heartbeat.
            this.emitEvent('assistant-thinking', { text: t, partId: part.id ?? 'reasoning-0' });
            break;
          }
          case 'tool-call':
            // input is the PARSED object here (streamText parses the raw JSON-string
            // args — verified ai@7 contract). Collected; executed by the loop.
            emittedAny = true;
            toolCalls.push({ toolCallId: part.toolCallId, toolName: part.toolName, input: part.input });
            break;
          case 'abort':
            // The SDK can surface an interrupt as a clean 'abort' part (instead of
            // a thrown AbortError). Mark it so the loop emits user-interrupt.
            this.interrupted = true;
            interrupted = true;
            break;
          case 'error':
            // Fix (2026-08-10 Kimi K3 incident): a fullStream 'error' part's
            // `.error` is NOT guaranteed to be an Error instance — the AI SDK
            // hands back whatever the provider layer produced. The old
            // fallback, `new Error(String(part.error))`, threw every useful
            // field away: String() on a plain object always yields the
            // literal text '[object Object]', which is exactly what reached
            // the user as the session's ENTIRE error message that day — a
            // real OpenRouter 402 ("This request requires more credits...")
            // whose statusCode/message/data were already sitting on the
            // object, just never read before being stringified into oblivion.
            // Preserve them instead: copy the object's own fields onto a real
            // Error (so downstream code that expects `instanceof Error` still
            // works, e.g. withRetry's statusCode-based retry check) rather
            // than collapsing it to a string first. describeProviderError()
            // (send()'s catch, below) already knows how to read
            // statusCode/responseBody/data/message off ANY shape.
            throw part.error instanceof Error
              ? part.error
              : (part.error && typeof part.error === 'object'
                ? Object.assign(new Error(), part.error as object)
                : new Error(String(part.error)));
        }
      }
    } finally {
      // Always release the watchdog timers — on done/throw/return alike.
      clearTimeout(stageTimer);
      // Stop late progress callbacks from re-arming a watchdog for a step that
      // has already ended (the tee outlives the iterator on an interrupt).
      this.rearmStallWatchdog = null;
    }

    if (interrupted || this.interrupted || abortSignal.aborted) {
      // Don't await usage/finishReason on the interrupt path — the stream was
      // torn down; those promises may never settle.
      return { text: assistantText, toolCalls, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, finishReason: undefined, interrupted: true, generationMs: firstChunkAt ? Date.now() - firstChunkAt : 0 };
    }

    const usage = await result.usage;
    const finishReason = await result.finishReason;
    return {
      text: assistantText,
      toolCalls,
      usage: {
        inputTokens: usage?.inputTokens ?? 0,
        outputTokens: usage?.outputTokens ?? Math.ceil(outputChars / APPROX_CHARS_PER_TOKEN),
        // v7 LanguageModelUsage exposes cache tokens under inputTokenDetails.
        cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
        cacheCreationTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
      },
      finishReason,
      interrupted: false,
      generationMs: firstChunkAt ? Date.now() - firstChunkAt : 0,
    };
  }

  /** Run one tool call through the EXACT permission sequence (spec §2.1/§2.4):
   *  validate → doom-loop → guards → decide → (ask) → execute. NEVER throws —
   *  every failure mode is a tool RESULT the model can repair from, except a
   *  user cancel which returns the 'interrupted' sentinel so the loop can unwind. */
  private async runOneTool(call: ToolCall, recentCalls: string[]): Promise<ToolResultPayload | 'interrupted'> {
    const tool = this.toolByName.get(call.toolName);
    if (!tool) return { text: `Unknown tool ${call.toolName}. Available: ${[...this.toolByName.keys()].join(', ')}.`, isError: true };

    // 1. Validate (zod) — invalid args are a RESULT the model repairs from, not
    //    a crash, and precede permissions (never ask about garbage).
    const parsed = tool.inputSchema.safeParse(call.input);
    if (!parsed.success) {
      return { text: `Invalid arguments for ${call.toolName}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}. Fix the arguments and call again.`, isError: true };
    }
    const args = parsed.data;

    // 2. Doom loop (BEFORE permissions — a stuck model shouldn't spam asks).
    //    `args` is parsed.data (zod-NORMALIZED), so the signature is canonical:
    //    two calls that differ only in JSON key order still count as identical.
    const sig = `${call.toolName}:${JSON.stringify(args)}`;
    // Window length = the profile's doom-loop threshold (Task 5): small local
    // models (threshold 2) trip sooner than cloud models (default 3). Trip when
    // the last `threshold` calls are all identical; an allow resets the window.
    const threshold = this.profile.doomLoopThreshold;
    recentCalls.push(sig);
    if (recentCalls.length > threshold) recentCalls.shift();
    if (recentCalls.length === threshold && recentCalls.every((s) => s === sig)) {
      const d = await this.opts.askUser?.({ sessionId: this.opts.sessionId, toolName: 'doom_loop', toolInput: { repeated: call.toolName }, denyListed: false });
      if (d?.behavior === 'canceled') return 'interrupted';
      // Threshold-accurate: the doom-loop window length varies by profile (2 for
      // small local models, 3 for cloud), so quote the ACTUAL threshold, not a
      // hardcoded "three". Model-facing corrective text, not a user-facing error.
      if (d?.behavior !== 'allow') return { text: `Stopped: this exact call has been repeated ${threshold} times. Try a different approach.`, isError: true };
      recentCalls.length = 0;   // allow resets the window
    }

    // 2.5 Interactive tools (AskUserQuestion): the ask IS the execution. Skip
    //     guards/decide — there is no side effect to gate; the ask rail supplies
    //     pause/cancel semantics. The card's answers come back via updatedInput
    //     (broker passthrough), formatted here into the tool result. Kept BELOW
    //     the doom-loop check on purpose: a model re-asking the identical question
    //     three times IS a doom loop and should still trip.
    if (tool.interactive) {
      if (!this.opts.askUser) return { text: `No user-interaction handler is wired for this session; ${call.toolName} cannot run. This is a configuration error.`, isError: true };
      const d = await this.opts.askUser({ sessionId: this.opts.sessionId, toolName: call.toolName, toolInput: call.input as any, denyListed: false });
      if (d.behavior === 'canceled') return 'interrupted';
      if (d.behavior !== 'allow') return { text: 'The user dismissed the question without answering. Continue with your best judgment, or ask differently in plain text.', isError: true };
      return { text: formatAnswers(args as any, d.updatedInput) };
    }

    // 3. Tool-layer guards (below ALL configuration) — PATH-subject tools only.
    //    See NON_PATH_SUBJECT_TOOLS: Bash's subject is a command string and
    //    Skill's is a skill id; TodoWrite's is undefined and skipped by the
    //    `subject !== undefined` test.
    const subject = tool.permissionSubject(args);
    let externalAsk = false;
    if (subject !== undefined && !NON_PATH_SUBJECT_TOOLS.has(call.toolName)) {
      const verdict = checkPathGuard(subject, this.opts.cwd);
      if (verdict.kind === 'deny') return { text: verdict.reason, isError: true };
      if (verdict.kind === 'external') externalAsk = true;   // external_directory → force an ask
    }

    // 4. Configured decision. An external-directory path forces 'ask' regardless
    //    of rules; otherwise consult decide() (default: ask — never silent-allow).
    const decision: PermissionDecision = externalAsk
      ? { action: 'ask', denyListed: false }
      : await (this.opts.decide?.(call.toolName, subject) ?? Promise.resolve<PermissionDecision>({ action: 'ask', denyListed: false }));
    if (decision.action === 'deny') return { text: `The ${call.toolName} call was blocked by a permission rule.`, isError: true };
    if (decision.action === 'ask') {
      // An ABSENT handler is a WIRING gap, not a user cancel — surface it as a
      // decline RESULT (the model can't proceed) instead of the 'interrupted'
      // sentinel, so a misconfiguration never masquerades as an ESC/interrupt.
      if (!this.opts.askUser) return { text: `No approval handler is wired for this session; the ${call.toolName} call cannot be approved. This is a configuration error.`, isError: true };
      const d = await this.opts.askUser({ sessionId: this.opts.sessionId, toolName: call.toolName, toolInput: call.input as any, denyListed: decision.denyListed });
      if (d.behavior === 'canceled') return 'interrupted';
      if (d.behavior !== 'allow') return { text: 'The user declined this action. Ask what they would like instead, or try a different approach.', isError: true };
      // "Always allow" → emit a rule for the host to persist (PermissionStore).
      // Plain EventEmitter event, NOT a transcript event — the frozen emit
      // surface is untouched.
      if (d.always) this.emit('remember-rule', { tool: call.toolName, ...(subject !== undefined ? { pattern: subject } : {}), action: 'allow' });
    }

    // 5. Execute (defineTool owns truncation + the actionable-error catch).
    return tool.execute(args, {
      sessionId: this.opts.sessionId,
      cwd: this.opts.cwd,
      signal: this.abort!.signal,
      readRegistry: this.readRegistry,
      shellCwd: this.shellCwd ?? this.opts.cwd,
      setShellCwd: (next: string) => {
        this.shellCwd = next;
      },
      todos: this.todos,
      supportsVision: this.profile.supportsVision,
      ...(this.opts.toolServices ? { services: this.opts.toolServices } : {}),
    });
  }

  /** Exponential backoff for transient provider errors (429/5xx/network),
   *  honoring retry-after. Layers ON TOP of the SDK's internal retry (this is
   *  step-level resilience). Exhaustion rethrows → the session-error path. */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    const delays = this.retryDelays;
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (err: any) {
        const status = err?.statusCode ?? err?.status;
        const retryable = status === 429 || (status >= 500 && status < 600) || err?.code === 'ECONNRESET';
        if (!retryable || attempt >= delays.length || this.abort?.signal.aborted) throw err;
        const ra = Number(err?.responseHeaders?.['retry-after']) * 1000;
        await new Promise((r) => setTimeout(r, Number.isFinite(ra) && ra > 0 ? ra : delays[attempt]));
      }
    }
  }

  interrupt(): void {
    this.interrupted = true;
    this.abort?.abort();
  }

  destroy(): void { this.abort?.abort(); this.removeAllListeners(); }
}
