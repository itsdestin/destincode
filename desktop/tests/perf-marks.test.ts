// tests/perf-marks.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

describe('perfMark', () => {
  let dir: string;
  afterEach(() => { vi.unstubAllEnvs(); vi.resetModules(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('appends one JSON line per mark when YOUCODED_PERF_LOG is set', async () => {
    dir = mkdtempSync(join(tmpdir(), 'perf-marks-'));
    const file = join(dir, 'marks.jsonl');
    vi.stubEnv('YOUCODED_PERF_LOG', file);
    const { perfMark } = await import('../src/main/perf-marks');
    perfMark('main:a'); perfMark('main:b');
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.name)).toEqual(['main:a', 'main:b']);
    expect(typeof lines[0].t).toBe('number');
    expect(lines[0].pid).toBe(process.pid);
  });

  it('is a no-op when the env var is unset', async () => {
    vi.stubEnv('YOUCODED_PERF_LOG', '');
    const { perfMark } = await import('../src/main/perf-marks');
    expect(() => perfMark('main:x')).not.toThrow();
  });
});
