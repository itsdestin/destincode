// Model-tier step budget for the native runtime's "Continue?" gate. Frontier
// families get a higher ceiling; unknown/less-capable models keep the safe
// default. Matched against raw provider modelIds (OpenRouter's "vendor/model"
// form included). ROADMAP: fold into the per-model CapabilityProfile.
import { describe, it, expect } from 'vitest';
import { stepBudgetFor, FRONTIER_STEP_BUDGET, DEFAULT_STEP_BUDGET } from '../src/main/harness/model-step-budget';

describe('stepBudgetFor', () => {
  it('grants the frontier budget to known frontier families', () => {
    const frontier = [
      'anthropic/claude-opus-4-8',
      'claude-opus-4-8[1m]',
      'claude-fable-5',
      'openai/chatgpt-luna',
      'openai/chatgpt-terra',
      'chatgpt-sol',
      'moonshotai/kimi-k3',
      'kimi k3',
      'minimax/minimax-3',
      'x-ai/grok-4.5',
    ];
    for (const id of frontier) {
      expect(stepBudgetFor(id), id).toBe(FRONTIER_STEP_BUDGET);
    }
    expect(FRONTIER_STEP_BUDGET).toBe(50);
  });

  it('falls back to the conservative default for unknown / weaker models', () => {
    const others = [
      'meta-llama/llama-3-8b',
      'mistralai/mistral-7b',
      'google/gemma-2-9b',
      'qwen/qwen-2.5-7b',
      'anthropic/claude-haiku-4-5', // capable, but not on the long-run frontier list
      '',
    ];
    for (const id of others) {
      expect(stepBudgetFor(id), id).toBe(DEFAULT_STEP_BUDGET);
    }
    expect(DEFAULT_STEP_BUDGET).toBe(25);
  });

  it('handles an undefined modelId with the default (never throws)', () => {
    expect(stepBudgetFor(undefined)).toBe(DEFAULT_STEP_BUDGET);
  });

  it('matches a family regardless of point version (grok-4.5 variants)', () => {
    expect(stepBudgetFor('x-ai/grok-4.5-fast')).toBe(FRONTIER_STEP_BUDGET);
  });
});
