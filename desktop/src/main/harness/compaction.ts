// Two-stage compaction (spec §4.4). Stage 1 PRUNE erases old tool OUTPUTS outside a
// protected recent window (nearly lossless). Stage 2 SUMMARIZE (driver-owned) runs
// only if pruning can't get under budget. PURE here: the decision + the prune
// transform. Trigger is REAL last-step input tokens, not chars/4.
import type { ModelMessage } from 'ai';

export interface CompactionConfig {
  contextLength: number; triggerRatio: number; protectedTokens: number; minPruneSavings: number; pruneToChars: number;
}
const APPROX_CHARS_PER_TOKEN = 4;
const PRUNE_TRAILER = (n: number) => `\n\n[pruned — ${n} chars of tool output elided to fit context; re-run the tool if you need it again]`;

export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0; for (const m of messages) chars += JSON.stringify((m as any).content).length;
  return Math.ceil(chars / APPROX_CHARS_PER_TOKEN);
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
    acc += Math.ceil(JSON.stringify((messages[i] as any).content).length / APPROX_CHARS_PER_TOKEN);
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
      const value = part.output?.value;
      if (typeof value !== 'string' || value.length <= cfg.pruneToChars) return part;
      return { ...part, output: { ...part.output, value: value.slice(0, cfg.pruneToChars) + PRUNE_TRAILER(value.length - cfg.pruneToChars) } };
    });
    return { ...(m as any), content };
  });
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
