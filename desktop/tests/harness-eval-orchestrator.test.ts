import { describe, it, expect } from 'vitest';
import { graderRoot, harnessRoot } from '../src/main/harness/eval/paths';

describe('grader isolation', () => {
  it('resolves graders against its own checkout, never the dist under test', () => {
    expect(graderRoot({ dist: '/somewhere/else/dist' })).not.toContain('/somewhere/else');
  });
  it('resolves the harness under test against the given dist', () => {
    expect(harnessRoot({ dist: '/somewhere/else/dist' })).toContain('/somewhere/else');
  });
});
