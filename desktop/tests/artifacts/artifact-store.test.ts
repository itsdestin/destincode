import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { readSidecar, writeSidecar, appendVersion, removeArtifactRecord, runSidecarMigration } from '../../src/main/artifacts/artifact-store';
import type { ProjectSidecar } from '../../src/shared/artifacts/types';
import { SIDECAR_SCHEMA_VERSION } from '../../src/shared/artifacts/types';
import sample from '../../../shared-fixtures/artifacts/sample-sidecar.json';

// The 60-iteration concurrency loop below does real fs work (mkdtemp, fsync,
// rename, rm x60) and takes ~1.3s locally — under vitest's default 5000ms
// testTimeout, but only ~4x headroom, and fs work is exactly what inflates
// under a loaded parallel pool. Bounding the file explicitly keeps this PR from
// trading one load-dependent budget for another.
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

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

  // Pins the same-millisecond CAS ABA fix. The single-shot case above only
  // caught it ~1 run in 3 (it needs both writes inside one millisecond), which
  // read as a flaky test for months; at 60 iterations the old code loses a
  // record essentially every run. If this ever goes red again, a writer is
  // producing an updatedAt that does NOT advance past the value it read.
  it('concurrent appends never lose a record (same-millisecond CAS)', async () => {
    for (let i = 0; i < 60; i++) {
      const root = mkdtempSync(join(tmpdir(), 'as-aba-'));
      await appendVersion(root, sample.projectId, sample.name, {
        path: 'a.md', kind: 'internal', absolutePath: null,
        sessionId: 's', type: 'create', author: 'agent',
      });
      await Promise.all([
        appendVersion(root, sample.projectId, sample.name, {
          path: 'b.md', kind: 'internal', absolutePath: null,
          sessionId: 's', type: 'create', author: 'agent',
        }),
        appendVersion(root, sample.projectId, sample.name, {
          path: 'c.md', kind: 'internal', absolutePath: null,
          sessionId: 's', type: 'create', author: 'agent',
        }),
      ]);
      const s = await readSidecar(root) as ProjectSidecar;
      expect(s.artifacts.map((a) => a.path).sort()).toEqual(['a.md', 'b.md', 'c.md']);
      // 60 iterations x every run x CI — clean up rather than leak temp dirs.
      rmSync(root, { recursive: true, force: true });
    }
  });

  // The invariant the fix rests on, asserted directly: a committed write always
  // leaves a token strictly greater than the one the writer read. Without this,
  // a concurrent reader holding the old token passes CAS on stale data.
  it('a committed write always advances updatedAt past the expected token', async () => {
    await appendVersion(projectRoot, sample.projectId, sample.name, {
      path: 'a.md', kind: 'internal', absolutePath: null,
      sessionId: 's', type: 'create', author: 'agent',
    });
    const before = (await readSidecar(projectRoot)) as ProjectSidecar;
    // Same-millisecond write: hand back a timestamp that has NOT moved.
    const next = { ...before, updatedAt: before.updatedAt };
    const res = await writeSidecar(projectRoot, before.updatedAt, next);
    expect(res.committed).toBe(true);
    const after = (await readSidecar(projectRoot)) as ProjectSidecar;
    expect(after.updatedAt > before.updatedAt).toBe(true);
    // The in-memory object the caller still holds matches disk.
    expect(next.updatedAt).toBe(after.updatedAt);
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

describe('runSidecarMigration', () => {
  let projectRoot: string;
  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'as-migrate-'));
    mkdirSync(join(projectRoot, '.youcoded'), { recursive: true });
  });
  afterEach(() => rmSync(projectRoot, { recursive: true, force: true }));

  const legacy = () => ({
    $schema: SIDECAR_SCHEMA_VERSION, projectId: 'p', name: 'proj',
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-07-01T00:00:00.000Z',
    artifacts: [{
      id: 'art_A', path: 'play.html', kind: 'external' as const,
      absolutePath: 'flappy-bird/play.html',
      lastModified: '2026-08-13T00:00:00.000Z', status: 'active' as const,
      versions: [], comments: [], tags: [],
    }],
    manualExcludes: [], manualIncludes: [],
  });

  it('repairs relative externals and is a no-op on the second call', async () => {
    await writeSidecar(projectRoot, null, legacy() as any);

    const first = await runSidecarMigration(projectRoot);
    expect(first).toMatchObject({ migrated: true, reclassified: 1, merged: 0 });

    const after = await readSidecar(projectRoot) as ProjectSidecar;
    expect(after.artifacts[0]).toMatchObject({
      path: 'flappy-bird/play.html', kind: 'internal', absolutePath: null,
    });

    // Both calls share this test's projectRoot AND this test's module instance,
    // so the first call's `migrationChecked.add(projectRoot)` is still warm here
    // — this second call short-circuits on the MEMO, before readSidecar ever
    // runs. That's cheap and worth pinning (repeat calls in one process should
    // not re-scan), but it proves nothing about the production run-once gate
    // (`reclassified === 0` from the pure migration). See the next test for that.
    const second = await runSidecarMigration(projectRoot);
    expect(second).toMatchObject({ migrated: false, reclassified: 0 });
    const unchanged = await readSidecar(projectRoot) as ProjectSidecar;
    expect(unchanged.updatedAt).toBe(after.updatedAt);   // it did not rewrite
  });

  // The test above cannot reach the real gate: same process + same projectRoot
  // means the memo is always warm on the second call. This test forces a COLD
  // memo — via vi.resetModules() + a dynamic re-import, which re-evaluates
  // artifact-store.ts and so constructs a brand new, empty `migrationChecked`
  // Set — and re-runs the migration against the already-repaired sidecar on
  // disk. If this ever regresses to relying on the memo, a peer device that
  // wrote a fresh relative-external record after this process's memo was
  // populated would never get it repaired; if it regresses to re-writing
  // unconditionally, every LIST_SESSION call would rewrite the sidecar.
  it('declines to rewrite an already-repaired sidecar even with a cold memo', async () => {
    await writeSidecar(projectRoot, null, legacy() as any);
    await runSidecarMigration(projectRoot);
    const after = await readSidecar(projectRoot) as ProjectSidecar;

    vi.resetModules();
    const fresh = await import('../../src/main/artifacts/artifact-store');
    const second = await fresh.runSidecarMigration(projectRoot);
    expect(second).toEqual({ migrated: false, reclassified: 0, merged: 0 });

    const unchanged = await readSidecar(projectRoot) as ProjectSidecar;
    expect(unchanged.updatedAt).toBe(after.updatedAt);   // genuinely declined to rewrite
  });

  it('does not write, or back up, a sidecar with nothing to repair', async () => {
    const clean = legacy();
    clean.artifacts[0] = { ...clean.artifacts[0], kind: 'internal' as any, absolutePath: null };
    await writeSidecar(projectRoot, null, clean as any);

    const res = await runSidecarMigration(projectRoot);
    expect(res.migrated).toBe(false);
    expect(readdirSync(join(projectRoot, '.youcoded')).filter((f) => f.includes('.bak'))).toHaveLength(0);
  });

  // Pins the FIXED backup name (not one file per attempt). The second
  // migration call in the old version of this test was a memo short-circuit —
  // it never reached the copyFile/EEXIST branch a second time — so it proved
  // nothing beyond what one call already does; calling once is honest about
  // what's being checked.
  it('backs the sidecar up under a fixed name before rewriting it', async () => {
    await writeSidecar(projectRoot, null, legacy() as any);
    await runSidecarMigration(projectRoot);
    const backups = readdirSync(join(projectRoot, '.youcoded'))
      .filter((f) => f.startsWith('artifacts.json.pre-migration'));
    expect(backups).toEqual(['artifacts.json.pre-migration.bak']);
  });

  // The backup is the only way back from a bad migration, so it must protect
  // the OLDEST copy — a retry (or a second window racing the same repair)
  // must never clobber it with already-half-migrated state. Pre-creating the
  // backup file with a sentinel and asserting the sentinel survives is what
  // actually exercises the COPYFILE_EXCL + swallowed-EEXIST branch; without
  // COPYFILE_EXCL (a plain copyFile) this test fails because the sentinel
  // gets overwritten.
  it('never overwrites an existing backup', async () => {
    await writeSidecar(projectRoot, null, legacy() as any);
    const backupPath = join(projectRoot, '.youcoded/artifacts.json.pre-migration.bak');
    writeFileSync(backupPath, 'SENTINEL-PRE-EXISTING-BACKUP');

    const res = await runSidecarMigration(projectRoot);
    expect(res.migrated).toBe(true);   // migration itself still proceeds
    expect(readFileSync(backupPath, 'utf8')).toBe('SENTINEL-PRE-EXISTING-BACKUP');
  });
});
