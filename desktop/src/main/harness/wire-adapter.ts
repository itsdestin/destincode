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
//     part in ANY message — not just user/tool — becomes a named text
//     placeholder — pixels are NEVER sent.
// Synthetic messages exist only in the outgoing request: never pushed to
// history, never persisted, never rendered. Re-checked EVERY request, which is
// what closes the swap-time leak a push-time gate cannot.
import type { ModelMessage } from 'ai';

export interface WireImageCaps { nativeImageToolResults: boolean; supportsVision: boolean }

const OMITTED_TEXT = '[image omitted: this model cannot view images]';
// Forward-pointing on purpose: classic Cline found "(see the following user
// message...)" measurably outperforms unexplained placeholder text. Worded to
// stay accurate whether one image or several came out of this tool result.
const forwardText = (n: number) =>
  `(${n === 1 ? 'the image' : `${n} images`} could not be embedded here — attached in the next message, sent on your behalf)`;
// "(s)" is deliberate, not lazy: this frames a synthetic message that may
// follow one tool-result with one image, or several tool-results each
// contributing images, and the wording must stay true in both cases.
const provenanceText = (n: number) =>
  `Attached below: ${n === 1 ? 'the image' : `the ${n} images`} from the tool result(s) above, delivered automatically because this provider cannot carry images inside tool results. This is not a message the user typed.`;

type AnyPart = { type: string; [k: string]: unknown };

// A tool-output file part's `data` is this tagged union (see
// @ai-sdk/provider-utils' FileData, node_modules/@ai-sdk/provider-utils/dist/index.d.ts
// ~L111-139). @ai-sdk/provider-utils is only a transitive dependency here
// (not in package.json) and 'ai' doesn't re-export the type itself, so the
// shape is redeclared narrowly rather than importing from an undeclared
// package — this is the type that made the Fix-1 bug (`.data.data` on a
// non-'data' variant) a silent `undefined` instead of a compile error.
type ToolResultFileData =
  | { type: 'data'; data: string | Uint8Array | ArrayBuffer | Buffer }
  | { type: 'url'; url: URL }
  | { type: 'reference'; reference: Record<string, unknown> }
  | { type: 'text'; text: string };

interface ToolResultFilePart {
  type: 'file';
  data: ToolResultFileData;
  mediaType: string;
  filename?: string;
  providerOptions?: Record<string, unknown>;
}

interface ToolResultLikePart extends AnyPart {
  type: 'tool-result';
  toolName?: string;
  output?: { type: string; value?: AnyPart[]; providerOptions?: Record<string, unknown> };
}

function hasImageParts(m: ModelMessage): boolean {
  const c = (m as { content: unknown }).content;
  if (!Array.isArray(c)) return false;
  return (c as AnyPart[]).some((p) =>
    p?.type === 'file'
    || (p?.type === 'tool-result' && (p as ToolResultLikePart).output?.type === 'content'));
}

export function adaptForWire(messages: ModelMessage[], caps: WireImageCaps): ModelMessage[] {
  // Fast path: an image-free history is returned as-is (byte-identical — the
  // no-image pipeline must not change shape at all). Returning the SAME
  // array reference (not a structurally-equal copy) matters: it's what makes
  // deleting this early return a test failure rather than a silent no-op.
  if (!messages.some(hasImageParts)) return messages;

  const out: ModelMessage[] = [];
  for (const m of messages) {
    const content = (m as { content: unknown }).content;

    if (m.role === 'tool' && Array.isArray(content)) {
      const followUpParts: AnyPart[] = [];
      const newContent = (content as ToolResultLikePart[]).map((part) => {
        if (part?.type !== 'tool-result' || part.output?.type !== 'content') return part;
        const output = part.output;
        const files: ToolResultFilePart[] = [];
        const textSegments: string[] = [];
        // Single pass over `value` (instead of two independent .filter()
        // calls) so text-segment order is derived directly from source
        // order rather than two lists that only coincidentally agreed.
        for (const v of output.value ?? []) {
          if (v?.type === 'file') files.push(v as unknown as ToolResultFilePart);
          else if (v?.type === 'text') textSegments.push((v as unknown as { text: string }).text);
        }
        const text = textSegments.join('\n');
        const textOutput = (value: string) => ({
          type: 'text' as const,
          value,
          // Carry the content-output's own providerOptions through instead of
          // silently dropping them when flattening to text.
          ...(output.providerOptions ? { providerOptions: output.providerOptions } : {}),
        });

        // Order is load-bearing:
        // 1. non-vision strip MUST come first — a non-vision model on the
        //    native Anthropic wire still must never see pixels.
        // 2. native pass-through MUST come before the no-files flatten, or a
        //    content output with zero file parts gets needlessly rewritten
        //    to text even on the wire that could carry it untouched.
        // 3. no-files flatten.
        // 4. otherwise: split image(s) into a synthetic follow-up message.
        if (!caps.supportsVision) return { ...part, output: textOutput(files.length ? `${text}\n${OMITTED_TEXT}` : text) };
        if (caps.nativeImageToolResults) return part;
        if (!files.length) return { ...part, output: textOutput(text) };

        const toolName = part.toolName ?? 'tool result';
        for (const f of files) {
          // Label each image with what it is so a multi-image turn doesn't
          // hand the model several unlabeled pictures it can't map back to
          // the file/tool that produced them.
          followUpParts.push({ type: 'text', text: `Image: ${f.filename ?? toolName}` });
          // Tool-output file parts wrap bytes as the tagged {type:'data',
          // data} form; a user-message file part takes the bytes directly,
          // so unwrap that ONE variant. Every other FileData variant
          // (url/reference/text) is passed through untouched — reaching
          // into `.data.data` on those yielded undefined, i.e. a
          // payload-less file part silently sent to the provider.
          followUpParts.push({ ...f, data: f.data?.type === 'data' ? f.data.data : f.data });
        }
        return { ...part, output: textOutput(`${text}\n${forwardText(files.length)}`) };
      });
      out.push({ ...(m as object), content: newContent } as ModelMessage);
      if (followUpParts.length) {
        const imageCount = followUpParts.filter((p) => p.type === 'file').length;
        // `as any`: the synthetic message's content mixes label/file AnyParts
        // that don't structurally match ModelMessage's strict UserContent
        // union (TextPart | ImagePart | FilePart) — fully typing this fights
        // the SDK's discriminated unions for no safety gain, since the shape
        // is hand-built here, not read from an external source.
        out.push({
          role: 'user',
          content: [{ type: 'text', text: provenanceText(imageCount) }, ...followUpParts],
        } as any);
      }
      continue;
    }

    if (!caps.supportsVision && Array.isArray(content)) {
      // Non-vision protection for every OTHER role with array content — not
      // role-scoped to 'user'. WHY: hasImageParts() above checks EVERY role
      // to decide whether to take the slow path at all, so a role this loop
      // didn't otherwise rewrite (e.g. an assistant message carrying a file
      // part) would reach the provider with real pixels intact. Not leaking
      // pixels to a model that can't see is this module's entire purpose.
      out.push({
        ...(m as object),
        content: (content as AnyPart[]).map((p) => (p?.type === 'file' ? { type: 'text', text: OMITTED_TEXT } : p)),
      } as ModelMessage);
      continue;
    }

    out.push(m);
  }
  return out;
}
