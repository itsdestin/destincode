import { describe, it, expect } from 'vitest';
import {
  isRealUserTurn,
  userTurnText,
  isIndexableText,
  normalizeTimestamp,
  extractCcUserTurns,
  extractNativeUserTurns,
} from '../src/main/chatsearch-index/index-core';

// Real CC line shapes, trimmed to the fields the gate reads. Verified against
// ~/.claude/projects/*.jsonl on 2026-08-05.
const ccPrompt = (over: Record<string, unknown> = {}) => JSON.stringify({
  type: 'user',
  promptId: 'p1',
  uuid: 'u1',
  timestamp: '2026-07-26T18:04:11.000Z',
  message: { role: 'user', content: 'the actual message text' },
  ...over,
});

const ccToolResult = () => JSON.stringify({
  type: 'user',
  promptId: 'p1',
  uuid: 'u2',
  timestamp: '2026-07-26T18:04:24.000Z',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'output' }] },
});

const ccInjected = () => JSON.stringify({
  type: 'user',
  promptId: 'p1',
  uuid: 'u3',
  isMeta: true,
  timestamp: '2026-07-26T18:05:00.000Z',
  message: { role: 'user', content: [{ type: 'text', text: 'Base directory for this skill: /x' }] },
});

const ccWrapped = () => JSON.stringify({
  type: 'user',
  promptId: 'p1',
  uuid: 'u4',
  timestamp: '2026-07-26T18:06:00.000Z',
  message: { role: 'user', content: '<system-reminder>plumbing</system-reminder>' },
});

describe('isRealUserTurn', () => {
  it('accepts a typed user prompt', () => {
    expect(isRealUserTurn(JSON.parse(ccPrompt()))).toBe(true);
  });

  it('rejects assistant lines', () => {
    expect(isRealUserTurn({ type: 'assistant', promptId: 'p', message: {} })).toBe(false);
  });

  it('rejects isMeta lines', () => {
    expect(isRealUserTurn(JSON.parse(ccInjected()))).toBe(false);
  });

  it('rejects lines with no promptId or no message', () => {
    expect(isRealUserTurn({ type: 'user', message: {} })).toBe(false);
    expect(isRealUserTurn({ type: 'user', promptId: 'p' })).toBe(false);
  });

  it('rejects non-objects without throwing', () => {
    expect(isRealUserTurn(null)).toBe(false);
    expect(isRealUserTurn('string')).toBe(false);
  });

  // The gate alone does NOT exclude tool results — they carry a promptId. This
  // pins that fact so nobody "simplifies" the text-block filter away later.
  it('accepts a tool-result carrier (text extraction is what excludes it)', () => {
    expect(isRealUserTurn(JSON.parse(ccToolResult()))).toBe(true);
  });
});

describe('userTurnText', () => {
  it('returns string content as-is', () => {
    expect(userTurnText(JSON.parse(ccPrompt()))).toBe('the actual message text');
  });

  it('joins only text blocks from array content', () => {
    const parsed = { message: { content: [
      { type: 'text', text: 'one' },
      { type: 'tool_result', content: 'ignored' },
      { type: 'text', text: 'two' },
    ] } };
    expect(userTurnText(parsed)).toBe('one\ntwo');
    expect(userTurnText(parsed, ' ')).toBe('one two');
  });

  // This is the real mechanism that drops tool results from the index.
  it('yields empty string for a tool-result-only line', () => {
    expect(userTurnText(JSON.parse(ccToolResult()))).toBe('');
  });

  it('yields empty string for missing or odd content', () => {
    expect(userTurnText({})).toBe('');
    expect(userTurnText({ message: { content: 42 } })).toBe('');
  });
});

describe('isIndexableText', () => {
  it('accepts ordinary prose', () => {
    expect(isIndexableText('did we finish the timeout work?')).toBe(true);
  });

  it('rejects empty and whitespace-only', () => {
    expect(isIndexableText('')).toBe(false);
    expect(isIndexableText('   \n ')).toBe(false);
  });

  // Injected wrappers. Deliberately lossy: a real prompt starting with '<'
  // is dropped too. loadHistory does NOT apply this — chat rendering must keep
  // such a prompt — which is why this lives here and not in a shared gate.
  it('rejects <-wrapped injected content', () => {
    expect(isIndexableText('<system-reminder>x</system-reminder>')).toBe(false);
    expect(isIndexableText('  <command-name>/foo</command-name>')).toBe(false);
  });
});

describe('normalizeTimestamp', () => {
  it('passes through an ISO string', () => {
    expect(normalizeTimestamp('2026-07-26T18:04:11.000Z')).toBe('2026-07-26T18:04:11.000Z');
  });

  // CC writes ISO strings, the native harness writes epoch ms numbers. The index
  // stores one format so ranges and sorting work across both lanes.
  // NOTE: the brief's literal expected value was wrong (verified via
  // `node -e "console.log(new Date(1785990913428).toISOString())"`, which is
  // deterministic and independent of system clock/timezone). Recomputed here
  // per the task instructions: the conversion is the contract, not the literal.
  it('converts epoch milliseconds to ISO', () => {
    expect(normalizeTimestamp(1785990913428)).toBe('2026-08-06T04:35:13.428Z');
  });

  it('returns empty string for unparseable input', () => {
    expect(normalizeTimestamp(undefined)).toBe('');
    expect(normalizeTimestamp('not a date')).toBe('');
  });
});

