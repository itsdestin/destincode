import { describe, it, expect } from 'vitest';
import { planCompaction, pruneToolOutputs, estimateTokens, type CompactionConfig } from '../src/main/harness/compaction';
import type { ModelMessage } from 'ai';

const cfg: CompactionConfig = { contextLength: 8192, triggerRatio: 0.75, protectedTokens: 4000, minPruneSavings: 1000, pruneToChars: 2000 };
const toolMsg = (id: string, chars: number): ModelMessage => ({ role: 'tool', content: [{ type: 'tool-result', toolCallId: id, toolName: 'Read', output: { type: 'text', value: 'x'.repeat(chars) } }] } as any);
const userMsg = (t: string): ModelMessage => ({ role: 'user', content: t } as any);

describe('planCompaction', () => {
  it('none when last-step input is under the trigger', () => {
    expect(planCompaction([userMsg('hi')], cfg, 100).action).toBe('none');
  });
  it('prune when over trigger and pruning frees enough', () => {
    expect(planCompaction([toolMsg('a', 40_000), toolMsg('b', 40_000), userMsg('r')], cfg, 7000).action).toBe('prune');
  });
  it('summarize when even pruning cannot get under budget', () => {
    const history = Array.from({ length: 20 }, (_, i) => userMsg('y'.repeat(3000) + i));
    expect(planCompaction(history, cfg, 8000).action).toBe('summarize');
  });
});

describe('pruneToolOutputs', () => {
  it('truncates tool outputs OUTSIDE the protected window; protected ones untouched', () => {
    const pruned = pruneToolOutputs([toolMsg('old', 40_000), userMsg('mid'), toolMsg('recent', 40_000)], cfg);
    expect((pruned[0] as any).content[0].output.value.length).toBeLessThanOrEqual(cfg.pruneToChars + 128);
    expect((pruned[0] as any).content[0].output.value).toContain('[pruned');
    expect((pruned[2] as any).content[0].output.value.length).toBe(40_000);
  });
  it('never truncates a non-tool message', () => {
    expect((pruneToolOutputs([userMsg('u'.repeat(40_000))], cfg)[0] as any).content).toBe('u'.repeat(40_000));
  });
});
