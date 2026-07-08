// desktop/src/main/sync-spaces/managed-roots.ts
import fs from 'fs';
import os from 'os';
import path from 'path';
import { validateSyncName } from './guards';
import type { SyncSpace } from './types';

export type CreateResult = { ok: true; path: string } | { ok: false; error: string };

/** Owns ~/YouCoded/{Projects,Personal} (spec §3). baseDir is injectable for tests;
 *  production passes os.homedir(). */
export class ManagedRoots {
  readonly youcodedRoot: string;
  readonly projectsRoot: string;
  readonly personalRoot: string;

  constructor(baseDir: string = os.homedir()) {
    this.youcodedRoot = path.join(baseDir, 'YouCoded');
    this.projectsRoot = path.join(this.youcodedRoot, 'Projects');
    this.personalRoot = path.join(this.youcodedRoot, 'Personal');
  }

  ensure(): void {
    fs.mkdirSync(this.projectsRoot, { recursive: true });
    fs.mkdirSync(this.personalRoot, { recursive: true });
  }

  listProjects(): Array<{ name: string; path: string }> {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(this.projectsRoot, { withFileTypes: true }); } catch { return []; }
    return entries
      .filter(e => e.isDirectory())
      .map(e => ({ name: e.name, path: path.join(this.projectsRoot, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  createProject(name: string): CreateResult {
    const err = validateSyncName(name);
    if (err) return { ok: false, error: err };
    const dir = path.join(this.projectsRoot, name);
    if (fs.existsSync(dir)) return { ok: false, error: 'A project with that name already exists' };
    fs.mkdirSync(dir, { recursive: true });
    return { ok: true, path: dir };
  }

  /** Spec §4: one personal space + one space per managed project. */
  spaces(): SyncSpace[] {
    return [
      { id: 'personal', kind: 'personal' as const, root: this.personalRoot },
      ...this.listProjects().map(p => ({ id: `project:${p.name}`, kind: 'project' as const, root: p.path })),
    ];
  }
}
