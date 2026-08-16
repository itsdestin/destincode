import { describe, it, expect } from 'vitest';
import { parseTranscriptLine } from './transcript-watcher';

function makeUserLine(
  text: string,
  promptId = 'pid-1',
  uuid = 'u-1',
  timestamp = '2026-04-21T00:00:00Z',
) {
  return JSON.stringify({
    type: 'user',
    promptId,
    uuid,
    timestamp,
    message: { role: 'user', content: [{ type: 'text', text }] },
  });
}

describe('transcript-watcher interrupt detection', () => {
  it('emits user-interrupt (kind=plain) for "[Request interrupted by user]"', () => {
    const events = parseTranscriptLine(
      makeUserLine('[Request interrupted by user]'),
      'sess-1',
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'user-interrupt',
        sessionId: 'sess-1',
        data: { kind: 'plain' },
      }),
    ]);
  });

  it('emits user-interrupt (kind=tool-use) for "[Request interrupted by user for tool use]"', () => {
    const events = parseTranscriptLine(
      makeUserLine('[Request interrupted by user for tool use]'),
      'sess-1',
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: 'user-interrupt',
        sessionId: 'sess-1',
        data: { kind: 'tool-use' },
      }),
    ]);
  });

  it('does NOT emit a user-message when emitting user-interrupt', () => {
    const events = parseTranscriptLine(
      makeUserLine('[Request interrupted by user]'),
      'sess-1',
    );
    expect(events.some((e) => e.type === 'user-message')).toBe(false);
  });

  it('emits user-message for a normal user prompt', () => {
    const events = parseTranscriptLine(makeUserLine('hello claude'), 'sess-1');
    expect(events).toEqual([
      expect.objectContaining({
        type: 'user-message',
        data: expect.objectContaining({ text: 'hello claude' }),
      }),
    ]);
  });

  it('treats interrupt text embedded in longer content as a normal user-message', () => {
    const events = parseTranscriptLine(
      makeUserLine('hey, [Request interrupted by user] btw'),
      'sess-1',
    );
    expect(events).toEqual([
      expect.objectContaining({ type: 'user-message' }),
    ]);
  });
});

// Regression tests for the post-/compact bugs:
//   (1) a "Compacted (ctrl+o to see full summary)" user bubble appearing
//       after every /compact, and
//   (2) chat view permanently stuck in "thinking" state after every /compact.
// Both stemmed from the parser UNWRAPPING <local-command-stdout>, which let CC's
// dimmed stdout echo of /compact reach the reducer's TRANSCRIPT_USER_MESSAGE
// "no pending match" path — appending a fake user bubble AND setting
// isThinking:true with no transcript turn to ever clear it.
describe('transcript-watcher local-command-stdout suppression', () => {
  it('emits NO events for the dimmed "Compacted (...)" stdout echo after /compact', () => {
    const line = JSON.stringify({
      type: 'user',
      promptId: 'pid-1',
      uuid: 'u-compact-stdout',
      timestamp: '2026-04-29T05:29:38.779Z',
      message: {
        role: 'user',
        // Exact shape CC v2.1.119 writes — ANSI [2m dim wrap around the inner text.
        content: '<local-command-stdout>[2mCompacted (ctrl+o to see full summary)[22m</local-command-stdout>',
      },
    });
    const events = parseTranscriptLine(line, 'sess-1');
    expect(events).toEqual([]);
  });

  it('strips <local-command-stderr> the same way', () => {
    const line = JSON.stringify({
      type: 'user',
      promptId: 'pid-1',
      uuid: 'u-stderr',
      message: { role: 'user', content: '<local-command-stderr>boom</local-command-stderr>' },
    });
    expect(parseTranscriptLine(line, 'sess-1')).toEqual([]);
  });
});

describe('transcript-watcher compact-summary forwarding', () => {
  it('emits compact-summary with the summary text from an isCompactSummary line', () => {
    const summary = 'Summary:\n1. Primary Request: do the thing\n2. Files: foo.ts';
    const line = JSON.stringify({
      type: 'user',
      isCompactSummary: true,
      isVisibleInTranscriptOnly: true,
      uuid: 'u-compact',
      timestamp: '2026-04-29T05:29:38.615Z',
      message: { role: 'user', content: summary },
    });
    const events = parseTranscriptLine(line, 'sess-1');
    expect(events).toEqual([
      expect.objectContaining({
        type: 'compact-summary',
        sessionId: 'sess-1',
        data: { summary },
      }),
    ]);
  });

  it('omits summary field on an isCompactSummary line with empty content', () => {
    const line = JSON.stringify({
      type: 'user',
      isCompactSummary: true,
      uuid: 'u-empty',
      message: { role: 'user', content: '' },
    });
    const events = parseTranscriptLine(line, 'sess-1');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('compact-summary');
    expect(events[0].data).toEqual({});
  });
});
