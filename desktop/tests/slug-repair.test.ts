import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { classifyPair, uuidSet, Quarantine, repairHomeForks } from '../src/main/conversations/slug-repair';
import { ccProjectSlug } from '../src/main/slug-encoding';

const L = (uuid: string) => JSON.stringify({ type: 'user', uuid, message: {} }) + '\n';
let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repair-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
const write = (name: string, content: string) => {
  const p = path.join(tmp, name); fs.writeFileSync(p, content); return p;
};

describe('classifyPair — the merge-safety contract (spec §6.0)', () => {
  it('identical bytes → identical', () => {
    const a = write('a.jsonl', L('u1') + L('u2'));
    const b = write('b.jsonl', L('u1') + L('u2'));
    expect(classifyPair(a, b)).toBe('identical');
  });
  it('strict subset → wrong-is-subset', () => {
    const a = write('a.jsonl', L('u1'));
    const b = write('b.jsonl', L('u1') + L('u2'));
    expect(classifyPair(a, b)).toBe('wrong-is-subset');
  });
  it('strict superset → wrong-is-superset', () => {
    const a = write('a.jsonl', L('u1') + L('u2') + L('u3'));
    const b = write('b.jsonl', L('u1') + L('u2'));
    expect(classifyPair(a, b)).toBe('wrong-is-superset');
  });
  it('bidirectional divergence → fork (NEVER merged)', () => {
    const a = write('a.jsonl', L('u1') + L('uA'));
    const b = write('b.jsonl', L('u1') + L('uB'));
    expect(classifyPair(a, b)).toBe('fork');
  });
  it('equal uuid sets but different bytes (metadata drift) → wrong-is-subset (correct-dir copy wins)', () => {
    const a = write('a.jsonl', L('u1') + JSON.stringify({ type: 'mode' }) + '\n');
    const b = write('b.jsonl', L('u1') + JSON.stringify({ type: 'last-prompt' }) + '\n');
    expect(classifyPair(a, b)).toBe('wrong-is-subset');
  });
  it('same uuid, same set, but the shared message content diverges → fork (never subset)', () => {
    const a = write('a.jsonl', JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'truncat' } }) + '\n' + L('u2'));
    const b = write('b.jsonl', JSON.stringify({ type: 'user', uuid: 'u1', message: { content: 'truncated properly' } }) + '\n' + L('u2'));
    expect(classifyPair(a, b)).toBe('fork');
  });
  it('empty vs empty → identical', () => {
    const a = write('a.jsonl', '');
    const b = write('b.jsonl', '');
    expect(classifyPair(a, b)).toBe('identical');
  });
  it('empty wrongCopy vs non-empty correctCopy → wrong-is-subset', () => {
    const a = write('a.jsonl', '');
    const b = write('b.jsonl', L('u1') + L('u2'));
    expect(classifyPair(a, b)).toBe('wrong-is-subset');
  });
  it('non-empty wrongCopy vs empty correctCopy → wrong-is-superset', () => {
    const a = write('a.jsonl', L('u1') + L('u2'));
    const b = write('b.jsonl', '');
    expect(classifyPair(a, b)).toBe('wrong-is-superset');
  });
});

describe('Quarantine (spec §6.0)', () => {
  it('moves preserving home-relative path and writes the decision log', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qhome-'));
    const victim = path.join(home, '.claude', 'projects', 'slug', 's.jsonl');
    fs.mkdirSync(path.dirname(victim), { recursive: true });
    fs.writeFileSync(victim, 'x');
    const q = new Quarantine(home);
    expect(q.move(victim, 'test')).toBe(true);
    expect(fs.existsSync(victim)).toBe(false);
    expect(fs.readFileSync(path.join(q.dir, '.claude', 'projects', 'slug', 's.jsonl'), 'utf8')).toBe('x');
    expect(fs.readFileSync(path.join(q.dir, 'decisions.log'), 'utf8')).toContain('MOVE');
  });
  it('quarantine root is under .youcoded, NEVER under .claude/projects', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qhome-'));
    const q = new Quarantine(home);
    expect(q.dir.startsWith(path.join(home, '.youcoded', 'repair-quarantine'))).toBe(true);
  });
});

