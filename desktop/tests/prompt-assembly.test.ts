import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { assembleSystemPrompt } from '../src/main/harness/prompt-assembly';
import { CODER_DEFAULT_BODY } from '../src/main/harness/prompts/coder-default';

// Each test gets a fresh tmp sandbox so filesystem walk-up state never leaks.
let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-assembly-'));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const PRESET = 'PRESET_BODY_MARKER';

describe('assembleSystemPrompt — section order', () => {
  it('orders identity → preset → env → project instructions → tool guidance', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'PROJECT_INSTR_MARKER');
    const out = assembleSystemPrompt({ presetBody: PRESET, cwd: dir, appVersion: '9.9.9' });

    const iIdentity = out.indexOf('YouCoded assistant');
    const iPreset = out.indexOf(PRESET);
    const iEnv = out.indexOf('<env');
    const iProject = out.indexOf('PROJECT_INSTR_MARKER');
    const iTools = out.indexOf('Prefer dedicated tools');

    expect(iIdentity).toBeGreaterThanOrEqual(0);
    expect(iPreset).toBeGreaterThan(iIdentity);
    expect(iEnv).toBeGreaterThan(iPreset);
    expect(iProject).toBeGreaterThan(iEnv);
    expect(iTools).toBeGreaterThan(iProject);
  });

  it('labels the env block as a snapshot at session start', () => {
    const out = assembleSystemPrompt({ presetBody: PRESET, cwd: dir, appVersion: '9.9.9' });
    expect(out).toContain('<env');
    expect(out).toContain('snapshot at session start');
    expect(out).toContain(`Working directory: ${dir}`);
    expect(out).toContain('YouCoded version: 9.9.9');
  });
});

describe('assembleSystemPrompt — project instructions walk-up', () => {
  it('prefers AGENTS.md over CLAUDE.md at the same level', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'FROM_AGENTS');
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), 'FROM_CLAUDE');
    const out = assembleSystemPrompt({ presetBody: PRESET, cwd: dir, appVersion: '1.0.0' });
    expect(out).toContain('source="AGENTS.md"');
    expect(out).toContain('FROM_AGENTS');
    expect(out).not.toContain('FROM_CLAUDE');
  });

  it('finds AGENTS.md at the root from a nested cwd (sub/dir/)', () => {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'ROOT_INSTR');
    const nested = path.join(dir, 'sub', 'dir');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(path.join(dir, '.git')); // bound the walk-up at the repo root
    const out = assembleSystemPrompt({ presetBody: PRESET, cwd: nested, appVersion: '1.0.0' });
    expect(out).toContain('ROOT_INSTR');
    expect(out).toContain('source="AGENTS.md"');
  });

  it('stops the walk-up at the git root (does not escape the repo)', () => {
    // AGENTS.md lives ABOVE the repo; walk-up must not reach it.
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'OUTSIDE_REPO');
    const repo = path.join(dir, 'repo');
    const sub = path.join(repo, 'sub');
    fs.mkdirSync(sub, { recursive: true });
    fs.mkdirSync(path.join(repo, '.git'));
    const out = assembleSystemPrompt({ presetBody: PRESET, cwd: sub, appVersion: '1.0.0' });
    expect(out).not.toContain('OUTSIDE_REPO');
    expect(out).not.toContain('<project-instructions');
  });

  it('omits the project-instructions section entirely when neither file is present', () => {
    const out = assembleSystemPrompt({ presetBody: PRESET, cwd: dir, appVersion: '1.0.0' });
    expect(out).not.toContain('<project-instructions');
  });

  it('finds a root-level AGENTS.md even when that dir is the git root', () => {
    // .git check must run AFTER trying the files in the dir.
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'ROOT_LEVEL_INSTR');
    fs.mkdirSync(path.join(dir, '.git'));
    const out = assembleSystemPrompt({ presetBody: PRESET, cwd: dir, appVersion: '1.0.0' });
    expect(out).toContain('ROOT_LEVEL_INSTR');
  });
});

describe('assembleSystemPrompt — byte stability (KV-cache pin)', () => {
  it('is byte-identical across two calls with the same inputs (non-git dir)', () => {
    // Non-git tmp dir → gitSnapshot returns the stable "not a repository" line,
    // and the date string is stable within a single test run.
    const inputs = { presetBody: PRESET, cwd: dir, appVersion: '2.3.4' };
    const a = assembleSystemPrompt(inputs);
    const b = assembleSystemPrompt(inputs);
    expect(a).toBe(b);
    expect(a).toContain('Git: not a repository');
  });
});

describe('CODER_DEFAULT_BODY', () => {
  it('is a non-empty original coder-shaped body', () => {
    expect(CODER_DEFAULT_BODY.length).toBeGreaterThan(100);
    expect(CODER_DEFAULT_BODY).toContain('software project');
  });
});

describe('prompt variant overlay', () => {
  const base = { presetBody: 'PRESET_BODY', cwd: process.cwd(), appVersion: '9.9.9' };

  it('default/anthropic/gpt append nothing (byte-identical to no variant)', () => {
    const none = assembleSystemPrompt({ ...base });
    expect(assembleSystemPrompt({ ...base, promptVariant: 'default' })).toBe(none);
    expect(assembleSystemPrompt({ ...base, promptVariant: 'anthropic' })).toBe(none);
    expect(assembleSystemPrompt({ ...base, promptVariant: 'gpt' })).toBe(none);
  });

  it('local-small appends the plan-then-execute overlay AFTER the preset body', () => {
    const p = assembleSystemPrompt({ ...base, promptVariant: 'local-small' });
    expect(p).toContain('PRESET_BODY');
    expect(p.indexOf('PRESET_BODY')).toBeLessThan(p.indexOf('one tool at a time'));
    expect(p).toMatch(/TodoWrite/);
  });
});
