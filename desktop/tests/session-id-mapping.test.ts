import { describe, it, expect } from 'vitest';
import { resolveMappingAction } from '../src/main/session-id-mapping';

describe('resolveMappingAction', () => {
  it('adopts the first mapping from any hook event', () => {
    expect(resolveMappingAction(undefined, 'claude-1', 'PostToolUse')).toBe('adopt');
    expect(resolveMappingAction(undefined, 'claude-1', 'SessionStart')).toBe('adopt');
  });

  it('ignores events that match the current mapping', () => {
    expect(resolveMappingAction('claude-1', 'claude-1', 'SessionStart')).toBe('ignore');
    expect(resolveMappingAction('claude-1', 'claude-1', 'PostToolUse')).toBe('ignore');
  });

  it('remaps on SessionStart with a new id (/clear rotation)', () => {
    expect(resolveMappingAction('claude-1', 'claude-2', 'SessionStart')).toBe('adopt');
  });

  it('never remaps from non-SessionStart events (subagent ids must not poison the map)', () => {
    expect(resolveMappingAction('claude-1', 'claude-2', 'PostToolUse')).toBe('ignore');
    expect(resolveMappingAction('claude-1', 'claude-2', 'SubagentStart')).toBe('ignore');
    expect(resolveMappingAction('claude-1', 'claude-2', 'Stop')).toBe('ignore');
    expect(resolveMappingAction('claude-1', 'claude-2', undefined)).toBe('ignore');
  });
});
