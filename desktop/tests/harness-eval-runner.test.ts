import { describe, it, expect } from 'vitest';
import { runCase } from '../src/main/harness/eval/run-case';
import { BATTERY_PROMPT } from '../src/main/harness/eval/battery';
import { scriptModel } from './helpers/harness-fakes';

describe('runCase inputs', () => {
  it('sends the prompt it was given, not the battery prompt', async () => {
    const model = scriptModel([{ text: 'done' }]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'test/model', label: 'test',
      prompt: 'Just say done.',
      contextLength: 64_000,
    });
    const firstUser = run.events.find((e) => e.type === 'user-message');
    expect(firstUser?.data.text).toBe('Just say done.');
    expect(firstUser?.data.text).not.toContain('battery');
  });

  it('defaults to the battery prompt when none is given', async () => {
    const model = scriptModel([{ text: 'done' }]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'test/model', label: 'test',
      contextLength: 64_000,
    });
    expect(run.events.find((e) => e.type === 'user-message')?.data.text).toBe(BATTERY_PROMPT);
  });

  it('attaches only the tools it was given', async () => {
    const model = scriptModel([{ text: 'done' }]);
    const run = await runCase({
      modelFactory: async () => model as any,
      modelId: 'test/model', label: 'test',
      tools: [],
      contextLength: 64_000,
    });
    expect(run.metrics.toolsUsed).toEqual([]);
  });
});
