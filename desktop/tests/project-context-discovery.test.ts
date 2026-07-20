import { describe, it, expect } from 'vitest';
import { discoverContext, type DiscoveryInput } from '../src/main/project/context-discovery';

const input: DiscoveryInput = {
  projectRoot: '/home/u/proj',
  homeDir: '/home/u',
  projectSlug: '-home-u-proj',
  projectInstructionFiles: ['CLAUDE.md'],
  projectRules: [{ file: 'android.md', glob: 'app/**' }, { file: 'general.md' }],
  globalInstructionFiles: ['CLAUDE.md', 'AGENTS.md'],
  globalRules: [{ file: 'live-app-safety.md' }],
  memoryFiles: ['MEMORY.md', 'feedback_x.md'],
};

describe('discoverContext', () => {
  const groups = discoverContext(input);
  const byScope = (s: string) => groups.find(g => g.scope === s)!.files;

  it('returns three groups in order global, project, memory', () => {
    expect(groups.map(g => g.scope)).toEqual(['global', 'project', 'memory']);
  });
  it('marks project CLAUDE.md always', () => {
    const f = byScope('project').find(x => x.kind === 'claude-md')!;
    expect(f.timing).toBe('always');
    expect(f.blastRadius).toBe('project');
  });
  it('marks global CLAUDE.md always-everywhere with global blast radius', () => {
    const f = byScope('global').find(x => x.kind === 'claude-md')!;
    expect(f.timing).toBe('always-everywhere');
    expect(f.blastRadius).toBe('global');
  });
  it('marks a globbed rule conditional and carries the glob', () => {
    const f = byScope('project').find(x => x.label === 'android.md')!;
    expect(f.timing).toBe('conditional');
    expect(f.glob).toBe('app/**');
  });
  it('marks an unglobbed rule always', () => {
    expect(byScope('project').find(x => x.label === 'general.md')!.timing).toBe('always');
  });
  it('marks MEMORY.md as index and other memory files on-recall', () => {
    expect(byScope('memory').find(x => x.label === 'MEMORY.md')!.timing).toBe('index');
    expect(byScope('memory').find(x => x.label === 'feedback_x.md')!.timing).toBe('on-recall');
  });
});
