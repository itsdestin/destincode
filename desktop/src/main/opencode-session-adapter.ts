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
  private unsubscribe: (() => void) | null = null;
  private seenUuids = new Set<string>();
  private destroyed = false;

  constructor(private readonly opts: OpenCodeSessionAdapterOpts) {
    super();
    void this.init();
  }

  private async init(): Promise<void> {
    const sdk = this.opts.service.sdk();

    // Hydration first (fetch history, synthesize events) — defensive against
    // SSE delivering only new events. Then subscribe to live.
    // Verified: client.session.messages(id) returns Array<{ info: Message, parts: Part[] }>.
    if (this.opts.isResume) {
      try {
        const messages = await sdk.session.messages(this.opts.ocSessionId);
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
    this.unsubscribe = sdk.event.subscribe((ev: any) => this.handleEvent(ev));
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
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
        data: { stopReason: 'stop', model: info.model ?? null, usage: null },
      });
    }
  }

  private handleEvent(ev: any): void {
    // Different events nest sessionID in different places — check all known shapes.
    const sessionId =
      ev?.properties?.info?.sessionID ??
      ev?.properties?.sessionID ??
      ev?.properties?.part?.sessionID;
    if (sessionId !== this.opts.ocSessionId) return;

    // Streaming text/reasoning deltas: message.part.updated carries `delta` string.
    if (ev.type === 'message.part.updated') {
      const part = ev.properties.part;
      const delta = ev.properties.delta as string | undefined;

      if (part.type === 'text' && delta) {
        this.emit('transcript-event', {
          type: 'assistant-text',
          sessionId: this.opts.desktopSessionId,
          data: { text: delta, timestamp: Date.now(), uuid: `oc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` },
        });
        return;
      }
      if (part.type === 'reasoning' && delta) {
        this.emit('transcript-event', {
          type: 'assistant-thinking',
          sessionId: this.opts.desktopSessionId,
          data: { text: delta, timestamp: Date.now() },
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
      this.emit('transcript-event', {
        type: 'turn-complete',
        sessionId: this.opts.desktopSessionId,
        data: { stopReason: 'stop', model: null, usage: null },
      });
      return;
    }
  }

  private translatePart(part: any, info: any, skipUser: boolean): any | null {
    if (part.type === 'text' && info.role === 'user') {
      if (skipUser) return null;
      // Resume hydration only — uuid-dedup against SSE replay
      if (info.id && this.seenUuids.has(info.id)) return null;
      if (info.id) this.seenUuids.add(info.id);
      return {
        type: 'user-message',
        sessionId: this.opts.desktopSessionId,
        data: { text: part.text, timestamp: info.time?.created ?? Date.now(), uuid: info.id },
      };
    }
    if (part.type === 'text' && info.role === 'assistant') {
      // Resume hydration — final-state assistant text bubble.
      // (Live SSE delivers deltas via message.part.updated above; this branch
      // is for historical messages where parts are already complete.)
      return {
        type: 'assistant-text',
        sessionId: this.opts.desktopSessionId,
        data: { text: part.text, timestamp: info.time?.created ?? Date.now(), uuid: part.id },
      };
    }
    if (part.type === 'tool') {
      // Verified: ToolPart has top-level `tool: string` (the name), `callID: string`,
      // and `state` is itself a discriminated union with `status` field.
      const status = part.state?.status;
      const toolName = part.tool;
      const toolInput = part.state?.input;

      if (status === 'pending' || status === 'running') {
        return {
          type: 'tool-use',
          sessionId: this.opts.desktopSessionId,
          data: {
            toolName,
            toolInput,
            toolUseId: part.id,
            timestamp: info.time?.created ?? Date.now(),
          },
        };
      }
      if (status === 'completed') {
        return {
          type: 'tool-result',
          sessionId: this.opts.desktopSessionId,
          data: {
            toolUseId: part.id,
            result: part.state?.output ?? '',
            isError: false,
            timestamp: info.time?.created ?? Date.now(),
          },
        };
      }
      if (status === 'error') {
        return {
          type: 'tool-result',
          sessionId: this.opts.desktopSessionId,
          data: {
            toolUseId: part.id,
            result: part.state?.error ?? '',
            isError: true,
            timestamp: info.time?.created ?? Date.now(),
          },
        };
      }
    }
    return null;
  }
}
