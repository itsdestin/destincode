// Per-provider image adaptation, at REQUEST-BUILD time (2026-08-11 spec).
//
// Canonical history keeps images where they factually belong — inside the tool
// result that fetched them, or the user message that attached them. But only
// the direct-Anthropic wire can carry an image inside a tool result;
// @ai-sdk/openai-compatible JSON.stringifies a content-type output into a wall
// of base64 the model hallucinates over (Cline documents this exact failure in
// its split-tool-images middleware, which this module mirrors). So every
// request adapts a COPY of the canonical view:
//   - nativeImageToolResults (Anthropic): pass through.
//   - otherwise: tool output becomes plain text with a forward-pointing
//     placeholder, and a SYNTHETIC user message carrying the image is inserted
//     immediately AFTER the complete tool message (the position
//     injectPathTriggers already proves safe on every provider).
//   - a non-vision model (e.g. mid-session swap to a local model): every image
//     part anywhere becomes a named text placeholder — pixels are NEVER sent.
// Synthetic messages exist only in the outgoing request: never pushed to
// history, never persisted, never rendered. Re-checked EVERY request, which is
// what closes the swap-time leak a push-time gate cannot.
import type { ModelMessage } from 'ai';

export interface WireImageCaps { nativeImageToolResults: boolean; supportsVision: boolean }

const OMITTED_TEXT = '[image omitted: this model cannot view images]';
// Forward-pointing on purpose: classic Cline found "(see the following user
// message...)" measurably outperforms unexplained placeholder text.
const FORWARD_TEXT = '(the image could not be embedded here — it is attached in the next message, sent on your behalf)';
const PROVENANCE_TEXT = 'Attached below: the image from the tool result above, delivered automatically because this provider cannot carry images inside tool results. This is not a message the user typed.';

type AnyPart = { type: string; [k: string]: unknown };

function hasImageParts(m: ModelMessage): boolean {
  const c = (m as { content: unknown }).content;
  if (!Array.isArray(c)) return false;
  return (c as AnyPart[]).some((p) =>
    p?.type === 'file'
    || (p?.type === 'tool-result' && (p as any).output?.type === 'content'));
}

export function adaptForWire(messages: ModelMessage[], caps: WireImageCaps): ModelMessage[] {
  // Fast path: an image-free history is returned as-is (byte-identical — the
  // no-image pipeline must not change shape at all).
  if (!messages.some(hasImageParts)) return messages;

  const out: ModelMessage[] = [];
  for (const m of messages) {
    const content = (m as { content: unknown }).content;
    if (m.role === 'user' && Array.isArray(content)) {
      out.push(caps.supportsVision ? m : ({
        role: 'user',
        content: (content as AnyPart[]).map((p) => (p?.type === 'file' ? { type: 'text', text: OMITTED_TEXT } : p)),
      } as any));
      continue;
    }
    if (m.role !== 'tool' || !Array.isArray(content)) { out.push(m); continue; }

    const followUpImages: AnyPart[] = [];
    const newContent = (content as AnyPart[]).map((part) => {
      if (part?.type !== 'tool-result' || (part as any).output?.type !== 'content') return part;
      const value = (part as any).output.value as AnyPart[];
      const files = value.filter((v) => v?.type === 'file');
      const text = value.filter((v) => v?.type === 'text').map((v) => (v as any).text).join('\n');
      if (!files.length) return { ...part, output: { type: 'text', value: text } };
      if (!caps.supportsVision) return { ...part, output: { type: 'text', value: `${text}\n${OMITTED_TEXT}` } };
      if (caps.nativeImageToolResults) return part;
      followUpImages.push(...files);
      return { ...part, output: { type: 'text', value: `${text}\n${FORWARD_TEXT}` } };
    });
    out.push({ ...(m as object), content: newContent } as ModelMessage);
    if (followUpImages.length) {
      out.push({
        role: 'user',
        content: [
          { type: 'text', text: PROVENANCE_TEXT },
          // Tool-output file parts wrap data as {type:'data', data}; user-message
          // file parts take the bytes directly.
          ...followUpImages.map((f) => ({ type: 'file', mediaType: (f as any).mediaType, data: (f as any).data.data })),
        ],
      } as any);
    }
  }
  return out;
}
