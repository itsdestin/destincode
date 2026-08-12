// The native runtime's budget gates (max_steps / doom_loop) reach the UI as
// synthetic permission "tools". friendlyToolDisplay must render plain-language
// "Continue?" copy — NEVER the raw internal name (which is what a non-developer
// saw before this fix). Pins the copy + that the step count / repeated tool
// name is surfaced.
//
// Also pins malformed-input hardening: tool inputs are unknown-typed JSON from
// the model/provider, and a non-string where a string was expected must never
// render as "[object Object]" in chat (the exact failure class the harness
// review battery caught for a provider 402) — nor crash the renderer.
import { describe, it, expect } from 'vitest';
import { friendlyToolDisplay } from '../src/renderer/components/ToolCard';

const tool = (toolName: string, input: Record<string, unknown>) =>
  ({ toolName, input } as any);

describe('friendlyToolDisplay — budget gates', () => {
  it('max_steps: renders a Continue? question with the step count, not "max_steps"', () => {
    const d = friendlyToolDisplay(tool('max_steps', { steps: 25 }));
    expect(d.label).toBe('Continue?');
    expect(d.label).not.toContain('max_steps');
    expect(d.detail).toContain('25');
    expect(d.detail.toLowerCase()).toContain('steps');
  });

  it('max_steps: tolerates a missing/garbage step count (shows 0, never NaN)', () => {
    expect(friendlyToolDisplay(tool('max_steps', {})).detail).toContain('0');
    expect(friendlyToolDisplay(tool('max_steps', { steps: 'x' })).detail).not.toContain('NaN');
  });

  it('doom_loop: names the repeated tool when present', () => {
    const d = friendlyToolDisplay(tool('doom_loop', { repeated: 'Bash' }));
    expect(d.label).toBe('Continue?');
    expect(d.detail).toContain('Bash');
  });

  it('doom_loop: falls back gracefully with no repeated tool', () => {
    const d = friendlyToolDisplay(tool('doom_loop', {}));
    expect(d.label).toBe('Continue?');
    expect(d.detail.toLowerCase()).toContain('repeating');
  });
});

describe('friendlyToolDisplay — malformed (non-string) inputs never leak [object Object]', () => {
  it('Grep: object-valued glob is treated as absent, not interpolated', () => {
    const d = friendlyToolDisplay(tool('Grep', { pattern: 'foo', glob: { bad: true } }));
    expect(d.detail).not.toContain('[object Object]');
    expect(d.detail).toBe('');
  });

  it('Grep: object-valued glob falls through to a valid string path', () => {
    const d = friendlyToolDisplay(tool('Grep', { pattern: 'foo', glob: { bad: true }, path: '/a/b' }));
    expect(d.detail).toBe('↳ in b/');
  });

  it('Grep: number-valued type is treated as absent, not interpolated', () => {
    const d = friendlyToolDisplay(tool('Grep', { pattern: 'foo', type: 42 }));
    expect(d.detail).not.toContain('42');
    expect(d.detail).toBe('');
  });

  it('Grep: object-valued path neither crashes basename() nor renders', () => {
    const d = friendlyToolDisplay(tool('Grep', { pattern: 'foo', path: { bad: true } }));
    expect(d.detail).not.toContain('[object Object]');
    expect(d.detail).toBe('');
  });

  it('Glob: object-valued path neither crashes basename() nor renders', () => {
    const d = friendlyToolDisplay(tool('Glob', { pattern: '**/*.ts', path: { bad: true } }));
    expect(d.detail).not.toContain('[object Object]');
    expect(d.detail).toBe('');
  });

  it('Agent: object-valued subagent_type is treated as absent, not interpolated', () => {
    const d = friendlyToolDisplay(tool('Agent', { description: 'search', subagent_type: { bad: true } }));
    expect(d.detail).not.toContain('[object Object]');
    expect(d.detail).toBe('');
  });

  it('AskUserQuestion: object-valued header falls back to "Question", not [object Object]', () => {
    const d = friendlyToolDisplay(tool('AskUserQuestion', { questions: [{ header: { bad: true } }] }));
    expect(d.label).not.toContain('[object Object]');
    expect(d.label).toBe('Question');
  });

  it('AskUserQuestion: object-valued header falls through to a string question text', () => {
    const d = friendlyToolDisplay(tool('AskUserQuestion', { questions: [{ header: { bad: true }, question: 'Pick one' }] }));
    expect(d.label).toBe('Pick one');
  });
});
