// openFilepath is the ONE resolve-and-open path shared by FilepathToken clicks
// and the deliverable auto-open (src/renderer/hooks/useOpenFilepath.ts). This
// pins two live-tested fixes:
//
// 1. `drawerOpensImmediately` (default true = today's exact click behaviour):
//    a click gets DRAWER_OPENED dispatched up front for instant feedback even
//    while the lookup is still in flight. An auto-open nobody clicked gets no
//    such benefit — opening early there just shows an empty/list-only panel
//    for however long the lookup takes. Passing `{ drawerOpensImmediately:
//    false }` defers DRAWER_OPENED until a match is actually found (dispatched
//    right before the ACTIVE_ARTIFACT_SET for that match), and dispatches
//    NOTHING on a miss — the user didn't ask for this, so a silent no-op beats
//    a panel popping open onto an error about a file they never clicked.
// 2. Step 2 (whole-project resolve) now awaits the cheap tracked-list lookup
//    FIRST and only pays for the full-disk scan (listAllFiles) on a miss —
//    see the WHY comment at the call site for the measured 4s cost of doing
//    both in parallel on a large workspace.
import { describe, it, expect, vi } from 'vitest';
import { openFilepath } from '../src/renderer/hooks/useOpenFilepath';
import type { ArtifactState } from '../src/renderer/state/artifact-tracker';
import type { ArtifactAction } from '../src/renderer/state/artifact-actions';
import type { ArtifactRecord } from '../src/shared/artifacts/types';

function makeState(overrides: Partial<ArtifactState> = {}): ArtifactState {
  return {
    sessionArtifacts: {},
    sessionCwd: {},
    ...overrides,
  } as ArtifactState;
}

function makeCtx(state: ArtifactState) {
  const dispatched: ArtifactAction[] = [];
  const dispatch = (action: ArtifactAction) => dispatched.push(action);
  return { ctx: { state, dispatch }, dispatched };
}

function record(id: string, path: string): ArtifactRecord {
  return {
    id,
    kind: 'internal',
    path,
    absolutePath: null,
  } as unknown as ArtifactRecord;
}

function installClaudeArtifacts(stubs: {
  listProject?: (cwd: string) => Promise<any>;
  listAllFiles?: (cwd: string) => Promise<any>;
  listSession?: (sessionId: string, cwd: string) => Promise<any>;
  appendVersion?: (cwd: string, sessionId: string, args: any) => Promise<any>;
}) {
  const listProject = vi.fn(stubs.listProject ?? (async () => ({ ok: true, artifacts: [] })));
  const listAllFiles = vi.fn(stubs.listAllFiles ?? (async () => ({ ok: true, files: [] })));
  const listSession = vi.fn(stubs.listSession ?? (async () => ({ ok: true, artifacts: [] })));
  const appendVersion = vi.fn(stubs.appendVersion ?? (async () => ({ ok: true })));
  (globalThis as any).window = {
    ...(globalThis as any).window,
    claude: {
      artifacts: { listProject, listAllFiles, listSession, appendVersion },
    },
  };
  return { listProject, listAllFiles, listSession, appendVersion };
}

