import { describe, it, expect } from 'vitest';
import { decidePermission } from '../src/main/harness/permission-engine';
import { rulesForMode, DESTRUCTIVE_DENY_LIST } from '../src/shared/permission-types';

const layers = (mode: 'ask' | 'auto-edit' | 'full-auto', remembered = [] as any[]) => ({
  presetRules: [],
  modeRules: rulesForMode(mode),
  denyList: DESTRUCTIVE_DENY_LIST,
  rememberedRules: remembered,
});

describe('decidePermission', () => {
  it('ask mode: reads allow, edits ask', () => {
    expect(decidePermission('Read', 'src/a.ts', layers('ask')).action).toBe('allow');
    expect(decidePermission('Edit', 'src/a.ts', layers('ask')).action).toBe('ask');
    expect(decidePermission('Bash', 'ls', layers('ask')).action).toBe('ask');
  });
  it('auto-edit: edits allow, bash still asks', () => {
    expect(decidePermission('Edit', 'src/a.ts', layers('auto-edit')).action).toBe('allow');
    expect(decidePermission('Bash', 'npm test', layers('auto-edit')).action).toBe('ask');
  });
  it('full-auto allows bash but the deny-list still asks — and flags denyListed', () => {
    expect(decidePermission('Bash', 'npm test', layers('full-auto')).action).toBe('allow');
    const d = decidePermission('Bash', 'git push origin master', layers('full-auto'));
    expect(d.action).toBe('ask');
    expect(d.denyListed).toBe(true);
  });
  it('an explicit remembered rule beats the deny-list (spec ruling #2)', () => {
    const d = decidePermission('Bash', 'git push origin master',
      layers('full-auto', [{ tool: 'Bash', pattern: 'git push*', action: 'allow' }]));
    expect(d.action).toBe('allow');
  });
  it('last matching rule wins WITHIN a layer', () => {
    const d = decidePermission('Edit', 'docs/readme.md', {
      presetRules: [], modeRules: [
        { tool: 'Edit', action: 'ask' },
        { tool: 'Edit', pattern: 'docs/*', action: 'allow' },
      ], denyList: [], rememberedRules: [],
    });
    expect(d.action).toBe('allow');
  });
  it('unknown tool with no matching rule defaults to ask (never silent-allow)', () => {
    expect(decidePermission('Mystery', undefined, { presetRules: [], modeRules: [], denyList: [], rememberedRules: [] }).action).toBe('ask');
  });

  // Extra torture cases pinning the semantics table (cheap, obviously correct):
  it('a remembered deny rule wins over a mode allow', () => {
    // full-auto's `{tool:'*', action:'allow'}` is the earliest-layer catch-all;
    // a later remembered 'deny' must still win via last-match-wins.
    const d = decidePermission('Bash', 'anything', layers('full-auto', [
      { tool: 'Bash', action: 'deny' },
    ]));
    expect(d.action).toBe('deny');
    expect(d.denyListed).toBe(false); // winner is the remembered rule, not the deny-list
  });
  it('denyListed is NOT set when a remembered rule outranks the deny-list', () => {
    // The remembered rule wins, so the consequence-gated warning must NOT fire.
    const d = decidePermission('Bash', 'git push origin master',
      layers('full-auto', [{ tool: 'Bash', pattern: 'git push*', action: 'allow' }]));
    expect(d.action).toBe('allow');
    expect(d.denyListed).toBe(false);
  });
});
