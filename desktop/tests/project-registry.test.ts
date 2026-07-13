// desktop/tests/project-registry.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  readProjectRegistry, ensureProjectEntry, setProjectDisplayName, setProjectStopped,
  mergeProjectEntries, PROJECT_REGISTRY_SCHEMA, type ProjectRegistryEntry,
} from '../src/main/sync-spaces/project-registry';

let personal: string;
beforeEach(() => { personal = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-preg-')); });
afterEach(() => { fs.rmSync(personal, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); });

const dir = () => path.join(personal, 'ProjectSync');
const write = (file: string, obj: unknown) => {
  fs.mkdirSync(dir(), { recursive: true });
  fs.writeFileSync(path.join(dir(), file), JSON.stringify(obj));
};
const E = (over: Partial<ProjectRegistryEntry>): ProjectRegistryEntry => ({
  schemaVersion: PROJECT_REGISTRY_SCHEMA, name: 'app', repoName: 'r-app',
  displayName: 'app', state: 'active', updatedAt: 1, ...over,
});

describe('project registry store — I/O', () => {
  it('ensureProjectEntry creates a visible ProjectSync/<name>.json (active, displayName=name)', () => {
    ensureProjectEntry(personal, { name: 'app', repoName: 'r-app' });
    expect(fs.existsSync(path.join(dir(), 'app.json'))).toBe(true);
    const got = readProjectRegistry(personal);
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ name: 'app', repoName: 'r-app', displayName: 'app', state: 'active' });
  });

  it('ensureProjectEntry is create-if-absent — never clobbers an existing rename/stop', () => {
    ensureProjectEntry(personal, { name: 'app', repoName: 'r-app' });
    write('app.json', E({ displayName: 'Cool App', state: 'stopped', updatedAt: 50 }));
    ensureProjectEntry(personal, { name: 'app', repoName: 'r-app' }); // must NOT reset
    const got = readProjectRegistry(personal)[0];
    expect(got.displayName).toBe('Cool App');
    expect(got.state).toBe('stopped');
  });

  it('returns [] when the registry dir does not exist', () => {
    expect(readProjectRegistry(personal)).toEqual([]);
  });

  it('skips corrupt / unknown-schema files without throwing', () => {
    ensureProjectEntry(personal, { name: 'good', repoName: 'r' });
    fs.writeFileSync(path.join(dir(), 'bad.json'), '{ not json');
    write('future.json', { schemaVersion: 999, name: 'future', repoName: 'r' });
    expect(readProjectRegistry(personal).map(e => e.name).sort()).toEqual(['good']);
  });

  it('setProjectDisplayName updates displayName + bumps updatedAt, preserving state', async () => {
    write('app.json', E({ state: 'stopped', updatedAt: 5 }));
    await setProjectDisplayName(personal, 'app', 'r-app', 'Renamed');
    const got = readProjectRegistry(personal)[0];
    expect(got.displayName).toBe('Renamed');
    expect(got.state).toBe('stopped'); // preserved
    expect(got.updatedAt).toBeGreaterThan(5);
  });

  it('setProjectStopped tombstones, preserving displayName', async () => {
    write('app.json', E({ displayName: 'Cool', updatedAt: 5 }));
    await setProjectStopped(personal, 'app', 'r-app');
    const got = readProjectRegistry(personal)[0];
    expect(got.state).toBe('stopped');
    expect(got.displayName).toBe('Cool');
  });

  it('folds conflict copies on read — stopped dominates regardless of updatedAt', () => {
    // Canonical says active/newer; a remote-wins conflict copy says stopped/older.
    write('app.json', E({ displayName: 'A', state: 'active', updatedAt: 100 }));
    write('app (from laptop, 2026-07-13).json', E({ displayName: 'A', state: 'stopped', updatedAt: 5 }));
    const got = readProjectRegistry(personal);
    expect(got).toHaveLength(1);           // folded into one
    expect(got[0].state).toBe('stopped');  // tombstone dominates the newer active
  });

  it('folds conflict copies on read — displayName is last-writer-wins', () => {
    write('app.json', E({ displayName: 'Old', updatedAt: 10 }));
    write('app (from laptop, 2026-07-13).json', E({ displayName: 'New', updatedAt: 20 }));
    expect(readProjectRegistry(personal)[0].displayName).toBe('New');
  });
});

describe('project registry store — pure merge', () => {
  it('mergeProjectEntries is commutative for state + displayName', () => {
    const a = E({ state: 'active', displayName: 'X', updatedAt: 3 });
    const b = E({ state: 'stopped', displayName: 'Y', updatedAt: 9 });
    const ab = mergeProjectEntries(a, b);
    const ba = mergeProjectEntries(b, a);
    expect(ab).toEqual(ba);
    expect(ab.state).toBe('stopped');     // dominates
    expect(ab.displayName).toBe('Y');     // updatedAt 9 wins
  });
});
