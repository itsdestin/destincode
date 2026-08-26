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

  it('still dispatches PILL_RESOLVE_FAILED on a total miss', async () => {
    installClaudeArtifacts({
      listProject: async () => ({ ok: true, artifacts: [] }),
      listAllFiles: async () => ({ ok: true, files: [] }),
    });
    const state = makeState({ sessionCwd: { s1: '/proj' } });
    const { ctx, dispatched } = makeCtx(state);

    await openFilepath(ctx, 's1', '~/no-such-file.md'); // fails buildArtifactifyArgs too if unresolved home dir
    const types = dispatched.map((a) => a.type);
    expect(types).toContain('DRAWER_OPENED');
    expect(types).toContain('PILL_RESOLVE_FAILED');
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
