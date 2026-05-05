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
        subscribe: (handler: (ev: any) => void) => {
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
      data: { toolName: 'read_file', toolInput: { path: '/x' }, toolUseId: 'T1' },
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
