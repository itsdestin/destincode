import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { classifyPair, uuidSet, Quarantine } from '../src/main/conversations/slug-repair';

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
