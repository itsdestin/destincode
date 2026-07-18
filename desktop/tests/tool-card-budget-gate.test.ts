// The native runtime's budget gates (max_steps / doom_loop) reach the UI as
// synthetic permission "tools". friendlyToolDisplay must render plain-language
// "Continue?" copy — NEVER the raw internal name (which is what a non-developer
// saw before this fix). Pins the copy + that the step count / repeated tool
// name is surfaced.
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
