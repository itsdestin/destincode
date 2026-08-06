import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect } from 'vitest';
import {
  mergeProjectEntries, readProjectRegistry, PROJECT_REGISTRY_SCHEMA,
  type ProjectRegistryEntry,
} from '../src/main/sync-spaces/project-registry';

const base: ProjectRegistryEntry = {
  schemaVersion: PROJECT_REGISTRY_SCHEMA,
  name: 'proj', repoName: 'proj-abc123', displayName: 'proj',
  state: 'active', updatedAt: 0,
  description: null, descriptionUpdatedAt: 0,
};

describe('mergeProjectEntries — description', () => {
  // THE regression this whole design exists to prevent: with a shared clock,
  // device B's description write would carry B's stale displayName and revert
  // device A's rename.
  it('keeps a rename and a description written on different devices', () => {
    const a = { ...base, displayName: 'Renamed', updatedAt: 200 };
    const b = { ...base, description: 'my notes', descriptionUpdatedAt: 300 };
    const m = mergeProjectEntries(a, b);
    expect(m.displayName).toBe('Renamed');
    expect(m.description).toBe('my notes');
  });

  it('is commutative', () => {
    const a = { ...base, displayName: 'Renamed', updatedAt: 200 };
    const b = { ...base, description: 'my notes', descriptionUpdatedAt: 300 };
    expect(mergeProjectEntries(a, b)).toEqual(mergeProjectEntries(b, a));
  });

  it('takes the newer description by its own clock', () => {
    const a = { ...base, description: 'old', descriptionUpdatedAt: 100 };
    const b = { ...base, description: 'new', descriptionUpdatedAt: 200 };
    expect(mergeProjectEntries(a, b).description).toBe('new');
  });

  // stopped-dominance is unchanged and must stay unchanged.
  it('still lets stopped dominate regardless of description clocks', () => {
    const a = { ...base, state: 'stopped' as const, updatedAt: 1 };
    const b = { ...base, description: 'x', descriptionUpdatedAt: 999 };
    expect(mergeProjectEntries(a, b).state).toBe('stopped');
  });
});

// THE schema trap, pinned. parseEntry is module-private, so this goes through
// readProjectRegistry against a real temp dir — which is also the honest test,
// since fail-soft-skip happens at the read layer.
describe('readProjectRegistry — records written by an older build', () => {
  it('reads a record that has no description instead of skipping it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
    const projectSync = path.join(dir, 'ProjectSync');
    fs.mkdirSync(projectSync, { recursive: true });
    // Exactly what a pre-description build writes: schema 1, no description keys.
    fs.writeFileSync(path.join(projectSync, 'proj.json'), JSON.stringify({
      schemaVersion: 1, name: 'proj', repoName: 'proj-abc123',
      displayName: 'Proj', state: 'active', updatedAt: 5,
    }));
    const out = readProjectRegistry(dir);
    expect(out).toHaveLength(1);           // NOT skipped
    expect(out[0].displayName).toBe('Proj');
    expect(out[0].description).toBeNull();
    expect(out[0].descriptionUpdatedAt).toBe(0);
  });

  it('caps an over-long description at read time', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reg-'));
    const projectSync = path.join(dir, 'ProjectSync');
    fs.mkdirSync(projectSync, { recursive: true });
    fs.writeFileSync(path.join(projectSync, 'proj.json'), JSON.stringify({
      schemaVersion: 1, name: 'proj', repoName: 'proj-abc123',
      displayName: 'Proj', state: 'active', updatedAt: 5,
      description: 'x'.repeat(500), descriptionUpdatedAt: 9,
    }));
    expect(readProjectRegistry(dir)[0].description).toHaveLength(200);
  });
});
