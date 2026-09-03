import { describe, it, expect } from 'vitest';
import { matchesQuery } from '../src/shared/text-match';

// The bug that produced this file: the model picker showed "OpenAI: GPT-5.6
// Luna Pro" for the query "gpt", then "No models match." for "gpt 5.6".
const GPT = ['OpenAI: GPT-5.6 Luna Pro', 'OpenRouter'] as const;

describe('matchesQuery', () => {
  it('finds a punctuated name from a space-separated query', () => {
    expect(matchesQuery('gpt 5.6', ...GPT)).toBe(true);
    expect(matchesQuery('gpt 5', ...GPT)).toBe(true);
    expect(matchesQuery('gpt5', ...GPT)).toBe(false); // no such word — a miss is correct
  });

  it('still matches the punctuation the user typed', () => {
    expect(matchesQuery('gpt-5.6', ...GPT)).toBe(true);
    expect(matchesQuery('gpt', ...GPT)).toBe(true);
  });

  it('matches a hyphenated query against a spaced name', () => {
    expect(matchesQuery('luna-pro', ...GPT)).toBe(true);
  });

  it('ignores word order and spans fields', () => {
    expect(matchesQuery('pro luna', ...GPT)).toBe(true);
    expect(matchesQuery('luna openrouter', ...GPT)).toBe(true);
  });

  it('requires every word — a wrong word still excludes the row', () => {
    expect(matchesQuery('gpt claude', ...GPT)).toBe(false);
    expect(matchesQuery('gpt 4', ...GPT)).toBe(false); // this row only; GPT-4 has its own, below
  });

  it('finds the OTHER GPT rows the same query names', () => {
    expect(matchesQuery('gpt 4', 'OpenAI: GPT-4', 'OpenRouter')).toBe(true);
    expect(matchesQuery('gpt 4', 'OpenAI: GPT-4o mini', 'OpenRouter')).toBe(true);
    expect(matchesQuery('gpt 4', 'Anthropic: Claude Opus 4', 'OpenRouter')).toBe(false);
  });

  it('is case-insensitive and tolerates extra whitespace', () => {
    expect(matchesQuery('  GPT   Luna ', ...GPT)).toBe(true);
  });

  it('matches everything on a blank query', () => {
    expect(matchesQuery('', ...GPT)).toBe(true);
    expect(matchesQuery('   ', ...GPT)).toBe(true);
  });

  it('tolerates absent fields', () => {
    expect(matchesQuery('qwen', 'qwen3-30b-a3b', null, undefined)).toBe(true);
    expect(matchesQuery('qwen 30b', 'qwen3-30b-a3b', null)).toBe(true);
  });
});
