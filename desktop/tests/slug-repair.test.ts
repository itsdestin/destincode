import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { classifyPair, uuidSet } from '../src/main/conversations/slug-repair';

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
});
