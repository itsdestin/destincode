import { describe, it, expect } from 'vitest';
import { describeRule, ruleKind } from '../src/renderer/components/permissions/describe-rule';

describe('describeRule', () => {
  it('renders a Bash grant as the command it runs', () => {
    expect(describeRule({ tool: 'Bash', pattern: 'git push origin main', action: 'allow' }))
      .toEqual({ verb: 'Run', subject: 'git push origin main', broad: false });
  });

  it('renders file tools with their path', () => {
    expect(describeRule({ tool: 'Edit', pattern: 'src/a.ts', action: 'allow' }))
      .toEqual({ verb: 'Edit', subject: 'src/a.ts', broad: false });
    expect(describeRule({ tool: 'Write', pattern: 'src/b.ts', action: 'allow' }))
      .toEqual({ verb: 'Create or overwrite', subject: 'src/b.ts', broad: false });
  });

  it('names the server and tool for an MCP grant', () => {
    expect(describeRule({ tool: 'mcp__github__create_issue', action: 'allow' }))
      .toEqual({ verb: 'Use the create_issue tool from the github connection', broad: false });
  });

  // A server id containing a double underscore must not swallow the tool name.
  it('splits an MCP id on the FIRST separator after the prefix', () => {
    expect(describeRule({ tool: 'mcp__my__server__do_thing', action: 'allow' }).verb)
      .toBe('Use the server__do_thing tool from the my connection');
  });

  it('flags a pattern-less grant as broad', () => {
    expect(describeRule({ tool: 'Write', action: 'allow' }))
      .toEqual({ verb: 'Create or overwrite', subject: undefined, broad: true });
  });

  // The type permits deny; nothing writes one today, but the UI must not
  // render a deny rule as though it were a grant.
  it('describes a deny rule as a block', () => {
    expect(describeRule({ tool: 'Bash', pattern: 'sudo *', action: 'deny' }))
      .toEqual({ verb: 'Never run', subject: 'sudo *', broad: false });
  });

  it('falls back to the tool name for an unknown tool', () => {
    expect(describeRule({ tool: 'SomeFutureTool', pattern: 'x', action: 'allow' }))
      .toEqual({ verb: 'Use SomeFutureTool', subject: 'x', broad: false });
  });

  // Fix 1 — remembered Task grants must read as plain language, never the raw
  // `${charter}:${work_dir}` envelope key task.ts's permissionSubject mints,
  // and never say "Task" out loud (model-facing vocabulary; the spec's word
  // for the user is "specialist").
  describe('Task grants (plain-language specialist copy)', () => {
    it('renders a read-only charter subject', () => {
      expect(describeRule({ tool: 'Task', pattern: 'read-only:/home/x/proj', action: 'allow' }))
        .toEqual({ verb: 'Let a read-only specialist work in', subject: '/home/x/proj', broad: false });
    });

    it('renders a read-write charter subject', () => {
      expect(describeRule({ tool: 'Task', pattern: 'read-write:/home/x/proj', action: 'allow' }))
        .toEqual({ verb: 'Let a specialist edit files in', subject: '/home/x/proj', broad: false });
    });

    // The unknown-agent fallback in task.ts's permissionSubject — no charter
    // prefix, just the bare work_dir.
    it('renders a bare-path pattern (unknown-agent fallback) without a charter prefix', () => {
      expect(describeRule({ tool: 'Task', pattern: '/home/x/proj', action: 'allow' }))
        .toEqual({ verb: 'Let a specialist work in', subject: '/home/x/proj', broad: false });
    });

    it('renders a pattern-less Task grant as broad, in plain language', () => {
      expect(describeRule({ tool: 'Task', action: 'allow' }))
        .toEqual({ verb: 'Let specialists work anywhere in this project', broad: true });
    });

    it('groups under "commands", not the "other" catch-all', () => {
      expect(ruleKind({ tool: 'Task', pattern: 'read-only:/home/x/proj', action: 'allow' })).toBe('commands');
    });
  });
});
