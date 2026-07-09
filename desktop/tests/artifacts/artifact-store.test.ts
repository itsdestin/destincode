import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readSidecar, writeSidecar, appendVersion, removeArtifactRecord } from '../../src/main/artifacts/artifact-store';
import type { ProjectSidecar } from '../../src/shared/artifacts/types';
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

describe('appendVersion', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'as-append-'));
  });

  it('creates a new artifact when path is unseen', async () => {
    await appendVersion(projectRoot, sample.projectId, sample.name, {
      path: 'docs/new.md',
      kind: 'internal',
      absolutePath: null,
      sessionId: 'sess-1',
      type: 'create',
      author: 'agent',
    });
    const sidecar = await readSidecar(projectRoot);
    expect((sidecar as ProjectSidecar).artifacts[0].path).toBe('docs/new.md');
    expect((sidecar as ProjectSidecar).artifacts[0].versions).toHaveLength(1);
  });

  it('appends a version to an existing artifact', async () => {
    await appendVersion(projectRoot, sample.projectId, sample.name, {
      path: 'docs/x.md', kind: 'internal', absolutePath: null,
      sessionId: 'sess-1', type: 'create', author: 'agent',
    });
    await appendVersion(projectRoot, sample.projectId, sample.name, {
      path: 'docs/x.md', kind: 'internal', absolutePath: null,
      sessionId: 'sess-1', type: 'edit', author: 'agent',
    });
    const sidecar = await readSidecar(projectRoot);
    expect((sidecar as ProjectSidecar).artifacts).toHaveLength(1);
    expect((sidecar as ProjectSidecar).artifacts[0].versions).toHaveLength(2);
  });

  it('retries on CAS conflict up to MAX_RETRIES', async () => {
    await appendVersion(projectRoot, sample.projectId, sample.name, {
      path: 'a.md', kind: 'internal', absolutePath: null,
      sessionId: 's', type: 'create', author: 'agent',
    });
    const [r1, r2] = await Promise.all([
      appendVersion(projectRoot, sample.projectId, sample.name, {
        path: 'b.md', kind: 'internal', absolutePath: null,
        sessionId: 's', type: 'create', author: 'agent',
      }),
      appendVersion(projectRoot, sample.projectId, sample.name, {
        path: 'c.md', kind: 'internal', absolutePath: null,
        sessionId: 's', type: 'create', author: 'agent',
      }),
    ]);
    expect(r1.committed).toBe(true);
    expect(r2.committed).toBe(true);
    const sidecar = await readSidecar(projectRoot) as ProjectSidecar;
    expect(sidecar.artifacts).toHaveLength(3);
  });
});

describe('appendVersion — read semantics + artifact id', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'as-read-sem-'));
  });

  it('returns the artifact id (new and existing records)', async () => {
    const first = await appendVersion(projectRoot, 'p1', 'proj', {
      path: 'a.md', kind: 'internal', absolutePath: null,
      sessionId: 's', type: 'create', author: 'agent',
    });
    expect(first.artifactId).toBeTruthy();
    const second = await appendVersion(projectRoot, 'p1', 'proj', {
      path: 'a.md', kind: 'internal', absolutePath: null,
      sessionId: 's', type: 'edit', author: 'agent',
    });
    // Same record → same id (this id feeds the artifacts:changed broadcast the
    // edit-conflict banner matches on).
    expect(second.artifactId).toBe(first.artifactId);
  });

  it("a 'read' version does NOT bump lastModified on an existing record", async () => {
    await appendVersion(projectRoot, 'p1', 'proj', {
      path: 'a.md', kind: 'internal', absolutePath: null,
      sessionId: 's', type: 'edit', author: 'agent',
    });
    const before = (await readSidecar(projectRoot)) as ProjectSidecar;
    const stamp = before.artifacts[0].lastModified;
    await new Promise((r) => setTimeout(r, 5));
    await appendVersion(projectRoot, 'p1', 'proj', {
      path: 'a.md', kind: 'internal', absolutePath: null,
      sessionId: 's2', type: 'read', author: 'user',
    });
    const after = (await readSidecar(projectRoot)) as ProjectSidecar;
    expect(after.artifacts[0].lastModified).toBe(stamp);   // unchanged — a view is not a modification
    expect(after.artifacts[0].versions).toHaveLength(2);   // the read IS still recorded
  });
});

describe('removeArtifactRecord', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'as-remove-'));
  });

  it('removes the tracking record (never touches disk files)', async () => {
    const { artifactId } = await appendVersion(projectRoot, 'p1', 'proj', {
      path: 'a.md', kind: 'internal', absolutePath: null,
      sessionId: 's', type: 'create', author: 'agent',
    });
    const res = await removeArtifactRecord(projectRoot, artifactId!);
    expect(res.ok).toBe(true);
    const sidecar = (await readSidecar(projectRoot)) as ProjectSidecar;
    expect(sidecar.artifacts).toHaveLength(0);
  });

  it('reports artifact-not-found for unknown ids', async () => {
    await appendVersion(projectRoot, 'p1', 'proj', {
      path: 'a.md', kind: 'internal', absolutePath: null,
      sessionId: 's', type: 'create', author: 'agent',
    });
    const res = await removeArtifactRecord(projectRoot, 'nope');
    expect(res).toEqual({ ok: false, error: 'artifact-not-found' });
  });
});
