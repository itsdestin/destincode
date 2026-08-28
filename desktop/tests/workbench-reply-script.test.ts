import { describe, it, expect, vi } from 'vitest';
import { playReply, resolvePermission, parseReplyScript } from '../src/renderer/dev/workbench/reply-script';

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
    // user echo, streamed text (3 words → 3 chunks, one partId), tool-use, tool-result
    expect(transcript[0]).toMatchObject({ type: 'user-message', sessionId: 's1', data: { text: 'turn these into a spreadsheet' } });
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
});
