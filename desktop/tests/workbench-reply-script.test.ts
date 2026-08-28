import { describe, it, expect, vi } from 'vitest';
import { playReply, resolvePermission, parseReplyScript, splitTurns, isControl } from '../src/renderer/dev/workbench/reply-script';

const SCRIPT = [
  '{"type":"assistant_text","text":"Reading them now.","delay":10}',
  '{"type":"tool_use","id":"r1","name":"Read","input":{"file_path":"a.jpg"},"delay":10}',
  '{"type":"tool_result","tool_use_id":"r1","content":"[image]","delay":10}',
  '{"type":"permission_request","id":"p1","name":"Write","input":{"file_path":"out.xlsx"},"delay":10}',
  '{"type":"tool_result","tool_use_id":"p1","content":"Wrote out.xlsx","delay":10}',
  '{"type":"turn_complete","delay":10}',
].join('\n');

describe('reply-script', () => {
  it('parses one event per line and ignores blanks', () => {
    expect(parseReplyScript(SCRIPT + '\n\n').length).toBe(6);
  });

  it('plays transcript + hook events in order and pauses on a permission ask', async () => {
    vi.useFakeTimers();
    const transcript: any[] = []; const hooks: any[] = [];
    const done = playReply('s1', 'turn these into a spreadsheet', parseReplyScript(SCRIPT), {
      transcript: (e) => transcript.push(e), hook: (e) => hooks.push(e), cps: 1000,
    });
    await vi.advanceTimersByTimeAsync(200);
    // No user echo — the app renders the user's bubble itself. Streamed text
    // (3 words → 3 chunks, one partId), tool-use, tool-result.
    expect(transcript.some((e) => e.type === 'user-message')).toBe(false);
    expect(transcript[0]).toMatchObject({ type: 'assistant-text' });
    const chunks = transcript.filter((e) => e.type === 'assistant-text');
    expect(chunks.length).toBe(3);
    expect(new Set(chunks.map((c) => c.data.partId)).size).toBe(1);
    expect(transcript.find((e) => e.type === 'tool-use')).toMatchObject({ data: { toolUseId: 'r1', toolName: 'Read' } });
    expect(hooks[0]).toMatchObject({ type: 'PermissionRequest', sessionId: 's1', payload: { tool_name: 'Write', _requestId: 'p1', permissionMode: 'ask' } });
    // paused: the tool-result after the ask has NOT been emitted yet
    expect(transcript.some((e) => e.type === 'tool-result' && e.data.toolUseId === 'p1')).toBe(false);
    resolvePermission('p1');
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(transcript.some((e) => e.type === 'tool-result' && e.data.toolUseId === 'p1')).toBe(true);
    expect(transcript.at(-1)).toMatchObject({ type: 'turn-complete' });
    vi.useRealTimers();
  });

  it('ignores control input (PTY escapes) so a Claude Code session does not trigger a script', async () => {
    const transcript: any[] = [];
    await playReply('s1', '\x1b', parseReplyScript(SCRIPT), { transcript: (e) => transcript.push(e), hook: () => {} });
    expect(transcript.length).toBe(0);
  });

  // A typo in a fixture's `type` field used to fall through the switch with no
  // default and vanish silently — the beat just never played, with nothing in
  // the console pointing at why. It must warn loudly instead of being dropped.
  it('warns once and keeps playing when a line has an unknown type', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const transcript: any[] = [];
    const script = parseReplyScript('{"type":"bogus","delay":10}\n{"type":"turn_complete","delay":10}');
    const done = playReply('s1', 'hello', script, { transcript: (e) => transcript.push(e), hook: () => {} });
    await vi.advanceTimersByTimeAsync(200);
    await done;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('unknown line type "bogus"');
    expect(transcript.at(-1)).toMatchObject({ type: 'turn-complete' });
    warn.mockRestore();
    vi.useRealTimers();
  });
});

describe('splitTurns (multi-turn fixtures)', () => {
  const text = (t: string) => ({ type: 'assistant_text' as const, text: t });
  const end = { type: 'turn_complete' as const };
  it('splits on turn_complete and drops a trailing empty turn', () => {
    const turns = splitTurns([text('a'), end, text('b'), end]);
    expect(turns).toHaveLength(2);
    expect(turns[1]).toEqual([text('b'), end]);
  });
  it('keeps a fixture with no turn_complete as one turn (pre-turn fixtures behave as before)', () => {
    expect(splitTurns([text('a'), text('b')])).toEqual([[text('a'), text('b')]]);
  });
  it('the cursor wraps: message N plays turn N mod turns', () => {
    const turns = splitTurns([text('a'), end, text('b'), end]);
    expect(turns[2 % turns.length][0]).toEqual(text('a'));
  });
  it('isControl rejects the PTY control bytes and blanks that must not advance the cursor', () => {
    for (const c of ['\r', '\x1b', '\x1b[Z', '', '   ']) expect(isControl(c)).toBe(true);
    expect(isControl('hello')).toBe(false);
  });
});
