import { EventEmitter } from 'events';
import type { OpenCodeService } from './opencode-service';

export interface OpenCodeSessionAdapterOpts {
  /** OpenCode's internal session ID — used to filter incoming SSE events. */
  ocSessionId: string;
  /** YouCoded's desktop session ID — used to tag emitted transcript-events
   *  so the chat reducer keys them on the same id the renderer holds.
   *  For RESUME, this equals ocSessionId. For NEW sessions, they may differ. */
  desktopSessionId: string;
  service: OpenCodeService;
  /** When true, fetch message history via REST first and emit synthesized
   *  transcript-events for hydration before subscribing to live SSE. */
  isResume?: boolean;
}

/**
 * Translates OpenCode SSE events for a single session into transcript-event
 * messages matching the shape TranscriptWatcher emits for Claude sessions.
 *
 * Behaviors worth knowing about (see Task 5 prose for rationale):
 * - SKIPS user-message events from live SSE; SessionManager.sendInput
 *   synthesizes them with the exact text we sent so dedup is reliable.
 * - On isResume:true, fetches message history via REST and emits
 *   transcript-events for each historical message before subscribing.
 *   Tracks seenUuids to filter duplicates if SSE happens to replay history.
 *
 * Event shapes per Verified API Surface section of the plan:
 *   message.part.updated → { part: Part, delta?: string }
 *   message.updated      → { info: Message }
 *   session.idle         → { sessionID }
 *   ToolPart.state       → { status: 'pending' | 'running' | 'completed' | 'error', ... }
 */