describe('openFilepath — default mode (click behaviour) is unchanged', () => {
  it('dispatches DRAWER_OPENED before the lookup resolves', async () => {
    let resolveProject!: (v: any) => void;
    installClaudeArtifacts({
      listProject: () => new Promise((res) => { resolveProject = res; }),
      listAllFiles: async () => ({ ok: true, files: [] }), // reached on the miss path once listProject settles
    });
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    const { ctx, dispatched } = makeCtx(state);

    const p = openFilepath(ctx, 's1', '/proj/a.md');
    // Drawer + error-clear must be synchronous, well before any await settles.
    expect(dispatched.map((a) => a.type)).toEqual(['DRAWER_OPENED', 'PILL_ERROR_CLEARED']);

    resolveProject({ ok: true, artifacts: [] });
    await p;
  });

  it('still dispatches PILL_RESOLVE_FAILED on a total miss (buildArtifactifyArgs rejects the path)', async () => {
    installClaudeArtifacts({
      listProject: async () => ({ ok: true, artifacts: [] }),
      listAllFiles: async () => ({ ok: true, files: [] }),
    });
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    const { ctx, dispatched } = makeCtx(state);

    // buildArtifactifyArgs (filepath-match.ts:80) returns null for ANY path
    // starting with '~', unconditionally — no cwd or session-list matching
    // ambiguity involved. So this fixture always takes the early-return branch
    // at useOpenFilepath.ts's `if (!args) { failed(); return; }`, never the
    // "artifactify ran but the refreshed list has no match" branch below it.
    await openFilepath(ctx, 's1', '~/no-such-file.md');
    expect(dispatched.map((a) => a.type)).toEqual([
      'DRAWER_OPENED',
      'PILL_ERROR_CLEARED',
      'PILL_RESOLVE_FAILED',
    ]);
  });

  it('dispatches PILL_RESOLVE_FAILED when artifactify runs but the refreshed session list still has no match', async () => {
    installClaudeArtifacts({
      listProject: async () => ({ ok: true, artifacts: [] }),
      listAllFiles: async () => ({ ok: true, files: [] }),
      // appendVersion succeeds (default stub), but listSession comes back with
      // nothing findBestMatch can match against the clicked path — the miss
      // branch at useOpenFilepath.ts's `if (added) {...} else if
      // (drawerOpensImmediately) { dispatch(SESSION_ARTIFACTS_LOADED) }`,
      // followed by `if (!selected) failed();`.
      listSession: async () => ({ ok: true, artifacts: [] }),
    });
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', '/proj/orphan.md');
    expect(dispatched.map((a) => a.type)).toEqual([
      'DRAWER_OPENED',
      'PILL_ERROR_CLEARED',
      'SESSION_ARTIFACTS_LOADED',
      'PILL_RESOLVE_FAILED',
    ]);
  });

  it('dispatches SESSION_ARTIFACTS_LOADED then ACTIVE_ARTIFACT_SET on artifactify success', async () => {
    installClaudeArtifacts({
      listProject: async () => ({ ok: true, artifacts: [] }),
      listAllFiles: async () => ({ ok: true, files: [] }),
      // listSession's refreshed list now contains the just-artifactified file
      // (suffix-matched: stored relative as 'new-doc.md', clicked as the
      // absolute '/proj/new-doc.md' — findBestMatch's suffix pass covers this).
      listSession: async () => ({ ok: true, artifacts: [record('art-5', 'new-doc.md')] }),
    });
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', '/proj/new-doc.md');
    expect(dispatched.map((a) => a.type)).toEqual([
      'DRAWER_OPENED',
      'PILL_ERROR_CLEARED',
      'SESSION_ARTIFACTS_LOADED',
      'ACTIVE_ARTIFACT_SET',
    ]);
    expect((dispatched[3] as any).artifactId).toBe('art-5');
  });
});