describe('repairHomeForks (spec §6.1)', () => {
  const F = (uuid: string, cwd: string) => JSON.stringify({ type: 'user', uuid, cwd }) + '\n';
  const old = new Date(Date.now() - 60 * 60 * 1000);            // 1h ago — not live
  const age = (p: string) => fs.utimesSync(p, old, old);

  function makeHome() {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'r61-'));
    const P = path.join(home, 'My Proj, & Stuff');
    fs.mkdirSync(P, { recursive: true });
    const projectsDir = path.join(home, '.claude', 'projects');
    const homeSlugDir = path.join(projectsDir, ccProjectSlug(home));
    fs.mkdirSync(homeSlugDir, { recursive: true });
    const quarantine = new Quarantine(home);
    const opts = { projectsDir, homeDir: home, knownFolders: [P], quarantine };
    return { home, P, projectsDir, homeSlugDir, quarantine, opts };
  }

  it('R2-owned foreign transcript with NO correct copy is MOVED to the correct dir', () => {
    const h = makeHome();
    const f = path.join(h.homeSlugDir, 's1.jsonl');
    fs.writeFileSync(f, F('u1', h.P)); age(f);
    const out = repairHomeForks(h.opts);
    const dest = path.join(h.projectsDir, ccProjectSlug(h.P), 's1.jsonl');
    expect(out).toEqual([{ sessionId: 's1', homeFolder: h.P, kind: 'moved', paths: [dest] }]);
    expect(fs.existsSync(f)).toBe(false);
    expect(fs.existsSync(dest)).toBe(true);
  });

  it('identical copy in the $HOME dir is quarantined; correct copy untouched', () => {
    const h = makeHome();
    const correctDir = path.join(h.projectsDir, ccProjectSlug(h.P));
    fs.mkdirSync(correctDir, { recursive: true });
    const wrong = path.join(h.homeSlugDir, 's2.jsonl');
    const correct = path.join(correctDir, 's2.jsonl');
    fs.writeFileSync(wrong, F('u1', h.P)); fs.writeFileSync(correct, F('u1', h.P));
    age(wrong); age(correct);
    repairHomeForks(h.opts);
    expect(fs.existsSync(wrong)).toBe(false);
    expect(fs.existsSync(correct)).toBe(true);
    expect(fs.existsSync(path.join(h.quarantine.dir, path.relative(h.home, wrong)))).toBe(true);
  });

  it('fork: NOTHING moves — both copies snapshotted, disk byte-identical (§7 merge-safety)', () => {
    const h = makeHome();
    const correctDir = path.join(h.projectsDir, ccProjectSlug(h.P));
    fs.mkdirSync(correctDir, { recursive: true });
    const wrong = path.join(h.homeSlugDir, 's3.jsonl');
    const correct = path.join(correctDir, 's3.jsonl');
    fs.writeFileSync(wrong, F('u1', h.P) + F('uA', h.home));    // diverges one way
    fs.writeFileSync(correct, F('u1', h.P) + F('uB', h.P));     // …and the other
    age(wrong); age(correct);
    const before = [fs.readFileSync(wrong, 'utf8'), fs.readFileSync(correct, 'utf8')];
    const out = repairHomeForks(h.opts);
    expect(out[0].kind).toBe('fork-surfaced');
    expect(fs.readFileSync(wrong, 'utf8')).toBe(before[0]);
    expect(fs.readFileSync(correct, 'utf8')).toBe(before[1]);
    expect(fs.readFileSync(path.join(h.quarantine.dir, 'decisions.log'), 'utf8')).toContain('ATTENTION fork s3');
    // (review fix, MINOR) both snapshots physically landed in quarantine.
    expect(fs.readFileSync(path.join(h.quarantine.dir, path.relative(h.home, wrong)), 'utf8')).toBe(before[0]);
    expect(fs.readFileSync(path.join(h.quarantine.dir, path.relative(h.home, correct)), 'utf8')).toBe(before[1]);
  });

  it('correct-dir copy is a strict subset of the $HOME copy: quarantine it, promote the superset (review fix, IMPORTANT 2a)', () => {
    const h = makeHome();
    const correctDir = path.join(h.projectsDir, ccProjectSlug(h.P));
    fs.mkdirSync(correctDir, { recursive: true });
    const wrong = path.join(h.homeSlugDir, 's6.jsonl');
    const correct = path.join(correctDir, 's6.jsonl');
    const supersetBytes = F('u1', h.P) + F('u2', h.P);
    const subsetBytes = F('u1', h.P);
    fs.writeFileSync(wrong, supersetBytes);
    fs.writeFileSync(correct, subsetBytes);
    age(wrong); age(correct);
    const out = repairHomeForks(h.opts);
    expect(out).toEqual([{ sessionId: 's6', homeFolder: h.P, kind: 'replaced-with-superset', paths: [correct] }]);
    expect(fs.existsSync(wrong)).toBe(false);
    expect(fs.readFileSync(correct, 'utf8')).toBe(supersetBytes);
    const quarantinedCorrect = path.join(h.quarantine.dir, path.relative(h.home, correct));
    expect(fs.readFileSync(quarantinedCorrect, 'utf8')).toBe(subsetBytes);
  });

  it('correct-dir copy is superset-eligible but currently live: pair is deferred, nothing moves (review fix, IMPORTANT 2b)', () => {
    const h = makeHome();
    const correctDir = path.join(h.projectsDir, ccProjectSlug(h.P));
    fs.mkdirSync(correctDir, { recursive: true });
    const wrong = path.join(h.homeSlugDir, 's7.jsonl');
    const correct = path.join(correctDir, 's7.jsonl');
    const supersetBytes = F('u1', h.P) + F('u2', h.P);
    const subsetBytes = F('u1', h.P);
    fs.writeFileSync(wrong, supersetBytes); age(wrong);
    fs.writeFileSync(correct, subsetBytes);                    // fresh mtime = live; NOT aged
    const out = repairHomeForks(h.opts);
    expect(out).toEqual([{ sessionId: 's7', homeFolder: h.P, kind: 'deferred-live', paths: [wrong, correct] }]);
    expect(fs.existsSync(wrong)).toBe(true);
    expect(fs.readFileSync(wrong, 'utf8')).toBe(supersetBytes);
    expect(fs.existsSync(correct)).toBe(true);
    expect(fs.readFileSync(correct, 'utf8')).toBe(subsetBytes);
    expect(fs.existsSync(h.quarantine.dir)).toBe(false);
  });

  it('top-level only: a subagent jsonl below the dir is never touched (§6.1 scoping)', () => {
    const h = makeHome();
    const agent = path.join(h.homeSlugDir, 'sess-id', 'subagents', 'agent-x.jsonl');
    fs.mkdirSync(path.dirname(agent), { recursive: true });
    fs.writeFileSync(agent, F('u1', h.P)); age(agent);
    expect(repairHomeForks(h.opts)).toEqual([]);
    expect(fs.existsSync(agent)).toBe(true);
  });

  it('live file (fresh mtime) is deferred, not touched (§6.5)', () => {
    const h = makeHome();
    const f = path.join(h.homeSlugDir, 's4.jsonl');
    fs.writeFileSync(f, F('u1', h.P));                          // fresh mtime = live
    const out = repairHomeForks(h.opts);
    expect(out).toEqual([{ sessionId: 's4', homeFolder: '', kind: 'deferred-live', paths: [f] }]);
    expect(fs.existsSync(f)).toBe(true);
  });

  it('a transcript whose first cwd IS $HOME is left alone (legitimate resident)', () => {
    const h = makeHome();
    const f = path.join(h.homeSlugDir, 's5.jsonl');
    fs.writeFileSync(f, F('u1', h.home)); age(f);
    expect(repairHomeForks(h.opts)).toEqual([]);
    expect(fs.existsSync(f)).toBe(true);
  });
});