export class OpenCodeSessionAdapter extends EventEmitter {
  private streamReturn: (() => Promise<unknown> | void) | null = null;
  private seenUuids = new Set<string>();
  private destroyed = false;
  // partID → part.type cache built from `message.part.updated` events. Used to
  // route streaming `message.part.delta` events: they all carry `field: "text"`
  // regardless of whether the part is a reasoning or a text part (the `field`
  // refers to the property of the part being updated — both reasoning and text
  // parts store content in `.text`, so it's always 'text'). The discriminator
  // is the part's `type`, which is only available from message.part.updated.
  // Without this cache we routed all streaming reasoning content as text and
  // it showed up as full chat bubbles instead of the collapsed reasoning
  // disclosure. (Bug surfaced 2026-05-12 via SSE probe.)
  private partTypes = new Map<string, string>();
  // Captured from the latest assistant `message.updated` event for this
  // session. Emitted on the next `session.idle` as `turn-complete.data` so
  // the chat reducer can stamp model/usage/stopReason onto the completing
  // turn. Last-wins: a single turn produces multiple message.updated events
  // (one per part-state transition) and the cumulative info.tokens on the
  // final one is what we want.
  private pendingTurnMetadata: { stopReason: string | null; model: string | null; usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } | null } = {
    stopReason: null, model: null, usage: null,
  };
  // Set by SessionManager when it calls cancelSession() in response to ESC.
  // The next session.idle then emits `user-interrupt` instead of
  // `turn-complete`, matching the Claude path's "Interrupted." footer.
  private interruptPending = false;

  constructor(private readonly opts: OpenCodeSessionAdapterOpts) {
    super();
    void this.init();
  }

  private async init(): Promise<void> {
    const service: any = this.opts.service;

    // Hydration first (fetch history, synthesize events) — defensive against
    // SSE delivering only new events. Then subscribe to live.
    // Uses OpenCodeService.listMessages wrapper which calls
    // client.session.messages with the Stainless { path: { id } } shape.
    if (this.opts.isResume) {
      try {
        let messages: any[] = [];
        if (typeof service.listMessages === 'function') {
          messages = await service.listMessages(this.opts.ocSessionId);
        } else {
          // Test-mock path: fake services expose sdk().session.messages directly.
          const sdk = service.sdk?.();
          if (typeof sdk?.session?.messages === 'function') {
            const r = await sdk.session.messages(this.opts.ocSessionId);
            messages = Array.isArray(r) ? r : (r?.data ?? []);
          }
        }
        for (const item of messages) {
          if (this.destroyed) return;
          this.handleHistoryMessage(item);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error('[OpenCodeSessionAdapter] history fetch failed:', e);
      }
    }

    if (this.destroyed) return;

    // Subscribe to live SSE. Two API shapes are supported:
    //   1. Real Stainless SDK: client.event.subscribe() returns
    //      Promise<{ stream: AsyncGenerator }>. Iterate with for-await;
    //      destroy() calls stream.return() to abort.
    //   2. Test mock: subscribe(handler): unsubscribe — what our fixtures use.
    const sdk = service.sdk?.();
    if (!sdk?.event?.subscribe) return;

    // Try the real-SDK shape first.
    try {
      const result = await sdk.event.subscribe();
      if (result && typeof result === 'object' && 'stream' in result) {
        const stream = result.stream as AsyncGenerator<any>;
        this.streamReturn = () => stream.return(undefined as any);
        void this.consumeStream(stream);
        return;
      }
      // If the call succeeded but didn't return a stream, fall through.
    } catch {
      // Fall through to legacy callback shape.
    }

    // Legacy callback shape (test fixtures).
    try {
      const unsubscribe = sdk.event.subscribe((ev: any) => this.handleEvent(ev));
      if (typeof unsubscribe === 'function') {
        this.streamReturn = () => { unsubscribe(); };
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error('[OpenCodeSessionAdapter] event.subscribe failed:', e);
    }
  }

  private async consumeStream(stream: AsyncGenerator<any>): Promise<void> {
    try {
      for await (const ev of stream) {
        if (this.destroyed) break;
        this.handleEvent(ev);
      }
    } catch (e) {
      if (!this.destroyed) {
        // eslint-disable-next-line no-console
        console.error('[OpenCodeSessionAdapter] SSE stream error:', e);
      }
    }
  }

  destroy(): void {
    this.destroyed = true;
    // Fire-and-forget — stream.return() resolves on next yield; we don't await.
    try { void this.streamReturn?.(); } catch { /* ignore */ }
    this.streamReturn = null;
  }

  /** Called by SessionManager.sendInput when the user presses ESC. The next
   *  session.idle will emit `user-interrupt` instead of the normal
   *  `turn-complete` so the bubble shows the "Interrupted." footer (matching
   *  the Claude path). Idempotent — clearing happens inside session.idle. */
  markInterrupted(): void {
    this.interruptPending = true;
  }

  private handleHistoryMessage(item: any): void {
    // Verified shape: { info: { id, role, time, ... }, parts: Part[] }
    // INCLUDES user-message here (no optimistic bubble exists for historical messages).
    const info = item.info ?? {};
    const parts: any[] = item.parts ?? [];
    for (const part of parts) {
      const translated = this.translatePart(part, info, /* skipUser = */ false);
      if (translated) this.emit('transcript-event', translated);
    }
    // Each historical assistant message ends a turn.
    if (info.role === 'assistant') {
      this.emit('transcript-event', {
        type: 'turn-complete',
        sessionId: this.opts.desktopSessionId,
        uuid: `oc-tc-hist-${info.id ?? Date.now()}`,
        timestamp: info.time?.created ?? Date.now(),
        data: { stopReason: 'stop', model: info.model ?? null, usage: null },
      });
    }
  }

  private handleEvent(ev: any): void {
    // session.error must be checked BEFORE the sessionID filter because its
    // sessionID field is OPTIONAL per the SDK types. If we filter first, an
    // error event with no sessionID is silently dropped — the user sees the
    // thinking spinner forever with no feedback. Surfacing the error message
    // to the chat is also strictly better than silently failing.
    if (ev?.type === 'session.error') {
      const evSessionId: string | undefined = ev?.properties?.sessionID;
      // If the event names a different session, ignore it. If unnamed, treat
      // as ours so the user gets feedback instead of an indefinite hang.
      if (evSessionId && evSessionId !== this.opts.ocSessionId) return;
      const err = ev?.properties?.error;
      const message = formatOpenCodeError(err);
      const ts = Date.now();
      this.emit('transcript-event', {
        type: 'assistant-text',
        sessionId: this.opts.desktopSessionId,
        uuid: `oc-err-${ts}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: ts,
        data: { text: `⚠️ OpenCode error: ${message}` },
      });
      this.emit('transcript-event', {
        type: 'turn-complete',
        sessionId: this.opts.desktopSessionId,
        uuid: `oc-tc-err-${ts}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: ts,
        data: { stopReason: 'error', model: null, usage: null },
      });
      return;
    }

    // Different events nest sessionID in different places — check all known shapes.
    const sessionId =
      ev?.properties?.info?.sessionID ??
      ev?.properties?.sessionID ??
      ev?.properties?.part?.sessionID;
    if (sessionId !== this.opts.ocSessionId) return;

    // OpenCode 1.14.39+ emits streaming chunks as `message.part.delta` events.
    // Critical discovery 2026-05-12 (verified via SSE probe): the `field`
    // property is NOT a part-type discriminator — it names the property of
    // the part being updated, which is always `text` for content updates
    // (both reasoning AND text parts store their content in `.text`). So
    // routing on `field === 'reasoning'` is a no-op; every reasoning delta
    // arrives with `field: "text"`. Previously this meant reasoning content
    // streamed in as regular text bubbles instead of the collapsed
    // disclosure.
    //
    // The correct discriminator is the part's `type`, only available from
    // `message.part.updated` events. We cache partID → type below and look
    // it up here. The .updated announcement for a new part fires before
    // its first delta (verified), so the cache is primed in time.
    if (ev.type === 'message.part.delta') {
      const props = ev.properties ?? {};
      const delta = props.delta as string | undefined;
      if (typeof delta !== 'string' || !delta) return;
      const ts = Date.now();
      const partId = props.partID as string | undefined;
      const partType = (partId && this.partTypes.get(partId)) ?? 'text';
      if (partType === 'text') {
        // partId is forwarded so the reducer can recognize streaming
        // continuation: consecutive deltas with the same partId append to
        // a single text segment instead of creating a new chat bubble per
        // token. Without it, each chunk renders as its own bubble.
        this.emit('transcript-event', {
          type: 'assistant-text',
          sessionId: this.opts.desktopSessionId,
          uuid: `oc-d-${ts}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: ts,
          data: { text: delta, partId },
        });
        return;
      }
      if (partType === 'reasoning') {
        this.emit('transcript-event', {
          type: 'assistant-thinking',
          sessionId: this.opts.desktopSessionId,
          uuid: `oc-rd-${ts}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: ts,
          data: { text: delta, partId },
        });
        return;
      }
      // step-start / step-finish / tool — no streaming text to emit.
      return;
    }

    // Per-part state announcements. Cache the partID → type mapping for the
    // delta handler above (the discriminator on streaming chunks). Also
    // handles tool state transitions and a legacy in-place delta shape.
    if (ev.type === 'message.part.updated') {
      const part = ev.properties.part;
      const delta = ev.properties.delta as string | undefined;

      // Cache the part's type for delta routing. Safe to overwrite — a
      // part's type doesn't change once announced.
      if (part?.id && typeof part.type === 'string') {
        this.partTypes.set(part.id, part.type);
      }

      // Legacy: older OpenCode versions delivered streaming text via a
      // `delta` field on message.part.updated. Keep this branch for those
      // pinned versions and for the test mocks that use it.
      if (part.type === 'text' && delta) {
        const ts = Date.now();
        this.emit('transcript-event', {
          type: 'assistant-text',
          sessionId: this.opts.desktopSessionId,
          uuid: `oc-${ts}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: ts,
          data: { text: delta },
        });
        return;
      }
      if (part.type === 'reasoning' && delta) {
        const ts = Date.now();
        this.emit('transcript-event', {
          type: 'assistant-thinking',
          sessionId: this.opts.desktopSessionId,
          uuid: `oc-r-${ts}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: ts,
          data: { text: delta },
        });
        return;
      }

      // Tool parts arrive on this event too — every state transition triggers an update.
      if (part.type === 'tool') {
        const translated = this.translatePart(part, { sessionID: sessionId }, /* skipUser */ true);
        if (translated) this.emit('transcript-event', translated);
      }
      return;
    }

    // Final-state assistant message (covers user/system messages on resume too).
    if (ev.type === 'message.updated') {
      const info = ev.properties.info;
      const parts: any[] = info?.parts ?? ev.properties.parts ?? [];
      for (const part of parts) {
        const translated = this.translatePart(part, info, /* skipUser = */ true);
        if (translated) this.emit('transcript-event', translated);
      }
      // Capture turn metadata for the next session.idle. The reducer's
      // TRANSCRIPT_TURN_COMPLETE handler stamps stopReason/model/usage onto
      // the completing turn before endTurn() clears it. Without these the
      // showTurnMetadata strip is empty for local sessions and the
      // StopReasonFooter never appears for max_tokens / refusal turns.
      // Tokens on AssistantMessage.tokens are CUMULATIVE across all
      // step-finish parts in this turn, so last-wins == correct.
      if (info?.role === 'assistant') {
        this.pendingTurnMetadata = {
          stopReason: deriveStopReason(info, parts),
          model: typeof info.modelID === 'string' ? info.modelID : null,
          usage: deriveUsage(info.tokens),
        };
      }
      return;
    }

    // Session metadata updated (most importantly: title auto-generation by
    // OpenCode after the first turn). Emit a side-channel `session-renamed`
    // event that SessionManager forwards to ipc-handlers' broadcastRename —
    // mirrors the Claude path's `~/.claude/topics/topic-<sid>` watcher.
    // Without this, local sessions stay named "Local Session" forever.
    if (ev.type === 'session.updated') {
      const info = ev.properties?.info;
      if (info && info.id === this.opts.ocSessionId && typeof info.title === 'string' && info.title.length > 0) {
        this.emit('session-renamed', {
          desktopSessionId: this.opts.desktopSessionId,
          name: info.title,
        });
      }
      return;
    }

    // Turn complete — session.idle is the cleanest signal. If the user
    // pressed ESC during this turn, emit `user-interrupt` instead so the
    // bubble shows the "Interrupted." footer (matching Claude). Otherwise
    // emit the captured metadata as `turn-complete`.
    if (ev.type === 'session.idle') {
      const ts = Date.now();
      if (this.interruptPending) {
        this.interruptPending = false;
        this.emit('transcript-event', {
          type: 'user-interrupt',
          sessionId: this.opts.desktopSessionId,
          uuid: `oc-int-${ts}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: ts,
          data: { kind: 'plain' },
        });
        // Reset pending metadata since this turn is done.
        this.pendingTurnMetadata = { stopReason: null, model: null, usage: null };
        return;
      }
      const md = this.pendingTurnMetadata;
      this.emit('transcript-event', {
        type: 'turn-complete',
        sessionId: this.opts.desktopSessionId,
        uuid: `oc-tc-${ts}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: ts,
        data: {
          stopReason: md.stopReason ?? 'end_turn',
          model: md.model,
          usage: md.usage,
        },
      });
      this.pendingTurnMetadata = { stopReason: null, model: null, usage: null };
      return;
    }
  }

  private translatePart(part: any, info: any, skipUser: boolean): any | null {
    // All emit shapes put `uuid` and `timestamp` at the TOP level (the renderer
    // dispatch reads event.uuid / event.timestamp directly, NOT event.data.*).
    if (part.type === 'text' && info.role === 'user') {
      if (skipUser) return null;
      // Resume hydration only — uuid-dedup against SSE replay
      if (info.id && this.seenUuids.has(info.id)) return null;
      if (info.id) this.seenUuids.add(info.id);
      return {
        type: 'user-message',
        sessionId: this.opts.desktopSessionId,
        uuid: info.id,
        timestamp: info.time?.created ?? Date.now(),
        data: { text: part.text },
      };
    }
    if (part.type === 'text' && info.role === 'assistant') {
      // Resume hydration — final-state assistant text bubble.
      // (Live SSE delivers deltas via message.part.updated above; this branch
      // is for historical messages where parts are already complete.)
      return {
        type: 'assistant-text',
        sessionId: this.opts.desktopSessionId,
        uuid: part.id,
        timestamp: info.time?.created ?? Date.now(),
        data: { text: part.text },
      };
    }
    if (part.type === 'reasoning' && info.role === 'assistant') {
      // Resume hydration — final-state reasoning part. Emits as a thinking
      // event so the reducer routes it to a reasoning segment (collapsible
      // disclosure). Carries partId so streaming-vs-final-state idempotency
      // is preserved: the live stream's deltas merge by partId, the
      // hydration's final-state arrives once with the same partId and either
      // augments the existing segment or creates a fresh one if SSE was missed.
      return {
        type: 'assistant-thinking',
        sessionId: this.opts.desktopSessionId,
        uuid: part.id,
        timestamp: info.time?.created ?? Date.now(),
        data: { text: part.text, partId: part.id },
      };
    }
    if (part.type === 'tool') {
      // Verified: ToolPart has top-level `tool: string` (the name), `callID: string`,
      // and `state` is itself a discriminated union with `status` field.
      // OpenCode emits tool names lowercase / snake_case (`read`, `web_fetch`,
      // `todo_write`); ToolBody's view-router (tool-views/ToolBody.tsx)
      // dispatches on PascalCase (`Read`, `WebFetch`, `TodoWrite`). Without
      // normalization the tool result renders via the generic fallback view
      // instead of the prettified per-tool view (file diff, bash output, etc).
      const status = part.state?.status;
      const toolName = normalizeToolName(part.tool);
      const toolInput = part.state?.input;
      const ts = info.time?.created ?? Date.now();

      if (status === 'pending' || status === 'running') {
        return {
          type: 'tool-use',
          sessionId: this.opts.desktopSessionId,
          uuid: part.id,
          timestamp: ts,
          data: { toolName, toolInput, toolUseId: part.id },
        };
      }
      if (status === 'completed') {
        return {
          type: 'tool-result',
          sessionId: this.opts.desktopSessionId,
          uuid: part.id,
          timestamp: ts,
          data: {
            toolUseId: part.id,
            result: part.state?.output ?? '',
            isError: false,
          },
        };
      }
      if (status === 'error') {
        return {
          type: 'tool-result',
          sessionId: this.opts.desktopSessionId,
          uuid: part.id,
          timestamp: ts,
          data: {
            toolUseId: part.id,
            result: part.state?.error ?? '',
            isError: true,
          },
        };
      }
    }
    return null;
  }
}

/**
 * Normalize an OpenCode tool name to the PascalCase convention ToolBody's
 * view-router uses. OpenCode emits tools as lowercase (`read`, `bash`) or
 * snake_case / kebab-case (`web_fetch`, `todo-write`); without this the
 * per-tool render branches in tool-views/ToolBody.tsx miss every match and
 * the result falls through to the generic fallback view.
 *
 *   "read"        → "Read"
 *   "web_fetch"   → "WebFetch"
 *   "todo-write"  → "TodoWrite"
 *   "Read"        → "Read"   (idempotent — already PascalCase)
 *   "mcp__..."    → unchanged (MCP tools route by exact match)
 */
export function normalizeToolName(name: string | undefined | null): string {
  if (!name) return '';
  if (name.startsWith('mcp__')) return name;
  // Already PascalCase (no separators, leading uppercase) — pass through.
  if (/^[A-Z]/.test(name) && !/[_\-]/.test(name)) return name;
  return name
    .split(/[_\-]/)
    .filter(Boolean)
    .map(s => s.charAt(0).toUpperCase() + s.slice(1))
    .join('');
}

/**
 * Map an OpenCode AssistantMessage's tokens object into YouCoded's TurnUsage
 * shape (chat-types.ts). Returns null on malformed input rather than throwing
 * — caller treats null as "metadata strip stays empty for this turn."
 */
export function deriveUsage(
  tokens: { input?: number; output?: number; cache?: { read?: number; write?: number } } | null | undefined,
): { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheCreationTokens: number } | null {
  if (!tokens || typeof tokens !== 'object') return null;
  return {
    inputTokens: typeof tokens.input === 'number' ? tokens.input : 0,
    outputTokens: typeof tokens.output === 'number' ? tokens.output : 0,
    cacheReadTokens: typeof tokens.cache?.read === 'number' ? tokens.cache.read : 0,
    cacheCreationTokens: typeof tokens.cache?.write === 'number' ? tokens.cache.write : 0,
  };
}

/**
 * Derive a YouCoded stopReason from an OpenCode AssistantMessage. Order:
 *   1. info.error (if present) — abort / length / provider error
 *   2. The latest step-finish part's reason — 'stop' / 'length' / 'tool-calls' / etc.
 *   3. Default to 'end_turn'
 *
 * StopReasonFooter only renders for non-`end_turn` reasons that have copy in
 * STOP_REASON_COPY (max_tokens, stop_sequence, refusal, pause_turn, interrupted).
 * Anything outside that set falls through to the generic "Response ended"
 * footer or is hidden — both acceptable.
 */
export function deriveStopReason(info: any, parts: any[]): string {
  const err = info?.error;
  if (err && typeof err === 'object') {
    const name: string = err.name ?? '';
    if (name === 'MessageOutputLengthError') return 'max_tokens';
    if (name === 'MessageAbortedError') return 'interrupted';
    // Other errors (ProviderAuthError, ApiError, UnknownError) surface via
    // the session.error event handler with their own assistant-text bubble;
    // the turn ends with a generic 'error' reason.
    if (name) return 'error';
  }
  // Find the LAST step-finish part — it carries the reason for the final
  // sub-step of the turn. Earlier step-finishes are intermediate (typically
  // `tool-calls` then a final `stop`).
  let lastReason: string | null = null;
  for (const p of parts) {
    if (p?.type === 'step-finish' && typeof p.reason === 'string') {
      lastReason = p.reason;
    }
  }
  if (lastReason === 'length') return 'max_tokens';
  if (lastReason === 'content-filter') return 'refusal';
  if (lastReason === 'stop') return 'end_turn';
  // 'tool-calls', 'other', 'unknown', or absent — treat as a normal turn end
  // so no spurious footer renders.
  return 'end_turn';
}

/**
 * Render a session.error payload as a human-readable message for the assistant
 * bubble. Per SDK types, `error` is a discriminated union over several shapes:
 * ProviderAuthError, UnknownError, MessageOutputLengthError, MessageAbortedError, ApiError.
 * They all share `name` plus a `data` payload with shape-specific fields.
 * We surface `name` + the most diagnostic field we can find.
 */
function formatOpenCodeError(err: any): string {
  if (!err) return 'unknown error';
  const name: string = err?.name ?? 'Error';
  const data = err?.data ?? {};
  // ProviderModelNotFoundError lists providerID + modelID. Most useful first.
  if (name === 'ProviderModelNotFoundError') {
    return `${name}: provider "${data.providerID}" has no model "${data.modelID}"`;
  }

  // Recognize a few common Ollama API-error patterns and translate them into
  // actionable user guidance. The Ollama text comes through as
  // `data.message` on the underlying APIError; pattern-match on the suffix.
  const apiMsg: string | undefined = (typeof data.message === 'string' && data.message) ? data.message
    : (typeof err.message === 'string' && err.message) ? err.message
    : undefined;
  if (apiMsg) {
    // "X does not support tools" — model is incompatible with OpenCode's
    // coding-agent tool definitions. Examples: gemma3, phi3, base llamas.
    // OpenCode is fundamentally a coding agent (every prompt ships tool
    // definitions), so this model can't be used here regardless of how the
    // user might want to chat with it.
    if (/does not support tools/i.test(apiMsg)) {
      return `This model doesn't support tool use, which YouCoded's local mode requires. Try a tool-capable model from Settings → Local Models (Qwen 3, Gemma 4, or Qwen 2.5+ all work).`;
    }
    // "X does not support thinking" — model can't be used with the user's
    // current Thinking setting. Direct them to Off or a different model.
    if (/does not support thinking/i.test(apiMsg)) {
      return `This model doesn't support thinking. Start a new session with Thinking set to Off, or pick a thinking-capable model (Qwen 3 or Gemma 4).`;
    }
    return `${name}: ${apiMsg}`;
  }
  // Last resort: stringify so the user gets *something* to file a bug with.
  try { return `${name}: ${JSON.stringify(data)}`; } catch { return name; }
}
