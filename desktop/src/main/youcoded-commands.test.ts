import { describe, it, expect } from 'vitest';
import { YOUCODED_COMMANDS, expandWithAliases } from './youcoded-commands';

describe('youcoded-commands', () => {
  it('exports every dispatcher-backed command', () => {
    const names = YOUCODED_COMMANDS.map((e) => e.name);
    expect(names).toEqual(
      expect.arrayContaining([
        '/compact', '/clear', '/model', '/fast', '/effort',
        '/copy', '/resume', '/config', '/cost',
      ]),
    );
  });

  it('every entry is clickable and sourced to youcoded', () => {
    for (const entry of YOUCODED_COMMANDS) {
      expect(entry.clickable).toBe(true);
      expect(entry.source).toBe('youcoded');
      expect(entry.disabledReason).toBeUndefined();
    }
  });

  it('expandWithAliases flattens aliases into standalone entries', () => {
    const expanded = expandWithAliases(YOUCODED_COMMANDS);
    const names = expanded.map((e) => e.name);
    // /clear aliases to /reset, /new
    expect(names).toContain('/reset');
    expect(names).toContain('/new');
    // /config aliases to /settings
    expect(names).toContain('/settings');
    // /cost aliases to /usage
    expect(names).toContain('/usage');
  });

  it('expanded entries carry the primary description and are clickable', () => {
    const expanded = expandWithAliases(YOUCODED_COMMANDS);
    const reset = expanded.find((e) => e.name === '/reset');
    expect(reset?.clickable).toBe(true);
    expect(reset?.source).toBe('youcoded');
    expect(reset?.description.length).toBeGreaterThan(0);
  });
});
