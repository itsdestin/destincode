import { describe, it, expect } from 'vitest';
import { loadFixture } from './fixture-loader';

describe('loadFixture', () => {
  it('parses a Skill tool_use + tool_result pair into a completed ToolCallState', () => {
    const raw = [
      '{"type":"tool_use","id":"toolu_01ABC","name":"Skill","input":{"skill":"superpowers:brainstorming"}}',
      '{"tool_use_id":"toolu_01ABC","type":"tool_result","content":"Launching skill: superpowers:brainstorming","is_error":false}',
    ].join('\n');

    const result = loadFixture('skill-brainstorming', raw);

    expect(result.tools).toHaveLength(1);
    // Note: 'complete' (not 'completed') matches the ToolCallStatus union in
    // shared/types.ts — the reducer writes 'complete' on successful tool_result.
    expect(result.tools[0]).toMatchObject({
      toolUseId: 'toolu_01ABC',
      toolName: 'Skill',
      input: { skill: 'superpowers:brainstorming' },
      status: 'complete',
      response: 'Launching skill: superpowers:brainstorming',
    });
    expect(result.error).toBeUndefined();
  });

  it('marks is_error:true results as failed status', () => {
    const raw = [
      '{"type":"tool_use","id":"toolu_01XYZ","name":"Bash","input":{"command":"false"}}',
      '{"tool_use_id":"toolu_01XYZ","type":"tool_result","content":"exit code 1","is_error":true}',
    ].join('\n');

    const result = loadFixture('bash-failure', raw);

    expect(result.tools[0].status).toBe('failed');
    expect(result.tools[0].error).toBe('exit code 1');
  });

  it('returns an error field when the fixture is malformed', () => {
    const result = loadFixture('broken', 'not valid json\n');

    expect(result.tools).toEqual([]);
    expect(result.error).toContain('parse');
  });
});
