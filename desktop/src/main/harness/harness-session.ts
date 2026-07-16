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
import type { NativeTool, ToolContext, ToolResultPayload } from './tools/types';
import { checkPathGuard } from './tools/guards';
import type { AskRequest, AskDecision } from './permission-broker';

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
  /** Test hook: step-level retry backoff (ms). Defaults to [1000, 2000, 4000]. */
  retryDelays?: number[];
}
export type ModelFactory = (binding: ModelBinding) => Promise<LanguageModel>;

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
  private retryDelays: number[];

  constructor(private opts: HarnessSessionOpts, private modelFactory: ModelFactory) {
    super();
    this.binding = opts.binding;
    this.toolByName = new Map((opts.tools ?? []).map((t) => [t.name, t]));
    this.retryDelays = opts.retryDelays ?? [1000, 2000, 4000];
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
  }

  /** Mid-session model swap (next turn uses the new binding). */
  setBinding(binding: ModelBinding, contextLength?: number | null): void {
    this.binding = binding;
    if (contextLength !== undefined) this.opts.contextLength = contextLength;
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
    const out: Record<string, any> = {};
    for (const t of this.toolByName.values()) {
      out[t.name] = tool({ description: t.description, inputSchema: zodSchema(t.inputSchema) });
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
    return kept;
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
    const maxSteps = this.opts.harness.limits?.maxSteps ?? 25;
    let stepsSinceApproval = 0;
    let stopReason = 'end_turn';
    // Latest step's partial text — the ONLY thing the catch pushes to history
    // (earlier steps already pushed their assistant + tool messages). Reset per
    // step; on an immediate-error retry it stays '' so no duplicate is pushed.
    let partialAssistantText = '';

    try {
      const model = await this.modelFactory(this.binding);
      const aiTools = this.buildAiTools();       // {} when no tools → v0 chat path
      let stepIndex = 0;

      turnLoop: while (true) {
        partialAssistantText = '';
        // One step = one streamText consumption. withRetry wraps the whole
        // CONSUMPTION (not just the streamText call): the SDK surfaces provider
        // errors as {type:'error'} fullStream parts AND rejected promises, so
        // only wrapping the call would miss them (verified ai@7 facts).
        const step = await this.withRetry(() =>
          this.consumeStep(model, aiTools, (t) => { partialAssistantText = t; }),
        );

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

        // Execute tool calls SERIALLY; collect their results for the next step.
        const resultParts: any[] = [];
        for (const call of step.toolCalls) {
          this.emitEvent('tool-use', { toolUseId: call.toolCallId, toolName: call.toolName, toolInput: call.input });
          const payload = await this.runOneTool(call, recentCalls);   // NEVER throws
          if (payload === 'interrupted') { this.emitEvent('user-interrupt', {}); return; }
          this.emitEvent('tool-result', {
            toolUseId: call.toolCallId, toolName: call.toolName,
            toolResult: payload.text, isError: payload.isError ?? false,
            ...(payload.structuredPatch ? { structuredPatch: payload.structuredPatch } : {}),
          });
          resultParts.push(this.toolResultPart(call, payload.text));
        }
        this.history.push({ role: 'tool', content: resultParts });

        stepsSinceApproval++;
        stepIndex++;
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
        usage: { ...turnUsage, tokensPerSecond: Math.round(turnUsage.outputTokens / seconds) },
      });
    } catch (err: any) {
      // v0's catch, unchanged: push any in-flight partial, then split
      // interrupt vs error. withRetry has already exhausted retries for a
      // transient provider error before it lands here.
      if (partialAssistantText) this.history.push({ role: 'assistant', content: partialAssistantText });
      if (this.interrupted || err?.name === 'AbortError' || this.abort?.signal.aborted) {
        this.emitEvent('user-interrupt', {});
      } else {
        this.emitEvent('session-error', { text: err?.message ?? 'The model request failed.' });
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

    while (true) {
      const nextPromise = iterator.next();
      const chunk = await Promise.race([nextPromise, abortPromise]);
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
      if (chunk.done) break;
      const part = chunk.value;
      switch (part.type) {
        case 'text-delta': {
          const t = deltaText(part);
          if (!t) break;
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
          outputChars += t.length;
          // assistant-thinking WITH data.text → the reducer's reasoning path;
          // payload-less would stay a heartbeat.
          this.emitEvent('assistant-thinking', { text: t, partId: part.id ?? 'reasoning-0' });
          break;
        }
        case 'tool-call':
          // input is the PARSED object here (streamText parses the raw JSON-string
          // args — verified ai@7 contract). Collected; executed by the loop.
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
    const sig = `${call.toolName}:${JSON.stringify(args)}`;
    recentCalls.push(sig);
    if (recentCalls.length > 3) recentCalls.shift();
    if (recentCalls.length === 3 && recentCalls.every((s) => s === sig)) {
      const d = await this.opts.askUser?.({ sessionId: this.opts.sessionId, toolName: 'doom_loop', toolInput: { repeated: call.toolName }, denyListed: false });
      if (d?.behavior === 'canceled') return 'interrupted';
      if (d?.behavior !== 'allow') return { text: 'Stopped: this exact call has been repeated three times. Try a different approach.', isError: true };
      recentCalls.length = 0;   // allow resets the window
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
      const d = await this.opts.askUser?.({ sessionId: this.opts.sessionId, toolName: call.toolName, toolInput: call.input as any, denyListed: decision.denyListed });
      if (!d || d.behavior === 'canceled') return 'interrupted';
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
      todos: this.todos,
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
