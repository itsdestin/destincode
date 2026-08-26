import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendChatMessage } from '../src/renderer/components/native-send';
import { buildOutgoingMessage } from '../src/renderer/components/outgoing-message';

describe('sendChatMessage', () => {
  beforeEach(() => {
    (globalThis as any).window = { claude: { native: { send: vi.fn() }, session: { sendInput: vi.fn() } } };
  });

  it('routes native to native:send with NO trailing \\r, filepaths prefixed', () => {
    sendChatMessage('native', 's1', 'hello world', ['C:/a b.txt']);
    // The paths are prefixed into the TEXT (dedup key) AND passed separately as
    // attachments, so main can turn image ones into image parts on the user
    // message. Both halves are asserted: dropping either is a real regression —
    // losing the text breaks the optimistic bubble, losing the third argument
    // silently reverts native sessions to path-only, which is the bug this
    // shipped to fix.
    expect((window as any).claude.native.send).toHaveBeenCalledWith('s1', 'C:/a b.txt hello world', ['C:/a b.txt']);
    expect((window as any).claude.session.sendInput).not.toHaveBeenCalled();
  });

  it('routes claude/undefined to the PTY with \\r', () => {
    sendChatMessage('claude', 's1', 'hi');
    expect((window as any).claude.session.sendInput).toHaveBeenCalledWith('s1', 'hi\r');
    sendChatMessage(undefined, 's2', 'yo');
    expect((window as any).claude.session.sendInput).toHaveBeenCalledWith('s2', 'yo\r');
  });

  // The load-bearing dedup guarantee: the string sent to the native harness must
  // EXACTLY equal the optimistic bubble content, or the bubble stays pending
  // forever. buildOutgoingMessage.content and the helper's native join must
  // agree for the same (raw text, filePaths) pair.
  it('native send text equals buildOutgoingMessage(...).content', () => {
    const cases: Array<[string, string[]]> = [
      ['hello world', []],
      ['see this', ['C:/tmp/a.png', 'C:/tmp/b.png']],
      ['line one\nline two', ['C:/a b.txt']],
      ['', ['C:/only-a-file.txt']],
    ];
    for (const [raw, paths] of cases) {
      const out = buildOutgoingMessage(raw, paths);
      expect(out).not.toBeNull();
      const send = vi.fn();
      (globalThis as any).window = { claude: { native: { send }, session: { sendInput: vi.fn() } } };
      sendChatMessage('native', 's1', out!.ptyText, paths);
      // The TEXT must still equal the bubble content exactly; attachments ride
      // beside it and must never be folded into or removed from that string.
      expect(send).toHaveBeenCalledWith('s1', out!.content, paths);
    }
  });
});
