import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { ccProjectSlug, nativeStoreSlug, ccHash, CC_SLUG_MAX } from '../src/main/slug-encoding';

const fixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'cc-slug-pairs.json'), 'utf8'),
) as { ccVersion: string; pairs: Array<{ cwd: string; dir: string; note: string }> };

describe('ccProjectSlug — anchored to directories CC itself created', () => {
  for (const p of fixture.pairs) {
    it(`${p.note}: ${p.cwd}`, () => {
      expect(ccProjectSlug(p.cwd)).toBe(p.dir);
    });
  }

  it('caps at 200 and hashes the ORIGINAL argument, not the slug', () => {
    const long = '/x/' + 'b'.repeat(300);
    const out = ccProjectSlug(long);
    // '98hajq' was computed with an INDEPENDENT hash reimplementation at
    // review-fix time (2026-08-12) — never with this module's own ccHash
    // (spec §2: expected values must not come from the code under test).
    expect(out).toBe('-x-' + 'b'.repeat(197) + '-98hajq');
    expect(out.length).toBe(207);
  });

  it('drive-normalizes a lowercase drive (OUR input normalization, not CC rule)', () => {
    expect(ccProjectSlug('c:\\Users\\d\\proj')).toBe('C--Users-d-proj');
  });
});

describe('ccHash — pinned so nobody "fixes" a nonexistent int32-min edge', () => {
  it('known value', () => { expect(ccHash('abc')).toBe('22ci'); });
  it('empty string', () => { expect(ccHash('')).toBe('0'); });
  // There is NO int32-min trap in JS: Math.abs(-2147483648) === 2147483648
  // ("zik0zk"). CC has no guard; adding one breaks the mirror. (Kotlin DOES
  // have the trap — see CcProjectSlugTest.kt.)
  it('Math.abs of int32-min is exact in JS', () => {
    expect(Math.abs(-2147483648).toString(36)).toBe('zik0zk');
  });
});

describe('nativeStoreSlug — FROZEN (renaming of the old cwdToProjectSlug)', () => {
  // Byte-identical to the historical rule, or the native store and
  // permissions.json silently orphan (spec §3).
  it('punctuated path keeps , & . _ exactly as before', () => {
    expect(nativeStoreSlug('/home/destin/YouCoded/Projects/PAF 574 - Diversity, Ethics, & Public Change'))
      .toBe('-home-destin-YouCoded-Projects-PAF-574---Diversity,-Ethics,-&-Public-Change');
  });
  it('encodes the deliberate slug divergence: native raw, CC layer drive-normalizes', () => {
    expect(nativeStoreSlug('c:\\Users\\d\\proj')).toBe('c--Users-d-proj');
    expect(ccProjectSlug('c:\\Users\\d\\proj')).toBe('C--Users-d-proj'); // NOT equal — pinned
  });
});
