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
import { streamText, tool, zodSchema, type LanguageModel, type ModelMessage } from 'ai';
import type { TranscriptEvent } from '../../shared/types';
import type { ModelBinding } from '../../shared/provider-types';
import type { HarnessManifest } from '../../shared/harness-manifest';
import type { PermissionDecision } from '../../shared/permission-types';
import type { NativeTool, ToolContext, ToolResultPayload, ToolServices } from './tools/types';
import { stepBudgetFor } from './model-step-budget';
import { checkPathGuard } from './tools/guards';
import { formatAnswers } from './tools/ask-user-question';
import type { AskRequest, AskDecision } from './permission-broker';
import { CLOUD_DEFAULT, type CapabilityProfile } from './capability-profile';
import { planCompaction, pruneToolOutputs, summarizePrompt, estimateTokens, type CompactionConfig } from './compaction';

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
  /** Resolved capability profile (Task 5): steers the doom-loop window and
   *  whether tools are attached at all. Absent → CLOUD_DEFAULT (full posture). */
  profile?: CapabilityProfile;
}
// The opts second arg carries per-turn model construction hints. `serialToolCalls`
// (Task 10 / spec §4.2) tells the local-engine factory to inject
// parallel_tool_calls:false; cloud factories ignore it.
export type ModelFactory = (binding: ModelBinding, opts?: { serialToolCalls?: boolean }) => Promise<LanguageModel>;

// One collected tool-call from a step's stream (input already PARSED to an
// object by streamText — see the ai@7 contract test).
interface ToolCall { toolCallId: string; toolName: string; input: any }
// Normalized per-step usage (v7's nested cache details flattened into our fixed
// transcript usage shape).
interface StepUsage { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number }
// What one consumed step returns to the loop.
interface StepResult { text: string; toolCalls: ToolCall[]; usage: StepUsage; finishReason: string | undefined; interrupted: boolean }

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
const APPROX_CHARS_PER_TOKEN = 4;

