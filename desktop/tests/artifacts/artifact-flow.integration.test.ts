import { describe, expect, it, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { appendVersion, readSidecar } from '../../src/main/artifacts/artifact-store';
import { ensureProject } from '../../src/main/artifacts/project-manager';
import type { ProjectSidecar } from '../../src/shared/artifacts/types';

describe('artifact flow', () => {
  let claudeDir: string;
  let projectRoot: string;
  beforeEach(() => {
    claudeDir = mkdtempSync(join(tmpdir(), 'flow-c-'));
    projectRoot = mkdtempSync(join(tmpdir(), 'flow-p-'));
  });

  it('end-to-end: ensure → append create → append edit → read sidecar', async () => {
    const { project } = await ensureProject(claudeDir, projectRoot, 'sess-1');
    await appendVersion(projectRoot, project.id, project.name, {
      path: 'docs/foo.md', kind: 'internal', absolutePath: null,
      sessionId: 'sess-1', type: 'create', author: 'agent',
    });
    await appendVersion(projectRoot, project.id, project.name, {
      path: 'docs/foo.md', kind: 'internal', absolutePath: null,
      sessionId: 'sess-1', type: 'edit', author: 'agent',
    });
    const sidecar = await readSidecar(projectRoot);
    expect((sidecar as ProjectSidecar).artifacts).toHaveLength(1);
    expect((sidecar as ProjectSidecar).artifacts[0].versions).toHaveLength(2);
    expect((sidecar as ProjectSidecar).artifacts[0].versions[0].type).toBe('create');
    expect((sidecar as ProjectSidecar).artifacts[0].versions[1].type).toBe('edit');
    expect((sidecar as ProjectSidecar).artifacts[0].status).toBe('active');
  });

  it('end-to-end with delete: status flips to deleted', async () => {
    const { project } = await ensureProject(claudeDir, projectRoot, 'sess-1');
    await appendVersion(projectRoot, project.id, project.name, {
      path: 'docs/foo.md', kind: 'internal', absolutePath: null,
      sessionId: 'sess-1', type: 'create', author: 'agent',
    });
    await appendVersion(projectRoot, project.id, project.name, {
      path: 'docs/foo.md', kind: 'internal', absolutePath: null,
      sessionId: 'sess-1', type: 'delete', author: 'agent',
    });
    const sidecar = await readSidecar(projectRoot) as ProjectSidecar;
    expect(sidecar.artifacts).toHaveLength(1); // not removed, just status-flipped
    expect(sidecar.artifacts[0].status).toBe('deleted');
    expect(sidecar.artifacts[0].versions).toHaveLength(2);
  });

  it('multi-session: two sessions writing to same file create one artifact', async () => {
    const { project } = await ensureProject(claudeDir, projectRoot, 'sess-1');
    await appendVersion(projectRoot, project.id, project.name, {
      path: 'shared.md', kind: 'internal', absolutePath: null,
      sessionId: 'sess-1', type: 'create', author: 'agent',
    });
    await appendVersion(projectRoot, project.id, project.name, {
      path: 'shared.md', kind: 'internal', absolutePath: null,
      sessionId: 'sess-2', type: 'edit', author: 'agent',
    });
    const sidecar = await readSidecar(projectRoot) as ProjectSidecar;
    expect(sidecar.artifacts).toHaveLength(1);
    expect(sidecar.artifacts[0].versions[0].sessionId).toBe('sess-1');
    expect(sidecar.artifacts[0].versions[1].sessionId).toBe('sess-2');
  });
});
