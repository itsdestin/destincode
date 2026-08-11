import { describe, it, expect } from 'vitest';
import { adaptForWire } from '../src/main/harness/wire-adapter';

const img = (name: string) => ({ type: 'file', mediaType: 'image/png', data: { type: 'data', data: Buffer.from(name) } });
const imageToolMsg = {
  role: 'tool',
  content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'Read', output: { type: 'content', value: [{ type: 'text', text: 'Read image a.png' }, img('a')] } }],
} as any;
const textToolMsg = { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't2', toolName: 'Bash', output: { type: 'text', value: 'ok' } }] } as any;
const userImgMsg = { role: 'user', content: [{ type: 'text', text: 'see shot' }, { type: 'file', mediaType: 'image/png', data: Buffer.from('u') }] } as any;

describe('adaptForWire', () => {
  it('native path (Anthropic): passes everything through untouched', () => {
    const out = adaptForWire([userImgMsg, imageToolMsg, textToolMsg], { nativeImageToolResults: true, supportsVision: true });
    expect(out).toEqual([userImgMsg, imageToolMsg, textToolMsg]);
  });

  it('split path: text-only tool output + synthetic follow-up user message with the image', () => {
    const out = adaptForWire([imageToolMsg], { nativeImageToolResults: false, supportsVision: true });
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('tool');
    const output = (out[0] as any).content[0].output;
    expect(output.type).toBe('text');                       // openai-compatible must NEVER see 'content'
    expect(output.value).toContain('Read image a.png');
    expect(output.value).toContain('next message');          // forward-pointing placeholder (classic Cline)
    expect(out[1].role).toBe('user');
    const parts = (out[1] as any).content;
    expect(parts[0].type).toBe('text');                      // provenance framing, not a bare image
    expect(parts[1]).toEqual({ type: 'file', mediaType: 'image/png', data: Buffer.from('a') });
  });

  it('split path: a multi-result tool message inserts the synthetic message AFTER the whole tool message', () => {
    const both = { role: 'tool', content: [imageToolMsg.content[0], textToolMsg.content[0]] } as any;
    const out = adaptForWire([both], { nativeImageToolResults: false, supportsVision: true });
    expect(out.map((m) => m.role)).toEqual(['tool', 'user']);  // pairing invariant: tool message stays whole
  });

  it('non-vision model: every pixel is replaced by a named placeholder, nothing is sent', () => {
    const out = adaptForWire([userImgMsg, imageToolMsg], { nativeImageToolResults: true, supportsVision: false });
    const userParts = (out[0] as any).content;
    expect(userParts[1]).toEqual({ type: 'text', text: '[image omitted: this model cannot view images]' });
    const output = (out[1] as any).content[0].output;
    expect(output.type).toBe('text');
    expect(output.value).toContain('[image omitted');
    expect(JSON.stringify(out)).not.toContain('"data"');
  });

  it('image-free history is returned with zero changes (byte-identical fast path)', () => {
    const msgs = [{ role: 'user', content: 'hi' }, textToolMsg] as any;
    expect(adaptForWire(msgs, { nativeImageToolResults: false, supportsVision: false })).toEqual(msgs);
  });
});