// Turn a caught provider/SDK error into the most ACTIONABLE message we can show
// (docs/error-message-standards.md — surface the real detail, never a generic
// wrapper). The AI SDK wraps a provider HTTP failure as AI_APICallError (with
// `.statusCode` + a `.responseBody` JSON string) and its retry layer as
// AI_RetryError (with `.lastError`). The bare `.message` is useless
// ("Provider returned error" / "Failed after 3 attempts") — the real, usually
// user-fixable detail lives in the body. OpenRouter, for example, nests the
// upstream reason at `error.metadata.raw` (e.g. "<model> is temporarily
// rate-limited upstream. Please retry shortly, or add your own key…").
export function describeProviderError(err: any): string {
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
  if (typeof detail === 'string' && detail.trim()) {
    return status ? `${detail.trim()} (provider error ${status})` : detail.trim();
  }
  // No structured detail (network error, etc.) — the SDK message beats nothing.
  return api?.message ?? err?.message ?? 'The model request failed.';
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
class StreamStallError extends Error {
  constructor(totalMs: number) {
    super(
      `The model stopped responding — no data received for ${Math.round(totalMs / 1000)} seconds. `
      + `The provider may be stalled; send your message again to retry.`,
    );
    this.name = 'StreamStallError';
  }
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

  private emitEvent(type: TranscriptEvent['type'], data: TranscriptEvent['data']): void {
    const event: TranscriptEvent = { type, sessionId: this.opts.sessionId, uuid: randomUUID(), timestamp: Date.now(), data };
    this.emit('transcript-event', event);
  }

  /** NativeTool → ai `tool({description, inputSchema})` WITHOUT execute, keyed by
   *  name. No execute => the SDK emits 'tool-call' parts and finishes with
   *  'tool-calls' WITHOUT looping (verified ai@7 contract) — WE own the loop. */
  private buildAiTools(): Record<string, any> {
    // Plain-chat model (profile.supportsTools === false): attach NO tools so the
    // SDK never sends a tool schema. WHY: a small local model the registry marks
    // tool-less would otherwise emit malformed tool-calls we can't honor.
    if (!this.profile.supportsTools) return {};
    // Simplified presentation (spec §4.2): small local models get each tool's
    // compact shortDescription (falling back to the full description when a tool
    // defines none) so the schema stays small enough for a weak model to follow.
    // The tool SET is identical either way — we only shrink the wording.
    const simplified = this.profile.maxToolPresentation === 'simplified';
    const out: Record<string, any> = {};
    for (const t of this.toolByName.values()) {
      out[t.name] = tool({ description: simplified ? (t.shortDescription ?? t.description) : t.description, inputSchema: zodSchema(t.inputSchema) });
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
   *  pinned (Task 1) — `result`/other field names throw AI_InvalidPromptError. */
  private toolResultPart(call: ToolCall, text: string): any {
    return { type: 'tool-result', toolCallId: call.toolCallId, toolName: call.toolName, output: { type: 'text', value: text } };
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
    let total = Math.ceil(this.systemText.length / APPROX_CHARS_PER_TOKEN);
    const kept: ModelMessage[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const size = Math.ceil(JSON.stringify(messages[i].content).length / APPROX_CHARS_PER_TOKEN);
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
    return kept;
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

  async send(text: string): Promise<void> {
    // Re-entrancy guard: a non-null abort means a turn is already streaming.
    // Throw loudly rather than corrupt the single-slot turn state (see the
    // class-level CONCURRENCY PRECONDITION note).
    if (this.abort) {
      throw new Error('HarnessSession.send() called while a turn is already in flight — callers must serialize sends per session.');
    }
    this.interrupted = false;
    this.emitEvent('user-message', { text });
    this.history.push({ role: 'user', content: text });
    this.abort = new AbortController();

    const startedAt = Date.now();
    const turnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
    const recentCalls: string[] = [];           // doom-loop window (turn-level)
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
      const model = await this.modelFactory(this.binding, { serialToolCalls: this.profile.constrainToolArgs && !this.profile.supportsParallelToolCalls });
      const aiTools = this.buildAiTools();       // {} when no tools → v0 chat path

      // Tracks the LAST step's real input-token count (from provider usage) so
      // the next iteration's compaction check triggers on ACTUAL context pressure
      // rather than a chars/4 estimate. 0 on the first iteration → maybeCompact
      // falls back to an estimate (usually well under trigger for a fresh turn).
      let lastInputTokens = 0;
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

        // Accumulate this step's usage into the turn total.
        turnUsage.inputTokens += step.usage.inputTokens;
        turnUsage.outputTokens += step.usage.outputTokens;
        turnUsage.cacheReadTokens += step.usage.cacheReadTokens;
        turnUsage.cacheCreationTokens += step.usage.cacheCreationTokens;

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
          this.emitEvent('tool-result', {
            toolUseId: call.toolCallId, toolName: call.toolName,
            toolResult: payload.text, isError: payload.isError ?? false,
            ...(payload.structuredPatch ? { structuredPatch: payload.structuredPatch } : {}),
          });
          resultParts.push(this.toolResultPart(call, payload.text));
        }
        this.history.push({ role: 'tool', content: resultParts });

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

      const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
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
      }, warnMs);
    };
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
          throw new StreamStallError(warnMs + countdownMs);
        }
        if (chunk.done) break;
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
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
        }
      }
    } finally {
      // Always release the watchdog timers — on done/throw/return alike.
      clearTimeout(stageTimer);
    }

    if (interrupted || this.interrupted || abortSignal.aborted) {
      // Don't await usage/finishReason on the interrupt path — the stream was
      // torn down; those promises may never settle.
      return { text: assistantText, toolCalls, usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }, finishReason: undefined, interrupted: true };
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

    // 3. Tool-layer guards (below ALL configuration) — file tools only. Bash's
    //    subject is a command string (not a path); TodoWrite's is undefined.
    const subject = tool.permissionSubject(args);
    let externalAsk = false;
    if (subject !== undefined && call.toolName !== 'Bash') {
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
