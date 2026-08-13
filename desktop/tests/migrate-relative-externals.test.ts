import { describe, it, expect } from 'vitest';
import { migrateRelativeExternals } from '../src/shared/artifacts/migrate-relative-externals';
import { SIDECAR_SCHEMA_VERSION } from '../src/shared/artifacts/types';
import type { ProjectSidecar, ArtifactRecord } from '../src/shared/artifacts/types';

const ROOT = '/home/desti/youcoded-dev';

function rec(over: Partial<ArtifactRecord>): ArtifactRecord {
  return {
    id: 'art_0000000000000000000000',
    path: 'x.md', kind: 'internal', absolutePath: null,
    lastModified: '2026-08-01T00:00:00.000Z', status: 'active',
    versions: [], comments: [], tags: [],
    ...over,
  };
}

function sidecar(artifacts: ArtifactRecord[]): ProjectSidecar {
  return {
    $schema: SIDECAR_SCHEMA_VERSION, projectId: 'p', name: 'proj',
    createdAt: '2026-07-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
    artifacts, manualExcludes: [], manualIncludes: [],
  };
}

describe('migrateRelativeExternals', () => {
  it('reclassifies a relative external to internal with the full relative path', () => {
    // NOTE: external records store the BASENAME in `path` and the real path in
    // `absolutePath`. Both fields must change together — nulling absolutePath
    // while leaving path='play.html' would yield join(root,'play.html'), which
    // does not exist, turning a false orphan into a real one.
    const res = migrateRelativeExternals(sidecar([
      rec({ id: 'art_A', path: 'play.html', kind: 'external', absolutePath: 'flappy-bird/play.html' }),
    ]), ROOT);
    expect(res.reclassified).toBe(1);
    expect(res.merged).toBe(0);
    expect(res.sidecar.artifacts[0]).toMatchObject({
      id: 'art_A', path: 'flappy-bird/play.html', kind: 'internal', absolutePath: null,
    });
  });

  it('remaps a cross-device Windows path that contains the project-root segment', () => {
    const res = migrateRelativeExternals(sidecar([
      rec({ id: 'art_A', path: 'PITFALLS.md', kind: 'external',
            absolutePath: 'C:/Users/desti/youcoded-dev/docs/PITFALLS.md' }),
    ]), ROOT);
    expect(res.sidecar.artifacts[0]).toMatchObject({
      path: 'docs/PITFALLS.md', kind: 'internal', absolutePath: null,
    });
  });

  it('LEAVES ALONE a Windows path outside any project root', () => {
    // 8 of the 40 legacy records look like this. They are correctly external
    // and correctly unavailable on Linux; reclassifying them would invent a
    // phantom in-project file.
    const original = rec({ id: 'art_A', path: 'paste.png', kind: 'external',
      absolutePath: 'C:/Users/desti/AppData/Local/Temp/attachments/paste.png' });
    const res = migrateRelativeExternals(sidecar([original]), ROOT);
    expect(res.reclassified).toBe(0);
    expect(res.sidecar.artifacts[0]).toEqual(original);
  });

  it('leaves a genuine POSIX-absolute external alone', () => {
    const original = rec({ id: 'art_A', path: 'flappy.html', kind: 'external',
      absolutePath: '/tmp/scratchpad/flappy.html' });
    const res = migrateRelativeExternals(sidecar([original]), ROOT);
    expect(res.reclassified).toBe(0);
    expect(res.sidecar.artifacts[0]).toEqual(original);
  });

  it('leaves a .. escape external — the harness really did write outside the root', () => {
    const original = rec({ id: 'art_A', path: 'notes.md', kind: 'external',
      absolutePath: '../other/notes.md' });
    const res = migrateRelativeExternals(sidecar([original]), ROOT);
    expect(res.reclassified).toBe(0);
    expect(res.sidecar.artifacts[0]).toEqual(original);
  });

  it('MERGES into an existing internal twin instead of creating a duplicate', () => {
    // 10 of the 18 real records hit this path. A plain field rewrite would
    // leave two internal records at the same path with split histories.
    //
    // Fix: the brief's fixture used the literal ids 'art_OLD'/'art_NEW', but
    // 'art_OLD' > 'art_NEW' lexicographically ('O' > 'N') — the OPPOSITE of
    // the "lexicographically smaller id is older" rule this test exists to
    // exercise. Run verbatim, the reference implementation picks 'art_NEW' as
    // older and the test's own `expect(m.id).toBe('art_OLD')` fails. Renamed
    // to 'art_1_OLD'/'art_2_NEW' so the ids actually encode the order the
    // test's comments and dates (2026-07-25 vs 2026-08-13) describe; no other
    // change.
    const res = migrateRelativeExternals(sidecar([
      rec({ id: 'art_1_OLD', path: 'ROADMAP.md', kind: 'internal', absolutePath: null,
            lastModified: '2026-07-25T00:00:00.000Z',
            versions: [{ id: 'v1', ts: '2026-07-25T00:00:00.000Z', sessionId: 's1', type: 'create', author: 'agent' }],
            tags: ['plan'] }),
      rec({ id: 'art_2_NEW', path: 'ROADMAP.md', kind: 'external', absolutePath: 'ROADMAP.md',
            lastModified: '2026-08-13T00:00:00.000Z',
            versions: [{ id: 'v2', ts: '2026-08-13T00:00:00.000Z', sessionId: 's2', type: 'edit', author: 'agent' }],
            tags: ['roadmap'] }),
    ]), ROOT);

    expect(res.merged).toBe(1);
    expect(res.sidecar.artifacts).toHaveLength(1);
    const m = res.sidecar.artifacts[0];
    expect(m.id).toBe('art_1_OLD');                     // older record survives
    expect(m.kind).toBe('internal');
    expect(m.versions.map((v) => v.id)).toEqual(['v1', 'v2']);   // history preserved, ts-sorted
    expect(m.lastModified).toBe('2026-08-13T00:00:00.000Z');     // later of the two
    expect(m.tags.sort()).toEqual(['plan', 'roadmap']);          // unioned
  });

  it('merges two relative externals that resolve to the same path', () => {
    const res = migrateRelativeExternals(sidecar([
      rec({ id: 'art_B', path: 'notes.md', kind: 'external', absolutePath: 'docs/notes.md',
            versions: [{ id: 'v2', ts: '2026-08-02T00:00:00.000Z', sessionId: 's', type: 'edit', author: 'agent' }] }),
      rec({ id: 'art_A', path: 'notes.md', kind: 'external', absolutePath: './docs/notes.md',
            versions: [{ id: 'v1', ts: '2026-08-01T00:00:00.000Z', sessionId: 's', type: 'create', author: 'agent' }] }),
    ]), ROOT);
    expect(res.sidecar.artifacts).toHaveLength(1);
    expect(res.sidecar.artifacts[0].id).toBe('art_A');
    expect(res.sidecar.artifacts[0].versions.map((v) => v.id)).toEqual(['v1', 'v2']);
  });

  it('dedupes version ids so a re-run cannot duplicate history', () => {
    const shared = { id: 'v1', ts: '2026-08-01T00:00:00.000Z', sessionId: 's', type: 'create' as const, author: 'agent' as const };
    const res = migrateRelativeExternals(sidecar([
      rec({ id: 'art_A', path: 'a.md', kind: 'internal', absolutePath: null, versions: [shared] }),
      rec({ id: 'art_B', path: 'a.md', kind: 'external', absolutePath: 'a.md', versions: [shared] }),
    ]), ROOT);
    expect(res.sidecar.artifacts[0].versions).toHaveLength(1);
  });

  // THE RUN-ONCE GATE. Task 5 writes only when reclassified > 0, so this test is
  // load-bearing for "safe to call on every project open", not a nicety.
  it('is idempotent — a second run reclassifies nothing and changes nothing', () => {
    const once = migrateRelativeExternals(sidecar([
      rec({ id: 'art_A', path: 'play.html', kind: 'external', absolutePath: 'flappy-bird/play.html' }),
    ]), ROOT);
    const twice = migrateRelativeExternals(once.sidecar, ROOT);
    expect(twice.reclassified).toBe(0);
    expect(twice.merged).toBe(0);
    expect(twice.sidecar).toEqual(once.sidecar);
  });

  it('does not mutate the input sidecar', () => {
    const input = sidecar([
      rec({ id: 'art_A', path: 'play.html', kind: 'external', absolutePath: 'flappy-bird/play.html' }),
    ]);
    const snapshot = JSON.parse(JSON.stringify(input));
    migrateRelativeExternals(input, ROOT);
    expect(input).toEqual(snapshot);
  });

  it('recomputes status from the latest version after a merge', () => {
    const res = migrateRelativeExternals(sidecar([
      rec({ id: 'art_A', path: 'gone.md', kind: 'internal', absolutePath: null, status: 'active',
            versions: [{ id: 'v1', ts: '2026-08-01T00:00:00.000Z', sessionId: 's', type: 'create', author: 'agent' }] }),
      rec({ id: 'art_B', path: 'gone.md', kind: 'external', absolutePath: 'gone.md', status: 'deleted',
            versions: [{ id: 'v2', ts: '2026-08-05T00:00:00.000Z', sessionId: 's', type: 'delete', author: 'agent' }] }),
    ]), ROOT);
    expect(res.sidecar.artifacts[0].status).toBe('deleted');
  });
});
