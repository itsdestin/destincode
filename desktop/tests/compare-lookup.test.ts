// tests/compare-lookup.test.ts
//
// The live review route resolves a candidate from three strings that came out of a JSON file
// in ANOTHER repository (a youcoded-dev review-deck spec). Nothing can check that join at
// build time, so the route is the only thing that can report a bad name — and it has to
// report it usefully, with the names that would have worked. These cases pin that contract.
import { describe, it, expect } from 'vitest';
import { findCandidate } from '../src/renderer/dev/workbench/compare/lookup';
import { COMPARE_SURFACES } from '../src/renderer/dev/workbench/compare/registry';

const surface = COMPARE_SURFACES[0];
const round = surface.rounds[0];
const candidate = round.candidates[0];

describe('findCandidate', () => {
  it('resolves a known (surface, round, candidate) triple', () => {
    const r = findCandidate(surface.id, round.n, candidate.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.surface.id).toBe(surface.id);
    expect(r.round.n).toBe(round.n);
    expect(r.candidate.id).toBe(candidate.id);
    expect(typeof r.candidate.render).toBe('function');
  });

  it('accepts the round as the string a URL gives it', () => {
    expect(findCandidate(surface.id, String(round.n), candidate.id).ok).toBe(true);
  });

  // The three levels each fail differently, and each must say what DOES exist there —
  // "nothing rendered" is the failure this route was written to make impossible.
  it('reports an unknown surface with the surfaces that exist', () => {
    const r = findCandidate('no-such-surface', 1, 'a');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.level).toBe('surface');
    expect(r.asked).toBe('no-such-surface');
    expect(r.available).toEqual(COMPARE_SURFACES.map((s) => s.id));
    expect(r.available.length).toBeGreaterThan(0);
  });

  it('reports an unknown round with the rounds that exist', () => {
    const r = findCandidate(surface.id, 999, candidate.id);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.level).toBe('round');
    expect(r.asked).toBe('999');
    expect(r.available).toEqual(surface.rounds.map((x) => String(x.n)));
    expect(r.available.length).toBeGreaterThan(0);
  });

  it('reports an unknown candidate with the candidates in THAT round', () => {
    const r = findCandidate(surface.id, round.n, 'no-such-candidate');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.level).toBe('candidate');
    expect(r.asked).toBe('no-such-candidate');
    expect(r.available).toEqual(round.candidates.map((c) => c.id));
    expect(r.available.length).toBeGreaterThan(0);
  });

  it('treats a missing or unparseable round as a round failure, not a crash', () => {
    for (const bad of [null, undefined, '', 'two']) {
      const r = findCandidate(surface.id, bad as never, candidate.id);
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.level).toBe('round');
    }
  });

  it('never resolves a candidate from the wrong round of the right surface', () => {
    // The reason `round` is in the address at all: ids repeat across rounds, so a lookup
    // that ignored the round would hand back a design the reviewer never asked to see.
    for (const s of COMPARE_SURFACES) {
      for (const r of s.rounds) {
        for (const c of r.candidates) {
          const got = findCandidate(s.id, r.n, c.id);
          expect(got.ok).toBe(true);
          if (got.ok) expect(got.candidate).toBe(c);   // identity, not just a matching id
        }
      }
    }
  });
});
