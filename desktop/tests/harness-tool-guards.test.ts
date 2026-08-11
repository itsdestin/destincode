import { describe, it, expect } from 'vitest';
import { checkPathGuard, canonicalize, toPosix } from '../src/main/harness/tools/guards';
import { spillDirFor, spillRoot } from '../src/main/harness/tools/spill-paths';
import * as os from 'os';
import * as path from 'path';

const CWD = path.join(os.tmpdir(), 'guard-test-workspace');
const HOME = os.homedir();
const isWin = process.platform === 'win32';

// Adversarial table encoding the guard threat model (spec §2.3): secrets
// hard-deny regardless of case (on the case-insensitive win32 fs), the cwd jail
// is not fooled by `..`, and out-of-jail paths ask rather than silently allow.
const cases: Array<{ name: string; raw: string; want: 'ok' | 'deny' | 'external'; winOnly?: boolean }> = [
  // In-jail, ordinary files → ok
  { name: 'file inside workspace', raw: path.join(CWD, 'src/a.ts'), want: 'ok' },
  { name: 'relative path resolves against cwd', raw: 'src/a.ts', want: 'ok' },
  { name: '.environment (not a dotenv) inside workspace', raw: path.join(CWD, '.environment'), want: 'ok' },

  // Secrets → deny (lowercase forms match everywhere via the segment/basename sets)
  { name: 'workspace .env', raw: path.join(CWD, '.env'), want: 'deny' },
  { name: 'workspace .env.local', raw: path.join(CWD, '.env.local'), want: 'deny' },
  { name: '~/.ssh/id_rsa', raw: path.join(HOME, '.ssh', 'id_rsa'), want: 'deny' },
  { name: '~/.gnupg/x', raw: path.join(HOME, '.gnupg', 'x'), want: 'deny' },
  { name: '~/.aws/credentials', raw: path.join(HOME, '.aws', 'credentials'), want: 'deny' },

  // Case-variant secrets → deny, but only on the case-insensitive win32 fs.
  // On POSIX `.SSH` / `.Env` are genuinely different names and must NOT deny.
  { name: 'case-variant ~/.SSH/id_rsa', raw: path.join(HOME, '.SSH', 'id_rsa'), want: 'deny', winOnly: true },
  { name: 'case-variant workspace .Env', raw: path.join(CWD, '.Env'), want: 'deny', winOnly: true },

  // Out of jail → external (ask), never ok
  { name: 'sibling dir outside workspace', raw: path.join(os.tmpdir(), 'elsewhere', 'x.txt'), want: 'external' },
];

describe('checkPathGuard — threat model table', () => {
  for (const c of cases) {
    const run = c.winOnly && !isWin ? it.skip : it;
    run(`${c.name} -> ${c.want}`, () => {
      expect(checkPathGuard(c.raw, CWD).kind).toBe(c.want);
    });
  }

  // 2026-08-11 review round 8: Bash tells the model to Read its spill file, and
  // the guard used to force an approval ask for it — advice the harness itself
  // then blocked. These pin the exemption AND its limits.
  describe('Bash spill files', () => {
    it('a spill file is readable without an external_directory ask', () => {
      const spill = path.join(spillDirFor('session-1'), 'bash-123-abc.txt');
      expect(checkPathGuard(spill, CWD).kind).toBe('ok');
    });

    it('the exemption is the spill root, not all of tmpdir', () => {
      // A sibling directory under the same tmpdir must still ask — otherwise the
      // exemption would quietly open every temp file on the machine.
      const sibling = path.join(os.tmpdir(), 'not-our-spill', 'x.txt');
      expect(checkPathGuard(sibling, CWD).kind).toBe('external');
    });

    it('cannot be used to reach a credential file by climbing out of the spill root', () => {
      // The credential denies run BEFORE the exemption, so a path carrying a
      // `.ssh` segment is denied even though it is spelled as a spill path.
      // This is the ordering the exemption's placement depends on. Built from
      // segments rather than from HOME so the drive layout can't change the
      // result on Windows.
      const escape = path.join(spillRoot(), '..', 'somewhere', '.ssh', 'id_rsa');
      expect(checkPathGuard(escape, CWD).kind).toBe('deny');
    });
  });

  it('absolute path with `..` cannot escape the cwd jail (external, not ok)', () => {
    // Lexically "inside" CWD but climbs two levels out — must be normalized,
    // classified external, and NOT silently allowed.
    const escape = path.join(CWD, '..', '..', 'outside.txt');
    const v = checkPathGuard(escape, CWD);
    expect(v.kind).toBe('external');
    // The external verdict must carry the fully-normalized canonicalPath.
    if (v.kind === 'external') {
      expect(v.canonicalPath).toBe(canonicalize(escape, CWD));
      expect(v.canonicalPath).not.toContain('..');
      expect(v.canonicalPath).toContain('outside.txt');
    }
  });
});

describe('toPosix', () => {
  it('converts Windows separators to forward slashes', () => {
    expect(toPosix('src\\a.ts')).toBe('src/a.ts');
  });

  it('leaves an already-posix path untouched', () => {
    expect(toPosix('src/a.ts')).toBe('src/a.ts');
  });

  it('normalizes an absolute Windows path', () => {
    expect(toPosix('C:\\Users\\Dev\\a.ts')).toBe('C:/Users/Dev/a.ts');
  });

  // Regression pin (2026-08-11): toPosix is NOT canonicalize(). canonicalize()
  // ALSO resolves against a cwd, collapses `..`, and lowercases the whole path
  // on win32 — correct for the sensitive-path comparison sets it feeds, and
  // silently destructive for anything a user or model reads back. Anyone
  // reaching for "the path normalizer" must land on the right one.
  it('does not resolve, absolutize, or case-fold — it is not canonicalize()', () => {
    expect(toPosix('SRC/README.md')).toBe('SRC/README.md');
    expect(toPosix('a\\..\\b')).toBe('a/../b');
  });
});
