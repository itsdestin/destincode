// Pins the marketplace-prompt install/update path (marketplace overhaul Task 2).
//
// WHY this test exists: installing a `type: "prompt"` entry worked, but
// updating one could not — the prompt branch never recorded a PackageInfo, so
// the Update badge could never light, and `update()` returned `{ ok: true }`
// even when it had found no row to rewrite. A silent false success. Today no
// live entry is a prompt; Phase 2 introduces 257 of them from
// awesome-cursorrules, all of which would freeze at their install-day snapshot
// and claim to refresh.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserSkillConfig } from '../src/shared/types';

// skill-provider imports the installer at module load; nothing in the prompt
// path uses it, but the module has to resolve without touching disk.
const inst = vi.hoisted(() => ({
  installPlugin: vi.fn(),
  upgradePluginFromLocal: vi.fn(),
  refreshLocalMarketplaceCache: vi.fn(),
  readPluginVersion: vi.fn(),
  isPluginInstalled: vi.fn(),
  sweepStaleUpgradeDirs: vi.fn(),
  marketplaceCacheDir: vi.fn(() => '/tmp/cache'),
  pluginInstallDir: vi.fn((id: string) => `/tmp/plugins/${id}`),
}));
vi.mock('../src/main/plugin-installer', () => inst);
vi.mock('../src/main/logger', () => ({ log: vi.fn() }));

import { LocalSkillProvider } from '../src/main/skill-provider';

const PROMPT_ID = 'cursorrules-android-jetpack-compose';

let registryPrompt = 'ORIGINAL TEXT';
let config: UserSkillConfig;

function promptEntry() {
  return {
    id: PROMPT_ID,
    type: 'prompt',
    displayName: 'Android Jetpack Compose',
    description: 'Cursor rules for Compose',
    prompt: registryPrompt,
    category: 'development',
    version: 'abc1234',
    source: 'marketplace',
    visibility: 'published',
  } as any;
}

// A fully in-memory SkillConfigStore: only load/save are stubbed, so every
// method under test (createPromptSkill, recordPackageInstall, getPackage) runs
// its real logic against an object instead of ~/.claude/youcoded-skills.json.
function makeProvider() {
  config = { version: 2, favorites: [], chips: [], overrides: {}, privateSkills: [], packages: {} };
  const p = new LocalSkillProvider();
  vi.spyOn(p.configStore, 'load').mockImplementation(() => config);
  vi.spyOn(p.configStore as any, 'save').mockImplementation(() => {});
  vi.spyOn(p as any, 'fetchIndex').mockImplementation(async () => [promptEntry()]);
  return p;
}

describe('marketplace prompts install and update honestly', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registryPrompt = 'ORIGINAL TEXT';
  });

  it('a marketplace prompt is stored under its marketplace id and records a package', async () => {
    const p = makeProvider();
    await p.install(PROMPT_ID);
    expect(config.privateSkills.some((s) => s.id === PROMPT_ID)).toBe(true);
    expect(p.configStore.getPackage(PROMPT_ID)).toBeTruthy();
  });

  it('updating a prompt rewrites its content', async () => {
    const p = makeProvider();
    await p.install(PROMPT_ID);
    registryPrompt = 'NEW TEXT';
    const r = await p.update(PROMPT_ID);
    expect(r.ok).toBe(true);
    expect(config.privateSkills.find((s) => s.id === PROMPT_ID)!.prompt).toBe('NEW TEXT');
  });

  it('the recorded package version moves with the update', async () => {
    const p = makeProvider();
    await p.install(PROMPT_ID);
    expect(p.configStore.getPackage(PROMPT_ID)!.version).toBe('abc1234');
    registryPrompt = 'NEW TEXT';
    await p.update(PROMPT_ID);
    expect(p.configStore.getPackage(PROMPT_ID)!.version).toBe('abc1234');
  });

  it('updating a prompt that is not there fails loudly instead of claiming success', async () => {
    const p = makeProvider();
    const r = await p.update(PROMPT_ID);   // never installed
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not installed/i);
  });
});
