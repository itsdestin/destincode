import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import { readLogTail } from '../src/main/dev-tools';

vi.mock('fs', () => ({
  promises: {
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn().mockResolvedValue(undefined),
  },
  existsSync: vi.fn(),
}));
// Mock os so home-dir redaction and tmpdir resolve predictably in tests.
vi.mock('os', () => ({
  homedir: vi.fn(() => '/home/alice'),
  tmpdir: vi.fn(() => '/tmp'),
}));
vi.mock('child_process', () => ({
  execFile: vi.fn(),
  // spawn mock returns an EventEmitter-like object with stdout/stderr stubs.
  // Individual tests override execFile; spawn is only used by installWorkspace.
  spawn: vi.fn(() => ({
    stdout: { on: vi.fn() },
    stderr: { on: vi.fn() },
    on: vi.fn(),
  })),
}));

describe('readLogTail', () => {
  it('returns empty string when log file is missing', async () => {
    const fs = await import('fs');
    vi.mocked(fs.promises.readFile).mockRejectedValue(
      Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
    );
    expect(await readLogTail(200)).toBe('');
  });

  it('redacts home dir and tokens before returning', async () => {
    const fs = await import('fs');
    const raw =
      'opened /home/alice/projects/foo\n' +
      'token=ghp_abcdefghij1234567890XYZ\n';
    vi.mocked(fs.promises.readFile).mockResolvedValue(raw as any);
    const out = await readLogTail(200);
    expect(out).toContain('~/projects/foo');
    expect(out).toContain('[REDACTED-GH-TOKEN]');
    expect(out).not.toContain('ghp_');
  });

  it('returns only the last N lines', async () => {
    const fs = await import('fs');
    const raw = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n');
    vi.mocked(fs.promises.readFile).mockResolvedValue(raw as any);
    const out = await readLogTail(50);
    const lines = out.split('\n');
    expect(lines.length).toBe(50);
    expect(lines.at(-1)).toBe('line 499');
  });
});
