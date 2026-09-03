import { describe, it, expect } from 'vitest';
import { sessionRuntimeLabel } from '../src/renderer/components/header/session-runtime-label';

// The line under a session's name in the All Sessions menu. It replaced the
// pill's "YouCoded · Coder" badge on 2026-09-02, so this is now the ONLY
// place a session's runtime is named.
describe('sessionRuntimeLabel', () => {
  it('names Claude Code and the model class, with the Claude Code mark', () => {
    expect(sessionRuntimeLabel({ provider: 'claude', model: 'sonnet' })).toMatchObject({
      runtime: 'Claude Code', model: 'Sonnet', text: 'Claude Code · Sonnet', icon: 'claudecode', color: 'var(--brand-claude)',
    });
    expect(sessionRuntimeLabel({ provider: 'claude', model: 'claude-opus-5' }).text).toBe('Claude Code · Opus');
    expect(sessionRuntimeLabel({ provider: 'claude', model: 'fable' }).text).toBe('Claude Code · Fable');
  });

  it('treats a missing provider as Claude Code — the default runtime', () => {
    expect(sessionRuntimeLabel({ model: 'haiku' }).text).toBe('Claude Code · Haiku');
  });

  it('shows the runtime alone when the model is missing or unrecognised — never a guess', () => {
    expect(sessionRuntimeLabel({ provider: 'claude' })).toMatchObject({ model: null, text: 'Claude Code' });
    expect(sessionRuntimeLabel({ provider: 'claude', model: 'something-else' }).text).toBe('Claude Code');
    expect(sessionRuntimeLabel({ provider: 'native', harnessId: 'coder' }).text).toBe('YouCoded Coder');
  });

  it('names the native preset and the model, with the brand mark the status bar chip uses', () => {
    expect(sessionRuntimeLabel({ provider: 'native', harnessId: 'coder', model: 'deepseek/deepseek-r1' })).toMatchObject({
      runtime: 'YouCoded Coder', model: 'Deepseek R1', text: 'YouCoded Coder · Deepseek R1', icon: 'deepseek',   // nativeModelLabel's casing, same as the status bar chip
    });
    expect(sessionRuntimeLabel({ provider: 'native', harnessId: 'assistant', model: 'x-ai/grok-3' })).toMatchObject({
      text: 'YouCoded Assistant · Grok 3', icon: 'grok',
    });
    // A stored 'chat' header resolves to 'assistant' upstream; anything that is
    // not 'coder' reads as the Assistant here too.
    expect(sessionRuntimeLabel({ provider: 'native', model: 'openai/gpt-5.6' }).text).toBe('YouCoded Assistant · GPT 5.6');
  });

  it('cleans a local weight file down to its model name', () => {
    const l = sessionRuntimeLabel({ provider: 'native', harnessId: 'assistant', model: 'DeepSeek-R1-Distill-Qwen-14B-Q4_K_M.gguf' });
    expect(l.model).not.toMatch(/gguf|Q4_K_M/);
    expect(l.text.startsWith('YouCoded Assistant · ')).toBe(true);
  });

  it('falls back to the unbranded chip colour with no mark for a model no brand rule knows', () => {
    expect(sessionRuntimeLabel({ provider: 'native', harnessId: 'coder', model: 'acme/widget-7b' })).toMatchObject({
      icon: undefined, color: 'var(--tag-blue)',
    });
  });
});
