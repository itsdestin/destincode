// HarnessSession v0 — the native runtime's turn loop (spec §2.3): plain
// streamText, NO tools, emitting the exact transcript-event protocol the chat
// reducer already consumes. Phase 2 replaces the inner loop with the tool
// agent; the emit surface is the contract that must not move.
import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import { streamText, type LanguageModel, type ModelMessage } from 'ai';
import type { TranscriptEvent } from '../../shared/types';
import type { ModelBinding } from '../../shared/provider-types';
import type { HarnessManifest } from '../../shared/harness-manifest';

export interface HarnessSessionOpts {
  sessionId: string; cwd: string; harness: HarnessManifest; binding: ModelBinding;
  /** Model context window (from the catalog); null → conservative 32k default. */
  contextLength?: number | null;
}
export type ModelFactory = (binding: ModelBinding) => Promise<LanguageModel>;

// v7 stream parts carry the chunk in .text (verified against ai@7.0.22:
// TextStreamTextDeltaPart / TextStreamReasoningDeltaPart both expose `.text`).
// Read through ONE accessor so any future field rename stays here.
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

export class HarnessSession extends EventEmitter {
  private history: ModelMessage[] = [];
  private abort: AbortController | null = null;
  private interrupted = false;
  binding: ModelBinding;

  constructor(private opts: HarnessSessionOpts, private modelFactory: ModelFactory) {
    super();
    this.binding = opts.binding;
  }

  /** Resume path: NativeSessionHost rebuilds history from stored events. */
  seedHistory(messages: ModelMessage[]): void { this.history = messages; }

  /** Mid-session model swap (next turn uses the new binding). */
  setBinding(binding: ModelBinding, contextLength?: number | null): void {
    this.binding = binding;
    if (contextLength !== undefined) this.opts.contextLength = contextLength;
  }

  private emitEvent(type: TranscriptEvent['type'], data: TranscriptEvent['data']): void {
    const event: TranscriptEvent = { type, sessionId: this.opts.sessionId, uuid: randomUUID(), timestamp: Date.now(), data };
    this.emit('transcript-event', event);
  }

  /** Oldest-first truncation to fit the context window. Always keeps the
   *  newest user message; chars/4 is a deliberate estimate, not a tokenizer. */
  private fitToContext(messages: ModelMessage[]): ModelMessage[] {
    const ctx = this.opts.contextLength ?? 32_768;
    const budgetTokens = ctx - (this.opts.harness.limits?.maxTokens ?? 4096) - 1024; // output + margin
    let total = Math.ceil(this.opts.harness.systemPrompt.length / APPROX_CHARS_PER_TOKEN);
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
    this.interrupted = false;
    this.emitEvent('user-message', { text });
    this.history.push({ role: 'user', content: text });
    this.abort = new AbortController();

    const startedAt = Date.now();
    let outputChars = 0;
    let assistantText = '';

    try {
      const model = await this.modelFactory(this.binding);
      const result = streamText({
        model,
        system: this.opts.harness.systemPrompt,
        messages: this.fitToContext(this.history),
        maxOutputTokens: this.opts.harness.limits?.maxTokens,
        abortSignal: this.abort.signal,
      });

      // Consume the stream via an explicit iterator raced against the abort
      // signal. A plain `for await` blocks forever if the underlying provider
      // stream stops emitting without honoring the abort (observed with a
      // never-closing stream) — racing guarantees interrupt() always ends the
      // turn, covering BOTH the thrown-AbortError and the stream-just-hangs cases.
      const iterator = (result.fullStream as AsyncIterable<any>)[Symbol.asyncIterator]();
      const abortSignal = this.abort.signal;
      const abortPromise = new Promise<'aborted'>((resolve) => {
        if (abortSignal.aborted) resolve('aborted');
        else abortSignal.addEventListener('abort', () => resolve('aborted'), { once: true });
      });

      while (true) {
        const nextPromise = iterator.next();
        const step = await Promise.race([nextPromise, abortPromise]);
        if (step === 'aborted') {
          // The abort won the race; the in-flight read is still pending and
          // will reject once the provider stream tears down. Swallow that late
          // rejection so it doesn't surface as an unhandledRejection.
          nextPromise.catch(() => {});
          this.interrupted = true;
          break;
        }
        if (step.done) break;
        const part = step.value;
        switch (part.type) {
          case 'text-delta': {
            const t = deltaText(part);
            if (!t) break;
            assistantText += t; outputChars += t.length;
            this.emitEvent('assistant-text', { text: t, partId: part.id ?? 'text-0' });
            break;
          }
          case 'reasoning-delta': {
            const t = deltaText(part);
            if (!t) break;
            outputChars += t.length;
            // assistant-thinking WITH data.text → the reducer's reasoning path
            // (the PR #115 disclosure); payload-less stays a heartbeat.
            this.emitEvent('assistant-thinking', { text: t, partId: part.id ?? 'reasoning-0' });
            break;
          }
          case 'abort':
            // The SDK can surface an interrupt as a clean 'abort' stream part
            // (instead of a thrown AbortError). Mark it so the post-loop guard
            // emits user-interrupt rather than turn-complete.
            this.interrupted = true;
            break;
          case 'error':
            throw part.error instanceof Error ? part.error : new Error(String(part.error));
        }
      }

      // Abort can end the stream cleanly (no throw). Handle both the thrown
      // path (catch below) and the clean-end path here so an interrupted turn
      // never completes as a normal turn-complete.
      if (this.interrupted || this.abort?.signal.aborted) {
        if (assistantText) this.history.push({ role: 'assistant', content: assistantText });
        this.emitEvent('user-interrupt', {});
        return;
      }

      const usage = await result.usage;
      const finishReason = await result.finishReason;
      if (assistantText) this.history.push({ role: 'assistant', content: assistantText });

      const seconds = Math.max((Date.now() - startedAt) / 1000, 0.001);
      const outputTokens = usage?.outputTokens ?? Math.ceil(outputChars / APPROX_CHARS_PER_TOKEN);
      this.emitEvent('turn-complete', {
        model: this.binding.modelId,
        stopReason: mapStopReason(finishReason),
        usage: {
          inputTokens: usage?.inputTokens ?? 0,
          outputTokens,
          // v7 LanguageModelUsage exposes cache tokens under inputTokenDetails
          // (cacheReadTokens / cacheWriteTokens); map them into our fixed
          // transcript usage shape so the StatusBar sees consistent fields.
          cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
          cacheCreationTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
          tokensPerSecond: Math.round(outputTokens / seconds),
        },
      });
    } catch (err: any) {
      if (assistantText) this.history.push({ role: 'assistant', content: assistantText });
      if (this.interrupted || err?.name === 'AbortError' || this.abort?.signal.aborted) {
        // CC's interrupt marker path: TRANSCRIPT_INTERRUPT ends the turn with
        // stopReason 'interrupted' — same event, same reducer behavior.
        this.emitEvent('user-interrupt', {});
      } else {
        this.emitEvent('session-error', { text: err?.message ?? 'The model request failed.' });
      }
    } finally {
      this.abort = null;
    }
  }

  interrupt(): void {
    this.interrupted = true;
    this.abort?.abort();
  }

  destroy(): void { this.abort?.abort(); this.removeAllListeners(); }
}
