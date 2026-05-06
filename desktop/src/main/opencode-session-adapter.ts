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

    // OpenCode 1.14.39+ emits streaming chunks as `message.part.delta` events with
    // shape { sessionID, messageID, partID, field: "text"|"reasoning", delta: string }.
    // Earlier docs/SDKs put deltas on `message.part.updated` — this branch covers
    // the post-1.14 protocol. Without it, all streaming text is silently discarded
    // and the chat UI shows nothing while OpenCode is busy generating tokens.
    if (ev.type === 'message.part.delta') {
      const props = ev.properties ?? {};
      const field = props.field as string | undefined;
      const delta = props.delta as string | undefined;
      if (typeof delta !== 'string' || !delta) return;
      const ts = Date.now();
      const partId = props.partID as string | undefined;
      if (field === 'text') {
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
      if (field === 'reasoning') {
        this.emit('transcript-event', {
          type: 'assistant-thinking',
          sessionId: this.opts.desktopSessionId,
          uuid: `oc-rd-${ts}-${Math.random().toString(36).slice(2, 8)}`,
          timestamp: ts,
          data: { text: delta, partId },
        });
        return;
      }
      return;
    }

    // Streaming text/reasoning deltas: message.part.updated carries `delta` string.
    if (ev.type === 'message.part.updated') {
      const part = ev.properties.part;
      const delta = ev.properties.delta as string | undefined;

      if (part.type === 'text' && delta) {
        // Renderer's dispatch reads event.uuid and event.timestamp at TOP level.
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
      return;
    }

    // Turn complete — session.idle is the cleanest signal.
    if (ev.type === 'session.idle') {
      const ts = Date.now();
      this.emit('transcript-event', {
        type: 'turn-complete',
        sessionId: this.opts.desktopSessionId,
        uuid: `oc-tc-${ts}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: ts,
        data: { stopReason: 'end_turn', model: null, usage: null },
      });
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
    if (part.type === 'tool') {
      // Verified: ToolPart has top-level `tool: string` (the name), `callID: string`,
      // and `state` is itself a discriminated union with `status` field.
      const status = part.state?.status;
      const toolName = part.tool;
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
  if (typeof data.message === 'string' && data.message) return `${name}: ${data.message}`;
  if (typeof err.message === 'string' && err.message) return `${name}: ${err.message}`;
  // Last resort: stringify so the user gets *something* to file a bug with.
  try { return `${name}: ${JSON.stringify(data)}`; } catch { return name; }
}