describe('openFilepath — deferred mode (drawerOpensImmediately: false)', () => {
  it('session-list hit: no dispatch before the match, then DRAWER_OPENED before ACTIVE_ARTIFACT_SET', async () => {
    const state = makeState({
      sessionArtifacts: { s1: [record('art-1', 'a.md')] },
      sessionCwd: { s1: '/proj' },
    });
    installClaudeArtifacts({});
    const { ctx, dispatched } = makeCtx(state);

    expect(dispatched.length).toBe(0); // nothing before the call
    await openFilepath(ctx, 's1', 'a.md', { drawerOpensImmediately: false });
    expect(dispatched.map((a) => a.type)).toEqual(['DRAWER_OPENED', 'ACTIVE_ARTIFACT_SET']);
    expect((dispatched[1] as any).artifactId).toBe('art-1');
  });

  it('project hit (step 2): no dispatch before the match, then DRAWER_OPENED before the upsert/select pair', async () => {
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    installClaudeArtifacts({
      listProject: async () => ({ ok: true, artifacts: [record('art-2', 'b.md')] }),
      listAllFiles: async () => ({ ok: true, files: [] }),
    });
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', 'b.md', { drawerOpensImmediately: false });
    expect(dispatched.map((a) => a.type)).toEqual([
      'DRAWER_OPENED',
      'SESSION_ARTIFACT_UPSERTED',
      'ACTIVE_ARTIFACT_SET',
    ]);
  });

  it('total miss: dispatch is never called at all', async () => {
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    installClaudeArtifacts({
      listProject: async () => ({ ok: true, artifacts: [] }),
      listAllFiles: async () => ({ ok: true, files: [] }),
    });
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', '/proj/nowhere.md', { drawerOpensImmediately: false });
    expect(dispatched.length).toBe(0);
  });

  it('no cwd (immediate failure path): dispatch is never called at all', async () => {
    const state = makeState(); // no sessionCwd entry
    installClaudeArtifacts({});
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', '/proj/x.md', { drawerOpensImmediately: false });
    expect(dispatched.length).toBe(0);
  });

  it('tracked miss (Finding 1 fix): never selects an ephemeral discovered record — listAllFiles is not consulted and the eventual selection is the persisted sidecar id, not the relative-path discovered id', async () => {
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    // listAllFiles is wired to return a DISCOVERED record whose id is the raw
    // relative path (project-file-discovery.ts shape) — exactly the ephemeral
    // record a concurrent tracker refresh would wipe out from under
    // ACTIVE_ARTIFACT_SET. If deferred mode ever falls back to listAllFiles
    // like click mode does, this stub is what it would (wrongly) select.
    const { listAllFiles, listProject, appendVersion } = installClaudeArtifacts({
      listProject: async () => ({ ok: true, artifacts: [] }), // tracked miss
      listAllFiles: async () => ({ ok: true, files: [record('e.md', 'e.md')] }),
      // artifactify's own refresh comes back with a real sidecar id.
      listSession: async () => ({ ok: true, artifacts: [record('art-9', 'e.md')] }),
    });
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', '/proj/e.md', { drawerOpensImmediately: false });

    expect(listProject).toHaveBeenCalledTimes(1);
    // The direct pin on the fix: deferred mode must not even ask the disk-scan
    // question on a tracked miss, since asking it is what produces the
    // ephemeral id in the first place.
    expect(listAllFiles).not.toHaveBeenCalled();
    expect(appendVersion).toHaveBeenCalledTimes(1);
    // The behavioral outcome that matters to the user: whatever got selected
    // is the persisted sidecar id, never the discovered relative-path id.
    const selected = dispatched.find((a) => a.type === 'ACTIVE_ARTIFACT_SET') as any;
    expect(selected?.artifactId).toBe('art-9');
    expect(selected?.artifactId).not.toBe('e.md');
  });

  it('artifactify success: no dispatch before the match, then DRAWER_OPENED, SESSION_ARTIFACTS_LOADED, ACTIVE_ARTIFACT_SET', async () => {
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    installClaudeArtifacts({
      listProject: async () => ({ ok: true, artifacts: [] }),
      listAllFiles: async () => ({ ok: true, files: [] }),
      listSession: async () => ({ ok: true, artifacts: [record('art-6', 'new-doc.md')] }),
    });
    const { ctx, dispatched } = makeCtx(state);

    expect(dispatched.length).toBe(0); // nothing before the call
    await openFilepath(ctx, 's1', '/proj/new-doc.md', { drawerOpensImmediately: false });
    // Deferred mode skips the top-of-function PILL_ERROR_CLEARED entirely (it's
    // inside `if (drawerOpensImmediately)`), and DRAWER_OPENED is dispatched
    // only once the artifactify match is found (useOpenFilepath.ts:
    // `if (!drawerOpensImmediately) dispatch({ type: 'DRAWER_OPENED', ... })`
    // right before SESSION_ARTIFACTS_LOADED/ACTIVE_ARTIFACT_SET in the added-match branch).
    expect(dispatched.map((a) => a.type)).toEqual([
      'DRAWER_OPENED',
      'SESSION_ARTIFACTS_LOADED',
      'ACTIVE_ARTIFACT_SET',
    ]);
    expect((dispatched[2] as any).artifactId).toBe('art-6');
  });
});

describe('openFilepath — step 2 asks the cheap question first (Fix 2)', () => {
  it('tracked hit: listAllFiles is NEVER called', async () => {
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    const { listAllFiles, listProject } = installClaudeArtifacts({
      listProject: async () => ({ ok: true, artifacts: [record('art-3', 'c.md')] }),
      listAllFiles: async () => ({ ok: true, files: [] }),
    });
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', 'c.md');
    expect(listProject).toHaveBeenCalledTimes(1);
    expect(listAllFiles).not.toHaveBeenCalled();
    expect(dispatched.some((a) => a.type === 'ACTIVE_ARTIFACT_SET' && (a as any).artifactId === 'art-3')).toBe(true);
  });

  it('tracked miss: listAllFiles IS called and its match is used', async () => {
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    const { listAllFiles, listProject } = installClaudeArtifacts({
      listProject: async () => ({ ok: true, artifacts: [] }),
      listAllFiles: async () => ({ ok: true, files: [record('art-4', 'd.md')] }),
    });
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', 'd.md');
    expect(listProject).toHaveBeenCalledTimes(1);
    expect(listAllFiles).toHaveBeenCalledTimes(1);
    expect(dispatched.some((a) => a.type === 'ACTIVE_ARTIFACT_SET' && (a as any).artifactId === 'art-4')).toBe(true);
  });
});
