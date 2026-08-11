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

  it('native path: a content-type output with only text parts passes through byte-identical (the part itself, not just structurally)', () => {
    const textOnlyContentMsg = {
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: 't3', toolName: 'Read', output: { type: 'content', value: [{ type: 'text', text: 'no images here' }] } }],
    } as any;
    const out = adaptForWire([imageToolMsg, textOnlyContentMsg], { nativeImageToolResults: true, supportsVision: true });
    // Reordered guard: native pass-through runs before the no-files flatten,
    // so a content output with zero file parts is NOT rewritten to text on
    // the wire that could carry 'content' output natively.
    expect((out[1] as any).content[0]).toBe(textOnlyContentMsg.content[0]);
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
    expect(parts[1]).toEqual({ type: 'text', text: 'Image: Read' }); // per-image label (filename absent, falls back to toolName)
    expect(parts[2]).toEqual({ type: 'file', mediaType: 'image/png', data: Buffer.from('a') });
  });

  it('split path: a multi-result tool message inserts the synthetic message AFTER the whole tool message', () => {
    const both = { role: 'tool', content: [imageToolMsg.content[0], textToolMsg.content[0]] } as any;
    const out = adaptForWire([both], { nativeImageToolResults: false, supportsVision: true });
    expect(out.map((m) => m.role)).toEqual(['tool', 'user']);  // pairing invariant: tool message stays whole
  });

  it('split path: two image-bearing tool-results in one tool message label and carry both images, in order', () => {
    const secondImageResult = { type: 'tool-result', toolCallId: 't4', toolName: 'Bash', output: { type: 'content', value: [{ type: 'text', text: 'screenshot taken' }, img('b')] } };
    const both = { role: 'tool', content: [imageToolMsg.content[0], secondImageResult] } as any;
    const out = adaptForWire([both], { nativeImageToolResults: false, supportsVision: true });
    expect(out).toHaveLength(2);
    const parts = (out[1] as any).content;
    // provenance text + (label, file) pair per image, in source order
    expect(parts[0].type).toBe('text');
    expect(parts[1]).toEqual({ type: 'text', text: 'Image: Read' });
    expect(parts[2]).toEqual({ type: 'file', mediaType: 'image/png', data: Buffer.from('a') });
    expect(parts[3]).toEqual({ type: 'text', text: 'Image: Bash' });
    expect(parts[4]).toEqual({ type: 'file', mediaType: 'image/png', data: Buffer.from('b') });
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

  it('non-vision model: an image part on a non-user, non-tool role (e.g. assistant) is also stripped, not passed through', () => {
    const assistantImgMsg = { role: 'assistant', content: [{ type: 'text', text: 'here' }, { type: 'file', mediaType: 'image/png', data: Buffer.from('u') }] } as any;
    const out = adaptForWire([assistantImgMsg], { nativeImageToolResults: true, supportsVision: false });
    expect((out[0] as any).content[1]).toEqual({ type: 'text', text: '[image omitted: this model cannot view images]' });
    expect(JSON.stringify(out)).not.toContain('"data"');
  });

  it('image-free history is returned with zero changes (byte-identical fast path)', () => {
    const msgs = [{ role: 'user', content: 'hi' }, textToolMsg] as any;
    expect(adaptForWire(msgs, { nativeImageToolResults: false, supportsVision: false })).toBe(msgs);
  });
});
