import { describe, it, expect } from 'vitest';
import { messageTokens, messagesTokens, IMAGE_PART_TOKEN_ESTIMATE } from '../src/main/harness/message-size';
import { estimateTokens } from '../src/main/harness/compaction';

describe('message-size', () => {
  it('sizes a plain-string message at chars/4', () => {
    expect(messageTokens({ role: 'user', content: 'a'.repeat(400) } as any)).toBe(100);
  });

  it('charges a flat estimate for a binary part, not stringified bytes', () => {
    // The #290 bug: JSON.stringify(Buffer) is ~4-5 chars/byte, so 1 MB looked
    // like ~1.1M tokens and fitToContext evicted the entire prior conversation.
    const oneMb = Buffer.alloc(1024 * 1024, 0x89);
    const msg = { role: 'user', content: [{ type: 'text', text: 'see attached' }, { type: 'file', mediaType: 'image/png', data: oneMb }] } as any;
    const tokens = messageTokens(msg);
    expect(tokens).toBeGreaterThanOrEqual(IMAGE_PART_TOKEN_ESTIMATE);
    expect(tokens).toBeLessThan(IMAGE_PART_TOKEN_ESTIMATE + 100);
  });

  it('charges the flat estimate for a Buffer nested in a content-type tool output', () => {
    const msg = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'Read', output: { type: 'content', value: [{ type: 'text', text: 'Read image x.png' }, { type: 'file', mediaType: 'image/png', data: { type: 'data', data: Buffer.alloc(500_000) } }] } }] } as any;
    expect(messageTokens(msg)).toBeLessThan(IMAGE_PART_TOKEN_ESTIMATE + 200);
  });

  it('sums across messages', () => {
    const msgs = [{ role: 'user', content: 'a'.repeat(40) }, { role: 'user', content: 'b'.repeat(40) }] as any;
    expect(messagesTokens(msgs)).toBe(messageTokens(msgs[0]) + messageTokens(msgs[1]));
  });
});

describe('sizing regression (#290 image-turn eviction)', () => {
  it('a history with one attached image does not dwarf the text history', () => {
    const history = [
      { role: 'user', content: 'question one' },
      { role: 'assistant', content: 'answer one' },
      { role: 'user', content: [{ type: 'text', text: 'see screenshot' }, { type: 'file', mediaType: 'image/png', data: Buffer.alloc(1024 * 1024) }] },
    ] as any;
    // Before the fix this was ~1.1M tokens; a 32k budget kept ONLY the image
    // message and silently dropped the rest of the conversation.
    expect(estimateTokens(history)).toBeLessThan(3_000);
  });
});
