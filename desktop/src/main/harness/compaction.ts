// Two-stage compaction (spec §4.4). Stage 1 PRUNE erases old tool OUTPUTS outside a
// protected recent window (nearly lossless). Stage 2 SUMMARIZE (driver-owned) runs
// only if pruning can't get under budget. PURE here: the decision + the prune
// transform. Trigger is REAL last-step input tokens, not chars/4.
import type { ModelMessage } from 'ai';
import { messageTokens, messagesTokens } from './message-size';

export interface CompactionConfig {
  contextLength: number; triggerRatio: number; protectedTokens: number; minPruneSavings: number; pruneToChars: number;
}
const PRUNE_TRAILER = (n: number) => `\n\n[pruned — ${n} chars of tool output elided to fit context; re-run the tool if you need it again]`;

export function estimateTokens(messages: ModelMessage[]): number {
  return messagesTokens(messages);   // binary-aware (#290 follow-up fix 1)
}
// Returns the first index of the protected recent window: [cutoff, end] is kept
// verbatim, [0, cutoff) is eligible for pruning. We walk from the newest message
// backward, summing tokens, and stop once the budget is exceeded.
// WHY `return i` (not i+1): the message that pushes us over the budget must itself
// stay protected. Otherwise a single huge recent tool result (e.g. a 40k-char Read
// that alone blows past protectedTokens on the very first step) would fall OUTSIDE
// the window and get pruned — defeating the whole point of protecting recent context.
function protectedFrom(messages: ModelMessage[], protectedTokens: number): number {
  let acc = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    acc += messageTokens(messages[i]);   // binary-aware — see message-size.ts
    if (acc > protectedTokens) return i;
  }
  return 0;
}
// Only shrinks tool-result TEXT — never drops a message, so no tool-call loses its
// paired result (pairing invariant).
export function pruneToolOutputs(messages: ModelMessage[], cfg: CompactionConfig): ModelMessage[] {
  const cutoff = protectedFrom(messages, cfg.protectedTokens);
  return messages.map((m, i) => {
    if (i >= cutoff || (m as any).role !== 'tool' || !Array.isArray((m as any).content)) return m;
    const content = (m as any).content.map((part: any) => {
      if (part?.type !== 'tool-result') return part;
      const output = part.output;
      // AI SDK v7 'content' output (tool-delivered images: text + file parts).
      // Outside the protected window this collapses to its text plus a named
      // note — same rule as the string branch below. Without this branch,
      // stage-1 prune could only ever shrink STRING outputs, so an image sat
      // in the window unreclaimed until a full summarize silently destroyed
      // it (the exact silent-loss class this milestone exists to eliminate).
      if (output?.type === 'content' && Array.isArray(output.value)) {
        const text = output.value.filter((v: any) => v?.type === 'text').map((v: any) => v.text).join('\n');
        return { ...part, output: { type: 'text', value: `${text}\n[image pruned — re-run ${part.toolName ?? 'the tool'} if you need to see it again]` } };
      }
      const value = output?.value;
      if (typeof value !== 'string' || value.length <= cfg.pruneToChars) return part;
      return { ...part, output: { ...output, value: value.slice(0, cfg.pruneToChars) + PRUNE_TRAILER(value.length - cfg.pruneToChars) } };
    });
    return { ...(m as any), content };
  });
}
// Counts tool-result parts still carrying an unpruned 'content' (image)
// output. harness-session.ts diffs this before/after pruneToolOutputs to
// learn whether prune just collapsed an image — the ONLY signal it uses to
// decide whether the shownImages dedupe cache (which vouches for delivered
// images still being in history) needs clearing. Kept here rather than
// re-derived in harness-session.ts so the two files can't drift on what
// counts as an "image output".
export function countImageOutputs(messages: ModelMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if ((m as any).role !== 'tool' || !Array.isArray((m as any).content)) continue;
    for (const part of (m as any).content) {
      if (part?.type === 'tool-result' && part.output?.type === 'content') n++;
    }
  }
  return n;
}
export type CompactionAction = 'none' | 'prune' | 'summarize';
export function planCompaction(messages: ModelMessage[], cfg: CompactionConfig, lastInputTokens: number): { action: CompactionAction } {
  const used = lastInputTokens > 0 ? lastInputTokens : estimateTokens(messages);
  if (used <= cfg.contextLength * cfg.triggerRatio) return { action: 'none' };
  const before = estimateTokens(messages);
  const after = estimateTokens(pruneToolOutputs(messages, cfg));
  return before - after >= cfg.minPruneSavings ? { action: 'prune' } : { action: 'summarize' };
}
export function summarizePrompt(): string {
  return 'Summarize the conversation so far into a compact briefing that preserves: the user\'s goal, key decisions and constraints, files/commands touched and their outcomes, and any open questions. Write it as notes for yourself to continue. Do not include verbatim tool output.';
}
