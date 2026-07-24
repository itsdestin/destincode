import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// Project View dropped "Show deleted" on 2026-07-23 (deleted records carry no
// content — VersionEvent has no content field — so they were tombstones, not a
// recovery path). The SESSION drawer keeps it: seeing everything Claude did in a
// session, deletions included, is that view's whole purpose. A cleanup pass that
// removes the now-"unused" flag would silently break it and drop a synced pref.
const read = (p: string) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');

describe('showDeletedArtifacts survives the project-view merge', () => {
  it('is still consumed by SessionDrawer', () => {
    expect(read('src/renderer/components/SessionDrawer.tsx')).toContain('showDeletedArtifacts');
  });

  it('is still persisted as a synced appearance preference', () => {
    const ctx = read('src/renderer/state/theme-context.tsx');
    expect(ctx).toContain('showDeletedArtifacts');
    expect(ctx).toContain('persistAppearance({ showDeletedArtifacts');
  });

  it('is gone from project view', () => {
    expect(read('src/renderer/components/project-view/ProjectView.tsx')).not.toContain('showDeletedArtifacts');
    expect(read('src/renderer/components/project-view/tabs/FilesTab.tsx')).not.toContain('showDeletedArtifacts');
  });
});
