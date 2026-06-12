import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Stub homedir BEFORE importing the module under test — it resolves
// ~/.claude/settings.json from os.homedir() at call time.
let tmpHome: string;
let origHomedir: typeof os.homedir;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-retention-'));
  origHomedir = os.homedir;
  (os as any).homedir = () => tmpHome;
});

afterEach(() => {
  (os as any).homedir = origHomedir;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
});

const settingsPath = () => path.join(tmpHome, '.claude', 'settings.json');

async function seed() {
  const mod = await import('../src/main/retention-default');
  return mod.seedCleanupPeriodDefault();
}

describe('seedCleanupPeriodDefault', () => {
  it('writes the default when settings.json does not exist', async () => {
    const r = await seed();
    expect(r.changed).toBe(true);
    const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    expect(written.cleanupPeriodDays).toBe(365);
  });

  it('adds the key without clobbering existing settings', async () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ enabledPlugins: { 'x@y': true }, hooks: { Stop: [] } }));
    const r = await seed();
    expect(r.changed).toBe(true);
    const written = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    expect(written.cleanupPeriodDays).toBe(365);
    expect(written.enabledPlugins).toEqual({ 'x@y': true });
    expect(written.hooks).toEqual({ Stop: [] });
  });

  it('respects an explicit user value, including shorter ones', async () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ cleanupPeriodDays: 7 }));
    const r = await seed();
    expect(r.changed).toBe(false);
    expect(r.effective).toBe(7);
    expect(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).cleanupPeriodDays).toBe(7);
  });

  it('does NOT rewrite a corrupt settings.json (never wipe hooks/plugins)', async () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), '{ not json');
    const r = await seed();
    expect(r.changed).toBe(false);
    expect(fs.readFileSync(settingsPath(), 'utf8')).toBe('{ not json');
  });

  // Pins the wrong-type decision: a non-number value (e.g. "30" written by a
  // buggy tool) is meaningless to Claude Code, so seeding replaces it rather
  // than leaving retention silently at CC's 30-day default.
  it('replaces a non-number cleanupPeriodDays with the default', async () => {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify({ cleanupPeriodDays: '30' }));
    const r = await seed();
    expect(r.changed).toBe(true);
    expect(r.effective).toBe(365);
    expect(JSON.parse(fs.readFileSync(settingsPath(), 'utf8')).cleanupPeriodDays).toBe(365);
  });
});
