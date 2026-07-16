import { describe, it, expect } from 'vitest';
import { checkPathGuard } from '../src/main/harness/tools/guards';
import * as os from 'os';
import * as path from 'path';

const CWD = path.join(os.tmpdir(), 'guard-test-workspace');

describe('checkPathGuard', () => {
  it('allows paths inside the workspace', () => {
    expect(checkPathGuard(path.join(CWD, 'src/a.ts'), CWD).kind).toBe('ok');
    expect(checkPathGuard('src/a.ts', CWD).kind).toBe('ok'); // relative resolves against cwd
  });
  it('hard-denies secret files regardless of location', () => {
    expect(checkPathGuard(path.join(CWD, '.env'), CWD).kind).toBe('deny');
    expect(checkPathGuard(path.join(os.homedir(), '.ssh', 'id_rsa'), CWD).kind).toBe('deny');
  });
  it('flags outside-workspace paths as external (→ ask), not deny', () => {
    const v = checkPathGuard(path.join(os.tmpdir(), 'elsewhere', 'x.txt'), CWD);
    expect(v.kind).toBe('external');
  });
});
