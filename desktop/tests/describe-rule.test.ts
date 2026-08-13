import { describe, it, expect } from 'vitest';
import { describeRule } from '../src/renderer/components/permissions/describe-rule';

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
});
