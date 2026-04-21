import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Isolate the store's config path per test via a temp HOME override.
let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-skill-config-'));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;  // Windows homedir backing
  vi.resetModules();  // Ensure CONFIG_PATH is re-evaluated under the new HOME
});

afterEach(() => {
  if (originalHome) process.env.HOME = originalHome;
  if (originalUserProfile) process.env.USERPROFILE = originalUserProfile;
  else delete process.env.USERPROFILE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('SkillConfigStore theme favorites', () => {
  it('seeds the four built-in theme slugs on first read when missing', async () => {
    const { SkillConfigStore } = await import('../src/main/skill-config-store');
    const store = new SkillConfigStore();
    const favs = store.getThemeFavorites();
    expect(favs.sort()).toEqual(['creme', 'dark', 'light', 'midnight']);
  });

  it('persists setThemeFavorite across reload', async () => {
    const { SkillConfigStore } = await import('../src/main/skill-config-store');
    const store = new SkillConfigStore();
    store.getThemeFavorites();  // trigger seed
    store.setThemeFavorite('solarized', true);
    store.setThemeFavorite('light', false);

    const store2 = new SkillConfigStore();
    const favs = store2.getThemeFavorites();
    expect(favs).toContain('solarized');
    expect(favs).not.toContain('light');
  });

  it('is idempotent when setting a favorite that already exists', async () => {
    const { SkillConfigStore } = await import('../src/main/skill-config-store');
    const store = new SkillConfigStore();
    store.setThemeFavorite('dark', true);
    store.setThemeFavorite('dark', true);
    const favs = store.getThemeFavorites();
    expect(favs.filter(s => s === 'dark')).toHaveLength(1);
  });

  it('setThemeFavorite cold-start seeds defaults before applying the mutation', async () => {
    const { SkillConfigStore } = await import('../src/main/skill-config-store');
    const store = new SkillConfigStore();
    // Call set without ever calling get first
    store.setThemeFavorite('light', false);
    const favs = store.getThemeFavorites();
    // dark/midnight/creme should survive even though getThemeFavorites was never called first
    expect(favs).toContain('dark');
    expect(favs).toContain('midnight');
    expect(favs).toContain('creme');
    expect(favs).not.toContain('light');
  });
});
