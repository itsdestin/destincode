// The registry's curated-defaults.json once named `theme-builder` — an id that
// exists nowhere (the plugin is `wecoded-themes-plugin`). Seeding wrote that
// bare string into `~/.claude/youcoded-skills.json` → favorites[], where it
// resolved to nothing. These pin the one-time cleanup: it removes exactly that
// string, keeps everything else byte-for-byte, rewrites the file once, and
// leaves a legitimately-owned `theme-builder` alone.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

let originalHome: string | undefined;
let originalUserProfile: string | undefined;
let tmpHome: string;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-dead-fav-'));
  originalHome = process.env.HOME;
  originalUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  vi.resetModules();  // CONFIG_PATH is computed at import time
});

afterEach(() => {
  if (originalHome) process.env.HOME = originalHome;
  if (originalUserProfile) process.env.USERPROFILE = originalUserProfile;
  else delete process.env.USERPROFILE;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

const configPath = () => path.join(tmpHome, '.claude', 'youcoded-skills.json');

function writeProfile(extra: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify({
    version: 2,
    favorites: ['superpowers:brainstorming', 'theme-builder', 'journaling-assistant'],
    chips: [{ label: 'Git Status', prompt: 'run git status' }],
    overrides: { 'journaling-assistant': { name: 'Journal' } },
    privateSkills: [],
    packages: { superpowers: { version: '1.0.0', source: 'marketplace', installedAt: 'x', removable: true, components: [] } },
    themeFavorites: ['light', 'dark'],
    ...extra,
  }, null, 2));
}

describe('SkillConfigStore dead-favourite cleanup', () => {
  it('removes the bare theme-builder string and nothing else, then persists once', async () => {
    writeProfile({});
    const before = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    const { SkillConfigStore } = await import('../src/main/skill-config-store');
    const favs = new SkillConfigStore().getFavorites();
    expect(favs).toEqual(['superpowers:brainstorming', 'journaling-assistant']);

    const after = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    // Everything except favorites is untouched — chips, overrides, packages,
    // theme favourites all survive exactly.
    expect(after).toEqual({ ...before, favorites: ['superpowers:brainstorming', 'journaling-assistant'] });
  });

  it('is idempotent: a clean profile is never rewritten', async () => {
    writeProfile({ favorites: ['superpowers:brainstorming'] });
    const mtimeBefore = fs.statSync(configPath()).mtimeMs;
    const { SkillConfigStore } = await import('../src/main/skill-config-store');
    expect(new SkillConfigStore().getFavorites()).toEqual(['superpowers:brainstorming']);
    expect(fs.statSync(configPath()).mtimeMs).toBe(mtimeBefore);
  });

  it('leaves theme-builder alone when the user actually owns something by that id', async () => {
    writeProfile({ privateSkills: [{ id: 'theme-builder', name: 'My theme builder' }] });
    const { SkillConfigStore } = await import('../src/main/skill-config-store');
    expect(new SkillConfigStore().getFavorites()).toContain('theme-builder');
  });
});
