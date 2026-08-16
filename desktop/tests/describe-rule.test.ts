import { describe, it, expect } from 'vitest';
import { describeRule, ruleKind } from '../src/renderer/components/permissions/describe-rule';

describe('describeRule', () => {
  it('renders a Bash grant as the command it runs', () => {
    expect(describeRule({ tool: 'Bash', pattern: 'git push origin main', action: 'allow' }))
      .toEqual({ verb: 'Run', subject: 'git push origin main', width: 'exact' });
  });

  it('renders file tools with their path', () => {
    expect(describeRule({ tool: 'Edit', pattern: 'src/a.ts', action: 'allow' }))
      .toEqual({ verb: 'Edit', subject: 'src/a.ts', width: 'exact' });
    expect(describeRule({ tool: 'Write', pattern: 'src/b.ts', action: 'allow' }))
      .toEqual({ verb: 'Create or overwrite', subject: 'src/b.ts', width: 'exact' });
  });

  it('names the server and tool for an MCP grant', () => {
    expect(describeRule({ tool: 'mcp__github__create_issue', action: 'allow' }))
      .toEqual({ verb: 'Use the create_issue tool from the github connection', width: 'exact' });
  });

  // A server id containing a double underscore must not swallow the tool name.
  it('splits an MCP id on the FIRST separator after the prefix', () => {
    expect(describeRule({ tool: 'mcp__my__server__do_thing', action: 'allow' }).verb)
      .toBe('Use the server__do_thing tool from the my connection');
  });

  it('flags a pattern-less grant as tool-wide', () => {
    expect(describeRule({ tool: 'Write', action: 'allow' }))
      .toEqual({ verb: 'Create or overwrite', subject: undefined, width: 'tool-wide' });
  });

  // The type permits deny; nothing writes one today, but the UI must not
  // render a deny rule as though it were a grant.
  it('describes a deny rule as a block', () => {
    expect(describeRule({ tool: 'Bash', pattern: 'sudo *', action: 'deny' }))
      .toEqual({ verb: 'Never run', subject: 'sudo *', width: 'exact' });
  });

  it('falls back to the tool name for an unknown tool', () => {
    expect(describeRule({ tool: 'SomeFutureTool', pattern: 'x', action: 'allow' }))
      .toEqual({ verb: 'Use SomeFutureTool', subject: 'x', width: 'exact' });
  });

  // Fix 1 — remembered Task grants must read as plain language, never the raw
  // `${charter}:${work_dir}` envelope key task.ts's permissionSubject mints,
  // and never say "Task" out loud (model-facing vocabulary; the spec's word
  // for the user is "specialist").
  describe('Task grants (plain-language specialist copy)', () => {
    it('renders a read-only charter subject', () => {
      expect(describeRule({ tool: 'Task', pattern: 'read-only:/home/x/proj', action: 'allow' }))
        .toEqual({ verb: 'Let a read-only specialist work in', subject: '/home/x/proj', width: 'exact' });
    });

    it('renders a read-write charter subject', () => {
      expect(describeRule({ tool: 'Task', pattern: 'read-write:/home/x/proj', action: 'allow' }))
        .toEqual({ verb: 'Let a specialist edit files in', subject: '/home/x/proj', width: 'exact' });
    });

    // The unknown-agent fallback in task.ts's permissionSubject — no charter
    // prefix, just the bare work_dir.
    it('renders a bare-path pattern (unknown-agent fallback) without a charter prefix', () => {
      expect(describeRule({ tool: 'Task', pattern: '/home/x/proj', action: 'allow' }))
        .toEqual({ verb: 'Let a specialist work in', subject: '/home/x/proj', width: 'exact' });
    });

    it('renders a pattern-less Task grant as broad, in plain language', () => {
      expect(describeRule({ tool: 'Task', action: 'allow' }))
        .toEqual({ verb: 'Let specialists work anywhere in this project', width: 'tool-wide' });
    });

    it('groups under "commands", not the "other" catch-all', () => {
      expect(ruleKind({ tool: 'Task', pattern: 'read-only:/home/x/proj', action: 'allow' })).toBe('commands');
    });
  });

  // M5 2c: 'broad' was a boolean, and an exact grant and a scoped one are BOTH
  // "not broad" while covering wildly different amounts. The screen has to tell
  // them apart, so the flag became a three-way width.
  describe('width', () => {
    it('a legacy rule with no match reads as exact — PermissionStore normalizes on read', () => {
      expect(describeRule({ tool: 'Bash', pattern: 'ls -la', action: 'allow' }).width).toBe('exact');
      expect(describeRule({ tool: 'Bash', pattern: 'ls -la', action: 'allow', match: 'exact' }).width).toBe('exact');
    });

    it('a scoped push rule is wide and reads as a whole sentence', () => {
      const d = describeRule({
        tool: 'Bash', pattern: 'git push*origin master', action: 'allow', match: 'glob',
      });
      expect(d.width).toBe('wide');
      expect(d.verb).toBe('Pushing to master');
      expect(d.subject).toBeUndefined();
    });

    it('a generic wide rule reads as its own sentence too', () => {
      expect(describeRule({ tool: 'Bash', pattern: 'npm run*', action: 'allow', match: 'glob' }).verb)
        .toBe('Any npm run command');
    });

    it('a wide pattern this module cannot phrase falls back to verb + subject', () => {
      // Not a shape this app produces; the screen still renders something honest
      // rather than inventing a sentence.
      const d = describeRule({ tool: 'Bash', pattern: 'we?rd', action: 'allow', match: 'glob' });
      expect(d.verb).toBe('Run');
      expect(d.subject).toBe('we?rd');
      expect(d.width).toBe('wide');
    });

    it('an MCP grant reports exact, not tool-wide', () => {
      expect(describeRule({ tool: 'mcp__srv__tool', action: 'allow' }).width).toBe('exact');
    });

    it('a specialist grant keeps its own sentence and its own width', () => {
      expect(describeRule({ tool: 'Task', pattern: 'read-only:/home/x/proj', action: 'allow' }).width).toBe('exact');
      expect(describeRule({ tool: 'Task', action: 'allow' }).width).toBe('tool-wide');
    });

    it('no description ever contains rule syntax', () => {
      const rules = [
        { tool: 'Bash', pattern: 'git push*origin master', action: 'allow' as const, match: 'glob' as const },
        { tool: 'Bash', pattern: 'npm run*', action: 'allow' as const, match: 'glob' as const },
        { tool: '*', action: 'allow' as const },
      ];
      for (const r of rules) {
        const d = describeRule(r);
        expect(`${d.verb} ${d.subject ?? ''}`).not.toMatch(/[*?]/);
      }
    });
  });
});
