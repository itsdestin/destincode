import { describe, it, expect } from 'vitest';
import { groupInstalledByPlugin } from '../src/renderer/utils/plugin-grouping';
import type { SkillEntry } from '../src/shared/types';

function skill(partial: Partial<SkillEntry> & { id: string }): SkillEntry {
  return {
    displayName: partial.id,
    description: '',
    category: 'other',
    prompt: `/${partial.id}`,
    source: 'plugin',
    type: 'prompt',
    visibility: 'published',
    ...partial,
  } as SkillEntry;
}

describe('groupInstalledByPlugin', () => {
  it('returns one group per plugin, bundling skills under pluginName', () => {
    const installed: SkillEntry[] = [
      skill({ id: 'youcoded-encyclopedia:journal', pluginName: 'youcoded-encyclopedia' }),
      skill({ id: 'youcoded-encyclopedia:compile', pluginName: 'youcoded-encyclopedia' }),
      skill({ id: 'civic-report', pluginName: 'civic-report' }),
    ];
    const marketplace: SkillEntry[] = [
      skill({ id: 'youcoded-encyclopedia', displayName: 'Encyclopedia', description: 'Life history', type: 'plugin' }),
      skill({ id: 'civic-report', displayName: 'Civic Report', description: 'Rep report', type: 'plugin' }),
    ];

    const groups = groupInstalledByPlugin(installed, marketplace);

    expect(groups).toHaveLength(2);
    const enc = groups.find(g => g.id === 'youcoded-encyclopedia')!;
    expect(enc.displayName).toBe('Encyclopedia');
    expect(enc.description).toBe('Life history');
    expect(enc.skills).toHaveLength(2);
    const civic = groups.find(g => g.id === 'civic-report')!;
    expect(civic.skills).toHaveLength(1);
  });

  it('treats skills with no pluginName as standalone single-skill groups', () => {
    const installed: SkillEntry[] = [
      skill({ id: 'my-custom-skill', source: 'self' }),
    ];
    const groups = groupInstalledByPlugin(installed, []);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe('my-custom-skill');
    expect(groups[0].skills).toHaveLength(1);
    expect(groups[0].skills[0].id).toBe('my-custom-skill');
  });

  it('falls back to the first skill metadata when marketplace entry is missing', () => {
    const installed: SkillEntry[] = [
      skill({ id: 'unknown:alpha', pluginName: 'unknown', displayName: 'Alpha' }),
      skill({ id: 'unknown:beta', pluginName: 'unknown', displayName: 'Beta' }),
    ];
    const groups = groupInstalledByPlugin(installed, []);
    expect(groups).toHaveLength(1);
    expect(groups[0].id).toBe('unknown');
    // Fallback titlecases pluginName rather than using 'Alpha'
    expect(groups[0].displayName).toBe('Unknown');
    expect(groups[0].skills).toHaveLength(2);
  });
});
