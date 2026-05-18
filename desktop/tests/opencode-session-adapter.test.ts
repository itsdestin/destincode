import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenCodeSessionAdapter } from '../src/main/opencode-session-adapter';
import { EventEmitter } from 'events';

function makeFakeService() {
  const eventBus = new EventEmitter();
  // Per-session message history mock — lets tests pre-seed history so
  // the resume hydration path can be exercised.
  const historyBySession = new Map<string, any[]>();
  return {
    eventBus,
    seedHistory(sessionId: string, messages: any[]) {
      historyBySession.set(sessionId, messages);
    },
    sdk: () => ({
      event: {
        // The adapter probes both SDK shapes: first the real Stainless SDK
        // (no-arg call returning Promise<{stream}>), then the legacy callback
        // shape. If we accept a no-arg call here, we'd register a broken
        // listener (handler=undefined) that throws when events fire. Reject
        // the no-arg call so the adapter falls through to the callback path.
        subscribe: (handler?: (ev: any) => void) => {
          if (typeof handler !== 'function') {
            throw new Error('test fixture: legacy callback shape requires a handler');
          }
          const fn = (ev: any) => handler(ev);
          eventBus.on('event', fn);
          return () => eventBus.off('event', fn);
        },
      },
      session: {
        // Verified: client.session.messages(id) returns Array<{info: Message, parts: Part[]}>
        messages: async (sessionId: string) => historyBySession.get(sessionId) ?? [],
      },
    }),
  };
}

