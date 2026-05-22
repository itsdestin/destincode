import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readSidecar, writeSidecar } from '../../src/main/artifacts/artifact-store';
import sample from '../../../shared-fixtures/artifacts/sample-sidecar.json';

describe('readSidecar', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'as-read-'));
    mkdirSync(join(projectRoot, '.youcoded'));
  });

  it('returns null when sidecar does not exist', async () => {
    const sidecar = await readSidecar(projectRoot);
    expect(sidecar).toBeNull();
  });

  it('parses a well-formed sidecar', async () => {
    writeFileSync(join(projectRoot, '.youcoded/artifacts.json'), JSON.stringify(sample));
    const sidecar = await readSidecar(projectRoot);
    expect(sidecar?.projectId).toBe('01HXAB000000000000000000');
    expect(sidecar?.artifacts).toHaveLength(1);
  });

  it('returns {corrupted: true} on parse failure and backs up the file', async () => {
    writeFileSync(join(projectRoot, '.youcoded/artifacts.json'), '{ not valid json');
    const sidecar = await readSidecar(projectRoot);
    expect(sidecar).toEqual({ corrupted: true });
    const { readdirSync } = await import('fs');
    const files = readdirSync(join(projectRoot, '.youcoded'));
    expect(files.some(f => f.startsWith('artifacts.json.bak.'))).toBe(true);
  });
});

describe('writeSidecar', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'as-write-'));
  });

  it('creates sidecar atomically when none exists', async () => {
    const sidecar = { ...sample, updatedAt: '2026-05-21T15:00:00.000Z' };
    const result = await writeSidecar(projectRoot, null, sidecar);
    expect(result.committed).toBe(true);
    const onDisk = await readSidecar(projectRoot);
    expect(onDisk).toMatchObject({ projectId: sidecar.projectId });
  });

  it('CAS rejects when updatedAt does not match', async () => {
    mkdirSync(join(projectRoot, '.youcoded'));
    writeFileSync(
      join(projectRoot, '.youcoded/artifacts.json'),
      JSON.stringify({ ...sample, updatedAt: '2026-05-22T00:00:00.000Z' })
    );
    const updated = { ...sample, updatedAt: '2026-05-21T15:00:00.000Z' };
    const result = await writeSidecar(projectRoot, sample.updatedAt, updated);
    expect(result.committed).toBe(false);
  });
});
