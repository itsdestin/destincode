import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, promises as fsp } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { casWrite } from '../../src/main/artifacts/cas-write';

describe('casWrite', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cas-test-'));
  });

  afterEach(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {}
  });

  it('writes new file atomically when no prior file exists', async () => {
    const target = join(dir, 'foo.json');
    const result = await casWrite(target, null, '{"v":1}');
    expect(result.committed).toBe(true);
    expect(readFileSync(target, 'utf8')).toBe('{"v":1}');
  });

  it('writes when expectedUpdatedAt matches', async () => {
    const target = join(dir, 'foo.json');
    writeFileSync(target, '{"updatedAt":"2026-01-01T00:00:00Z"}');
    const result = await casWrite(
      target,
      '2026-01-01T00:00:00Z',
      '{"updatedAt":"2026-01-02T00:00:00Z"}',
      (json) => JSON.parse(json).updatedAt
    );
    expect(result.committed).toBe(true);
  });

  it('rejects when expectedUpdatedAt does not match', async () => {
    const target = join(dir, 'foo.json');
    writeFileSync(target, '{"updatedAt":"2026-01-05T00:00:00Z"}');
    const result = await casWrite(
      target,
      '2026-01-01T00:00:00Z',
      '{"updatedAt":"2026-01-02T00:00:00Z"}',
      (json) => JSON.parse(json).updatedAt
    );
    expect(result.committed).toBe(false);
    expect(result.actualUpdatedAt).toBe('2026-01-05T00:00:00Z');
  });

  it('leaves no .tmp file behind on success or failure', async () => {
    const target = join(dir, 'foo.json');
    await casWrite(target, null, '{}');
    expect(existsSync(target + '.tmp')).toBe(false);
  });

  it('uses a per-process temp name (pid-suffixed), never a fixed <file>.tmp', async () => {
    // WHY: dev instance and built app share ~/.claude — a fixed '<file>.tmp'
    // lets two processes race the same temp path (loser's rename ENOENTs).
    const renameSpy = vi.spyOn(fsp, 'rename');
    try {
      const target = join(dir, 'pid.json');
      const result = await casWrite(target, null, '{"v":1}');
      expect(result.committed).toBe(true);
      const tmpSources = renameSpy.mock.calls
        .map((c) => String(c[0]))
        .filter((s) => s.endsWith('.tmp'));
      expect(tmpSources.length).toBeGreaterThan(0);
      for (const src of tmpSources) {
        expect(src).toContain(`.${process.pid}.`);
      }
    } finally {
      renameSpy.mockRestore();
    }
  });
});