describe('OpenCodeSessionAdapter', () => {
  let svc: ReturnType<typeof makeFakeService>;
  let adapter: OpenCodeSessionAdapter;
  let emitted: any[];

  beforeEach(async () => {
    svc = makeFakeService();
    adapter = new OpenCodeSessionAdapter({
      ocSessionId: 'OC1',
      desktopSessionId: 'DESK1',   // intentionally different from ocSessionId to prove emit-tag uses desktop id
      service: svc as any,
      isResume: false,
    });
    emitted = [];
    adapter.on('transcript-event', (ev) => emitted.push(ev));
    // Wait for adapter's async constructor work (subscribe, optional history fetch)
    await new Promise((r) => setImmediate(r));
  });

  afterEach(() => adapter.destroy());

  it('SKIPS user-message events from OpenCode (dedup is handled by SessionManager synthetic emit)', () => {
    svc.eventBus.emit('event', {
      type: 'message.updated',
      properties: {
        info: { id: 'M1', sessionID: 'OC1', role: 'user', time: { created: 1714857600000 } },
        parts: [{ type: 'text', text: 'hello' }],
      },
    });
    expect(emitted).toEqual([]);
  });

  it('translates assistant TextPart deltas into "assistant-text" events tagged with desktopSessionId', () => {
    // Verified: streaming text deltas arrive on message.part.updated with `delta` populated.
    svc.eventBus.emit('event', {
      type: 'message.part.updated',
      properties: {
        delta: 'hello ',
        part: { type: 'text', id: 'P1', sessionID: 'OC1', messageID: 'M1', text: 'hello ' },
      },
    });
    svc.eventBus.emit('event', {
      type: 'message.part.updated',
      properties: {
        delta: 'world',
        part: { type: 'text', id: 'P1', sessionID: 'OC1', messageID: 'M1', text: 'hello world' },
      },
    });
    expect(emitted.map(e => e.type)).toEqual(['assistant-text', 'assistant-text']);
    expect(emitted.map(e => e.data.text)).toEqual(['hello ', 'world']);
    expect(emitted.every(e => e.sessionId === 'DESK1')).toBe(true);   // emit uses desktopSessionId
  });

  it('translates ReasoningPart deltas into "assistant-thinking" tagged with desktopSessionId', () => {
    svc.eventBus.emit('event', {
      type: 'message.part.updated',
      properties: {
        delta: 'pondering...',
        part: { type: 'reasoning', id: 'P2', sessionID: 'OC1', messageID: 'M1', text: 'pondering...', time: { start: 1 } },
      },
    });
    expect(emitted[0]).toMatchObject({
      type: 'assistant-thinking',
      sessionId: 'DESK1',
      data: { text: 'pondering...' },
    });
  });

  it('translates ToolPart pending into "tool-use" with input', () => {
    // Verified: ToolPart.state is itself a discriminated union with `status` field;
    // input lives at part.state.input, tool name at part.tool (string).
    svc.eventBus.emit('event', {
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'tool',
          id: 'T1',
          callID: 'call-1',
          sessionID: 'OC1',
          messageID: 'M2',
          tool: 'read_file',
          state: { status: 'pending', input: { path: '/x' }, raw: '' },
        },
      },
    });
    expect(emitted[0]).toMatchObject({
      type: 'tool-use',
      sessionId: 'DESK1',
      // Tool name is normalized to PascalCase (read_file → ReadFile) so
      // ToolBody's view-router (tool-views/ToolBody.tsx) dispatches to the
      // prettified per-tool view instead of the generic fallback. See
      // normalizeToolName + opencode-adapter-helpers.test.ts.
      data: { toolName: 'ReadFile', toolInput: { path: '/x' }, toolUseId: 'T1' },
    });
  });

  it('translates ToolPart completed into "tool-result"', () => {
    svc.eventBus.emit('event', {
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'tool',
          id: 'T1',
          callID: 'call-1',
          sessionID: 'OC1',
          messageID: 'M2',
          tool: 'read_file',
          state: {
            status: 'completed',
            input: { path: '/x' },
            output: 'file contents',
            title: 'read_file',
            metadata: {},
            time: { start: 1, end: 2 },
          },
        },
      },
    });
    expect(emitted[0]).toMatchObject({
      type: 'tool-result',
      sessionId: 'DESK1',
      data: { toolUseId: 'T1', result: 'file contents', isError: false },
    });
  });

  it('translates ToolPart error into "tool-result" with isError:true', () => {
    // Verified: error status literal is 'error' (not 'failed').
    svc.eventBus.emit('event', {
      type: 'message.part.updated',
      properties: {
        part: {
          type: 'tool',
          id: 'T2',
          callID: 'call-2',
          sessionID: 'OC1',
          messageID: 'M2',
          tool: 'bash',
          state: { status: 'error', input: {}, error: 'permission denied', time: { start: 1, end: 2 } },
        },
      },
    });
    expect(emitted[0]).toMatchObject({
      type: 'tool-result',
      sessionId: 'DESK1',
      data: { toolUseId: 'T2', result: 'permission denied', isError: true },
    });
  });

  it('translates streaming text deltas into "assistant-text" (text part primed by .updated)', () => {
    // Empirically captured from a live OpenCode 1.14.39 SSE stream — streaming
    // chunks arrive as message.part.delta. The .updated event for the part
    // ALWAYS fires first with the part's `type`; the adapter caches that and
    // routes subsequent deltas. The `field` property on deltas is NOT a
    // discriminator — it always names the property being updated, which is
    // `.text` for both text and reasoning parts (verified 2026-05-12).
    svc.eventBus.emit('event', {
      type: 'message.part.updated',
      properties: { sessionID: 'OC1', part: { id: 'P1', type: 'text' } },
    });
    svc.eventBus.emit('event', {
      type: 'message.part.delta',
      properties: { sessionID: 'OC1', messageID: 'M1', partID: 'P1', field: 'text', delta: 'Hello' },
    });
    svc.eventBus.emit('event', {
      type: 'message.part.delta',
      properties: { sessionID: 'OC1', messageID: 'M1', partID: 'P1', field: 'text', delta: ' world' },
    });
    expect(emitted.map(e => e.type)).toEqual(['assistant-text', 'assistant-text']);
    expect(emitted.map(e => e.data.text)).toEqual(['Hello', ' world']);
    expect(emitted[0].sessionId).toBe('DESK1');   // tagged with desktop id, not OC id
  });

  it('translates streaming reasoning deltas into "assistant-thinking" (reasoning part primed by .updated)', () => {
    // Critical: even though all deltas carry `field: "text"`, the partType
    // cache from the prior .updated event correctly routes this to reasoning.
    svc.eventBus.emit('event', {
      type: 'message.part.updated',
      properties: { sessionID: 'OC1', part: { id: 'P_REASON', type: 'reasoning' } },
    });
    svc.eventBus.emit('event', {
      type: 'message.part.delta',
      properties: { sessionID: 'OC1', messageID: 'M1', partID: 'P_REASON', field: 'text', delta: 'Hmm…' },
    });
    expect(emitted[0]).toMatchObject({ type: 'assistant-thinking', sessionId: 'DESK1' });
    expect(emitted[0].data.text).toBe('Hmm…');
  });

  it('IGNORES "message.part.delta" for non-content part types (step-start, tool, etc.)', () => {
    // Lifecycle parts don't carry streaming text content. Their deltas (if
    // OpenCode ever emits any) should be silently ignored — they are not
    // assistant-visible content.
    svc.eventBus.emit('event', {
      type: 'message.part.updated',
      properties: { sessionID: 'OC1', part: { id: 'P_STEP', type: 'step-start' } },
    });
    svc.eventBus.emit('event', {
      type: 'message.part.delta',
      properties: { sessionID: 'OC1', messageID: 'M1', partID: 'P_STEP', field: 'text', delta: 'noise' },
    });
    expect(emitted).toEqual([]);
  });

  it('translates session.idle into "turn-complete"', () => {
    // Verified: session.idle is the cleanest turn-complete signal.
    svc.eventBus.emit('event', {
      type: 'session.idle',
      properties: { sessionID: 'OC1' },
    });
    expect(emitted[0]).toMatchObject({
      type: 'turn-complete',
      sessionId: 'DESK1',
    });
  });

  it('IGNORES events for other OpenCode sessions', () => {
    svc.eventBus.emit('event', {
      type: 'message.part.updated',
      properties: {
        part: { type: 'text', id: 'P', sessionID: 'OC_OTHER', messageID: 'M', text: 'not ours' },
        delta: 'not ours',
      },
    });
    expect(emitted).toEqual([]);
  });

  it('translates session.error into a visible error bubble + turn-complete', () => {
    // Empirically confirmed: when OpenCode raises ProviderModelNotFoundError,
    // it publishes session.error followed by session.idle. Without this branch,
    // the user sees the thinking spinner indefinitely with no explanation of
    // what went wrong (the SDK call returns 200; the failure only flows through SSE).
    svc.eventBus.emit('event', {
      type: 'session.error',
      properties: {
        sessionID: 'OC1',
        error: {
          name: 'ProviderModelNotFoundError',
          data: { providerID: 'ollama', modelID: 'qwen3:8b', suggestions: [] },
        },
      },
    });
    expect(emitted.map(e => e.type)).toEqual(['assistant-text', 'turn-complete']);
    expect(emitted[0].data.text).toMatch(/ProviderModelNotFoundError/);
    expect(emitted[0].data.text).toMatch(/qwen3:8b/);
    expect(emitted[1]).toMatchObject({ type: 'turn-complete', sessionId: 'DESK1' });
  });

  it('treats session.error with no sessionID as ours (errors must not be silently dropped)', () => {
    // SDK types mark sessionID as optional on EventSessionError. If we filtered
    // strictly, an unnamed error would hang the spinner forever. Surfacing is
    // strictly better than silently dropping — the worst case is a spurious
    // error bubble in another tab, which is recoverable; an indefinite spinner is not.
    svc.eventBus.emit('event', {
      type: 'session.error',
      properties: {
        error: { name: 'UnknownError', data: { message: 'something broke' } },
      },
    });
    expect(emitted.map(e => e.type)).toEqual(['assistant-text', 'turn-complete']);
    expect(emitted[0].data.text).toMatch(/UnknownError/);
  });

  it('IGNORES session.error for a different session', () => {
    svc.eventBus.emit('event', {
      type: 'session.error',
      properties: {
        sessionID: 'OC_OTHER',
        error: { name: 'UnknownError', data: { message: 'not ours' } },
      },
    });
    expect(emitted).toEqual([]);
  });

  it('destroy() unsubscribes — no further events emitted after', () => {
    adapter.destroy();
    svc.eventBus.emit('event', {
      type: 'message.part.updated',
      properties: {
        part: { type: 'text', id: 'P', sessionID: 'OC1', messageID: 'M', text: 'late' },
        delta: 'late',
      },
    });
    expect(emitted).toEqual([]);
  });

  it('isResume:true fetches message history via REST and emits transcript-events for each message', async () => {
    // Tear down the default adapter (from beforeEach) and create a resume one.
    adapter.destroy();
    // Verified shape: messages() returns Array<{ info: Message, parts: Part[] }>
    svc.seedHistory('OC1', [
      {
        info: { id: 'm-1', role: 'user',      time: { created: 100 } },
        parts: [{ type: 'text', id: 'p-1', sessionID: 'OC1', messageID: 'm-1', text: 'prior q' }],
      },
      {
        info: { id: 'm-2', role: 'assistant', time: { created: 200 } },
        parts: [{ type: 'text', id: 'p-2', sessionID: 'OC1', messageID: 'm-2', text: 'prior a' }],
      },
    ]);
    emitted = [];
    adapter = new OpenCodeSessionAdapter({
      ocSessionId: 'OC1', desktopSessionId: 'DESK1',
      service: svc as any, isResume: true,
    });
    adapter.on('transcript-event', (ev) => emitted.push(ev));
    // Wait for the async history fetch
    await new Promise((r) => setTimeout(r, 50));

    // Note: user-message IS emitted from the history-fetch path even though
    // it's skipped from live SSE — the optimistic dedup doesn't apply on
    // resume (no pending entries to match against; the chat reducer state
    // for the resumed session starts empty).
    expect(emitted.map(e => e.type)).toEqual(['user-message', 'assistant-text', 'turn-complete']);
    expect(emitted[0].data.text).toBe('prior q');
    expect(emitted[1].data.text).toBe('prior a');
  });
});
