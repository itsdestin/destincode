// Guard for ledger D-2 (2026-08-26 native-tools investigation): when a model
// sends a tool arguments the schema rejects, the text it gets back must NAME
// the problem in the model's own vocabulary — which parameter is unknown, which
// is missing, which has the wrong type — and, for an unknown parameter, list
// the parameters that DO exist so the fix is one retry away. Before this, an
// unknown key (`Grep {pattern, "-i": true}`) was silently dropped and a missing
// key produced zod's raw "Invalid input: expected string, received undefined".
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { formatArgErrors } from '../src/main/harness/tools/arg-errors';

const grepLike = z.object({
  pattern: z.string(),
  path: z.string().optional(),
  ignore_case: z.boolean().optional(),
  output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
  '-A': z.number().int().nonnegative().optional(),
}).strict();

function fail(schema: z.ZodType, input: unknown) {
  const r = schema.safeParse(input);
  if (r.success) throw new Error('expected the parse to fail');
  return r.error;
}

describe('formatArgErrors', () => {
  it('an unknown parameter is named, and the valid parameter list follows it', () => {
    const msg = formatArgErrors('Grep', fail(grepLike, { pattern: 'x', '-i': true }), grepLike);
    expect(msg).toBe(
      'Invalid arguments for Grep: unknown parameter(s) "-i". '
      + 'Valid parameters: pattern, path, ignore_case, output_mode, -A. Fix the arguments and call again.',
    );
  });

  it('several unknown parameters are listed together, once', () => {
    const msg = formatArgErrors('Grep', fail(grepLike, { pattern: 'x', '-i': true, case_sensitive: false }), grepLike);
    expect(msg).toContain('unknown parameter(s) "-i", "case_sensitive"');
    expect(msg.match(/Valid parameters:/g)).toHaveLength(1);
  });

  it('a missing required parameter says so, with the expected type', () => {
    const msg = formatArgErrors('Grep', fail(grepLike, {}), grepLike);
    expect(msg).toBe('Invalid arguments for Grep: missing required parameter "pattern" (expected string). Fix the arguments and call again.');
  });

  it('a wrong-type parameter names the field, the expected type, and what was received', () => {
    const msg = formatArgErrors('Grep', fail(grepLike, { pattern: 'x', '-A': 'two' }), grepLike);
    expect(msg).toContain('"-A" must be a number (received string)');
  });

  it('a bad enum value lists the allowed values', () => {
    const msg = formatArgErrors('Grep', fail(grepLike, { pattern: 'x', output_mode: 'lines' }), grepLike);
    expect(msg).toContain('"output_mode" must be one of "content", "files_with_matches", "count"');
  });

  it('nested paths are dotted so a bad item inside an array is still locatable', () => {
    const todo = z.object({ todos: z.array(z.object({ content: z.string() })) }).strict();
    const msg = formatArgErrors('TodoWrite', fail(todo, { todos: [{ content: 'a' }, {}] }), todo);
    expect(msg).toContain('missing required parameter "todos.1.content"');
  });

  it('several problems are joined with "; " and the valid list is only appended for unknown keys', () => {
    const msg = formatArgErrors('Grep', fail(grepLike, { '-A': 'two' }), grepLike);
    expect(msg).toContain('missing required parameter "pattern"');
    expect(msg).toContain('"-A" must be a number');
    expect(msg).toContain('; ');
    expect(msg).not.toContain('Valid parameters');
  });

  it('a schema with no introspectable shape (not a z.object) still produces a usable message', () => {
    const anyObj = z.record(z.string(), z.number());
    const msg = formatArgErrors('X', fail(anyObj, { a: 'no' }), anyObj);
    expect(msg).toMatch(/^Invalid arguments for X: /);
    expect(msg).not.toContain('Valid parameters');
  });
});