describe('extractCcUserTurns', () => {
  it('extracts prompts and skips tool results, injected, and wrapped lines', () => {
    const chunk = [ccPrompt(), ccToolResult(), ccInjected(), ccWrapped()].join('\n') + '\n';
    const { turns } = extractCcUserTurns(chunk, 'conv-1', 1);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({
      conversationId: 'conv-1',
      turn: 1,
      ts: '2026-07-26T18:04:11.000Z',
      text: 'the actual message text',
    });
  });

  it('numbers turns from startTurn', () => {
    const chunk = [ccPrompt({ uuid: 'a' }), ccPrompt({ uuid: 'b' })].join('\n') + '\n';
    const { turns } = extractCcUserTurns(chunk, 'c', 7);
    expect(turns.map((t) => t.turn)).toEqual([7, 8]);
  });

  it('skips blank lines, null-byte lines, and unparseable JSON', () => {
    const chunk = ['', '{ not json', `{"type":"user" }`, ccPrompt()].join('\n') + '\n';
    const { turns } = extractCcUserTurns(chunk, 'c', 1);
    expect(turns).toHaveLength(1);
  });

  // consumedBytes is what makes incremental refresh safe: the next read starts
  // on a line boundary, so a half-written trailing line is never parsed.
  it('reports consumedBytes up to the last complete line', () => {
    const complete = ccPrompt() + '\n';
    const chunk = complete + '{"type":"user","promptId":"p","mess';
    const { turns, consumedBytes } = extractCcUserTurns(chunk, 'c', 1);
    expect(turns).toHaveLength(1);
    expect(consumedBytes).toBe(Buffer.byteLength(complete, 'utf8'));
  });

  it('reports zero consumedBytes when no line is complete', () => {
    const { turns, consumedBytes } = extractCcUserTurns('{"partial', 'c', 1);
    expect(turns).toEqual([]);
    expect(consumedBytes).toBe(0);
  });

  // Multi-byte safety: consumedBytes is a BYTE offset, and the caller seeks by
  // bytes. A character count would desync the offset on any non-ASCII prompt.
  it('counts consumedBytes in bytes, not characters', () => {
    const line = JSON.stringify({
      type: 'user', promptId: 'p', uuid: 'u',
      timestamp: '2026-07-26T18:04:11.000Z',
      message: { role: 'user', content: 'héllo wörld — em dash' },
    }) + '\n';
    const { consumedBytes } = extractCcUserTurns(line, 'c', 1);
    expect(consumedBytes).toBe(Buffer.byteLength(line, 'utf8'));
    expect(consumedBytes).toBeGreaterThan(line.length);
  });
});

describe('extractNativeUserTurns', () => {
  const header = () => JSON.stringify({
    v: 1, sessionId: 's1', harnessId: 'assistant',
    binding: { providerId: 'openrouter', modelId: 'qwen/qwen3.8-max' },
    cwd: '/home/destin/youcoded-dev', createdAt: 1785990907536,
  });

  const userMsg = (text: string, ts = 1785990913428) => JSON.stringify({
    type: 'user-message', sessionId: 's1', uuid: 'u1', timestamp: ts, data: { text },
  });

  const assistantMsg = () => JSON.stringify({
    type: 'assistant-text', sessionId: 's1', uuid: 'u2', timestamp: 1785990914000,
    data: { text: 'assistant reply' },
  });

  it('skips the header line at the start of the file', () => {
    const chunk = [header(), userMsg('echo something')].join('\n') + '\n';
    const { turns } = extractNativeUserTurns(chunk, 'conv-n', 1, true);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toEqual({
      conversationId: 'conv-n',
      turn: 1,
      ts: '2026-08-06T04:35:13.428Z',
      text: 'echo something',
    });
  });

  // Mid-file resume: byte offset is past the header, so nothing may be dropped.
  it('does not skip a line when resuming mid-file', () => {
    const chunk = userMsg('resumed message') + '\n';
    const { turns } = extractNativeUserTurns(chunk, 'conv-n', 5, false);
    expect(turns).toHaveLength(1);
    expect(turns[0].turn).toBe(5);
  });

  it('indexes only user-message events', () => {
    const chunk = [userMsg('mine'), assistantMsg()].join('\n') + '\n';
    const { turns } = extractNativeUserTurns(chunk, 'c', 1, false);
    expect(turns.map((t) => t.text)).toEqual(['mine']);
  });

  it('skips a user-message with no text', () => {
    const chunk = JSON.stringify({ type: 'user-message', uuid: 'u', timestamp: 1, data: {} }) + '\n';
    const { turns } = extractNativeUserTurns(chunk, 'c', 1, false);
    expect(turns).toEqual([]);
  });

  it('applies the same <-wrapped skip as the CC lane', () => {
    const chunk = userMsg('<system-reminder>x</system-reminder>') + '\n';
    const { turns } = extractNativeUserTurns(chunk, 'c', 1, false);
    expect(turns).toEqual([]);
  });

  it('reports consumedBytes up to the last complete line', () => {
    const complete = userMsg('done') + '\n';
    const { consumedBytes } = extractNativeUserTurns(complete + '{"type":"user-mess', 'c', 1, false);
    expect(consumedBytes).toBe(Buffer.byteLength(complete, 'utf8'));
  });
});
