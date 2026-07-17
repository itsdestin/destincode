import { describe, it, expect } from 'vitest';
import { resolvePreset } from '../src/main/harness/preset-registry';

describe('resolvePreset', () => {
  it('resolves coder with auto-edit default mode and the coder body', () => {
    const p = resolvePreset('coder');
    expect(p.manifest.id).toBe('coder');
    expect(p.defaultMode).toBe('auto-edit');
    expect(p.body.toLowerCase()).toContain('todo');   // coder body mentions the todo plan
    expect(p.presetRules).toEqual([]);
  });
  it('resolves assistant with ask default mode', () => {
    const p = resolvePreset('assistant');
    expect(p.defaultMode).toBe('ask');
    expect(p.body).toMatch(/WebSearch/);
  });
  it("maps legacy 'chat' AND unknown/undefined ids to assistant", () => {
    expect(resolvePreset('chat').manifest.id).toBe('assistant');
    expect(resolvePreset(undefined).manifest.id).toBe('assistant');
    expect(resolvePreset('bogus-future-id').manifest.id).toBe('assistant');
  });
  it('maps a Record permissionPolicy to presetRules (Phase 3 shape)', () => {
    const p = resolvePreset('coder', { ...resolvePreset('coder').manifest, permissionPolicy: { Bash: 'deny' } });
    expect(p.presetRules).toEqual([{ tool: 'Bash', action: 'deny' }]);
    expect(p.defaultMode).toBe('ask'); // Record form → conservative default
  });
});
