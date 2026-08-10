import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { seedFixtureWorkspace, FIXTURE_MANIFEST } from '../src/main/harness/review/fixture-workspace';
import { BATTERY_PROMPT, loadRoster } from '../src/main/harness/review/battery';

let made: string[] = [];
afterEach(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
  made = [];
});

describe('seedFixtureWorkspace', () => {
  it('creates the tree inside the OS temp dir, never in a real repo', () => {
    const root = seedFixtureWorkspace();
    made.push(root);
    expect(root.startsWith(fs.realpathSync(os.tmpdir()))).toBe(true);
  });

  it('covers every file type the battery exercises', () => {
    const root = seedFixtureWorkspace();
    made.push(root);
    for (const { rel } of FIXTURE_MANIFEST) {
      expect(fs.existsSync(path.join(root, rel)), rel).toBe(true);
    }
  });

  it('includes a binary file so the Read binary guard is reachable', () => {
    const root = seedFixtureWorkspace();
    made.push(root);
    const buf = fs.readFileSync(path.join(root, 'assets/logo.png'));
    expect(buf.includes(0)).toBe(true);
  });

  it('includes a file large enough to force paging', () => {
    const root = seedFixtureWorkspace();
    made.push(root);
    const lines = fs.readFileSync(path.join(root, 'src/big-module.ts'), 'utf8').split('\n');
    expect(lines.length).toBeGreaterThan(2_000);
  });

  it('includes a duplicated string so the ambiguous-Edit guard is reachable', () => {
    const root = seedFixtureWorkspace();
    made.push(root);
    const text = fs.readFileSync(path.join(root, 'notes/duplicates.md'), 'utf8');
    expect(text.match(/duplicate phrase hello/g)).toHaveLength(2);
  });

  it('includes a path with spaces', () => {
    const root = seedFixtureWorkspace();
    made.push(root);
    expect(fs.existsSync(path.join(root, 'a dir with spaces/a file with spaces.txt'))).toBe(true);
  });

  // Pins the seeded AskUserQuestion ambiguity (see WHY comment in
  // seedFixtureWorkspace): two config files both claim to be the server's real
  // port and disagree. If a future edit "reconciles" them to matching values —
  // a natural-looking bug fix — this test catches it and the ambiguity silently
  // stops being exercisable, same as it has been for two full review rounds.
  it('seeds a genuine port contradiction between config files, with nothing indicating which wins', () => {
    const root = seedFixtureWorkspace();
    made.push(root);
    const settings = fs.readFileSync(path.join(root, 'config/settings.toml'), 'utf8');
    const app = fs.readFileSync(path.join(root, 'config/app.toml'), 'utf8');
    const settingsPort = settings.match(/port\s*=\s*(\d+)/)?.[1];
    const appPort = app.match(/port\s*=\s*(\d+)/)?.[1];
    expect(settingsPort).toBeDefined();
    expect(appPort).toBeDefined();
    expect(settingsPort).not.toBe(appPort);
  });

  it('produces byte-identical trees across runs, so two models face the same tree', () => {
    const a = seedFixtureWorkspace();
    const b = seedFixtureWorkspace();
    made.push(a, b);
    for (const { rel } of FIXTURE_MANIFEST) {
      expect(fs.readFileSync(path.join(a, rel)).equals(fs.readFileSync(path.join(b, rel))), rel).toBe(true);
    }
  });
});

describe('battery prompt', () => {
  it('names every one of the seven battery sections', () => {
    for (const section of ['Navigate', 'Read', 'Search', 'Write/Edit', 'Bash', 'Web', 'Configuration']) {
      expect(BATTERY_PROMPT).toContain(section);
    }
  });

  it('tells the model to work in the fixture and not to hunt for the real repo', () => {
    expect(BATTERY_PROMPT).toContain('fixture');
  });

  it('asks for the three review headings the doc expects', () => {
    for (const h of ['What works well', 'Difficulties / wishes', 'Overall']) {
      expect(BATTERY_PROMPT).toContain(h);
    }
  });
});

describe('loadRoster', () => {
  it('rejects a roster entry missing a modelId, instead of running a nameless model', () => {
    // Deviation from the brief: push the temp dir into `made` so afterEach cleans it
    // up like every other fixture dir in this file, instead of leaking it in /tmp.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-'));
    made.push(dir);
    const f = path.join(dir, 'r.json');
    fs.writeFileSync(f, JSON.stringify([{ label: 'No Model' }]));
    expect(() => loadRoster(f)).toThrow(/modelId/);
  });

  it('loads a well-formed roster', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'roster-'));
    made.push(dir);
    const f = path.join(dir, 'r.json');
    fs.writeFileSync(f, JSON.stringify([{ label: 'Kimi K3', modelId: 'moonshotai/kimi-k3' }]));
    expect(loadRoster(f)).toEqual([{ label: 'Kimi K3', modelId: 'moonshotai/kimi-k3' }]);
  });
});
