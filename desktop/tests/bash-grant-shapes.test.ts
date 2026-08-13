import { describe, it, expect } from 'vitest';
import { bashGrantOptions, HOSTILE_CORPUS } from '../src/shared/bash-grant-shapes';
import { ruleMatches } from '../src/shared/subject-glob';
import { DESTRUCTIVE_DENY_LIST } from '../src/shared/permission-types';

const wideOf = (cmd: string) => bashGrantOptions(cmd).find((o) => o.scope === 'wide');
const exactOf = (cmd: string) => bashGrantOptions(cmd).find((o) => o.scope === 'exact');

describe('bashGrantOptions — exact rung', () => {
  it('stores the literal command with match:exact', () => {
    expect(exactOf('rm *.log')!.rule).toEqual({
      tool: 'Bash', pattern: 'rm *.log', action: 'allow', match: 'exact',
    });
  });

  it('does NOT trim — the stored pattern is the subject the engine will compare', () => {
    // permissionSubject hands over args.command verbatim (tools/bash.ts). A
    // trimmed pattern would be one character off and never fire again.
    expect(exactOf('ls -la\n')!.rule.pattern).toBe('ls -la\n');
  });

  it('an empty or whitespace command offers nothing', () => {
    expect(bashGrantOptions('')).toEqual([]);
    expect(bashGrantOptions('   ')).toEqual([]);
  });
});

describe('bashGrantOptions — wide rung derivation', () => {
  it('program + subcommand when the second token is a word', () => {
    expect(wideOf('cargo test --release')!.rule.pattern).toBe('cargo test*');
    expect(wideOf('npm run build')!.rule.pattern).toBe('npm run*');
  });

  it('program only when the second token is a flag or a path', () => {
    expect(wideOf('ls -la /tmp')!.rule.pattern).toBe('ls*');
    expect(wideOf('node scripts/x.mjs')!.rule.pattern).toBe('node*');
  });

  it('a quoted second token is an argument, not a subcommand', () => {
    expect(wideOf('echo "hi there"')!.rule.pattern).toBe('echo*');
  });

  it('the label never contains rule syntax', () => {
    expect(wideOf('cargo test --release')!.label).not.toMatch(/[*?]/);
  });
});

describe('bashGrantOptions — postcondition 1: an option covers its own command', () => {
  const corpus = [
    'npm run build', 'npm run build > log.txt', 'npm run build && git push',
    'ls -la /tmp', 'rm -rf build', 'sudo apt install x', 'cargo test --release',
    'git status', 'echo "hi there"', "grep -r 'x' .", 'node scripts/x.mjs',
    '  npm run build', 'git push origin feat/x',
  ];
  it('never offers an option that does not cover the command it was derived from', () => {
    for (const cmd of corpus) {
      for (const opt of bashGrantOptions(cmd)) {
        expect(ruleMatches(opt.rule, cmd), `${opt.scope} rung for ${JSON.stringify(cmd)}`).toBe(true);
      }
    }
  });

  it('a chained or redirected command gets no wide rung — safety rule 1 vetoes it', () => {
    expect(wideOf('npm run build && git push')).toBeUndefined();
    expect(exactOf('npm run build && git push')).toBeDefined();
    expect(wideOf('npm run build > log.txt')).toBeUndefined();
    expect(exactOf('npm run build > log.txt')).toBeDefined();
  });

  it('leading whitespace costs the wide rung, never the exact one', () => {
    expect(wideOf('  npm run build')).toBeUndefined();
    expect(exactOf('  npm run build')!.rule.pattern).toBe('  npm run build');
  });
});

describe('bashGrantOptions — postcondition 2: an option admits nothing hostile', () => {
  it('refuses a program-wide git rung — it would cover pushes and hard resets', () => {
    // The second token is a flag, so the derived key is the program alone. Without
    // this postcondition the user is offered "Any git command", which outranks the
    // destructive deny-list once stored.
    expect(wideOf('git --no-pager log')).toBeUndefined();
    expect(wideOf('git -C some/repo status')).toBeUndefined();
    expect(exactOf('git --no-pager log')).toBeDefined();
  });

  it('leaves innocent program-wide rungs alone', () => {
    expect(wideOf('ls -la /tmp')!.rule.pattern).toBe('ls*');
    expect(wideOf('node scripts/x.mjs')!.rule.pattern).toBe('node*');
    expect(wideOf('git status')!.rule.pattern).toBe('git status*');
  });

  it('no wide rung anywhere admits a hostile command', () => {
    const commands = [
      'git --no-pager log', 'git -C x status', 'git status', 'npm run build',
      'ls -la', 'node x.mjs', 'cargo test', 'docker ps', 'echo hi',
    ];
    for (const cmd of commands) {
      const wide = wideOf(cmd);
      if (!wide) continue;
      for (const hostile of HOSTILE_CORPUS) {
        expect(ruleMatches(wide.rule, hostile), `${wide.rule.pattern} admits ${hostile}`).toBe(false);
      }
    }
  });

  it('every destructive deny-list family has a corpus entry (adding a family fails here)', () => {
    // Only the base patterns: the '* …' compound variants exist to catch chained
    // commands, which safety rule 1 already keeps out of every grant.
    const families = DESTRUCTIVE_DENY_LIST.filter((r) => !r.pattern!.startsWith('* '));
    for (const family of families) {
      expect(
        HOSTILE_CORPUS.some((c) => ruleMatches(family, c)),
        `no HOSTILE_CORPUS entry matches ${family.pattern}`,
      ).toBe(true);
    }
  });
});

describe('bashGrantOptions — deny-listed families', () => {
  it.each(['rm -rf build', 'rmdir old', 'sudo apt install x', 'format d:', 'git reset --hard HEAD~1'])(
    'offers exact only for %s', (cmd) => {
      expect(wideOf(cmd)).toBeUndefined();
      expect(exactOf(cmd)).toBeDefined();
    },
  );
});
