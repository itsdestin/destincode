import { describe, it, expect } from 'vitest';
import { PILL_COPY, pillDetail, mainPillCopy } from '../src/renderer/dev/dashboard/StatusPill';
import { buildCleanupPrompt } from '../src/renderer/dev/dashboard/cleanup-prompt';
import type { Checkout } from '../src/renderer/dev/dashboard/api';

const c = (over: Partial<Checkout>): Checkout => ({
  id: 'i', path: '/w/wt', name: 'wt', branch: 'feat/x', dirty: 0, ahead: 0,
  pushed: false, merged: false, status: 'safe', missing: false, isMain: false, ...over,
});

describe('pill copy', () => {
  it('names the four states in words a non-developer can act on', () => {
    expect(PILL_COPY.unsaved.label).toBe('Unsaved work');
    expect(PILL_COPY.unpushed.label).toBe('Unpushed work');
    expect(PILL_COPY.pushed.label).toBe('Pushed');
    expect(PILL_COPY.safe.label).toBe('Safe to delete');
  });

  it('says out loud what deleting an unsaved checkout would cost', () => {
    // The pill is the whole point of the column; its hint has to answer
    // "would I lose something", not just name a git state.
    expect(PILL_COPY.unsaved.hint).toMatch(/only copy/i);
  });

  it('keeps the container neutral and puts the state in a dot', () => {
    // Design rule 6: errors are not red boxes. Every pill shares one neutral
    // container and differs only by its dot.
    for (const k of Object.keys(PILL_COPY) as Array<keyof typeof PILL_COPY>) {
      expect(PILL_COPY[k].dot).toMatch(/^bg-/);
    }
    expect(PILL_COPY.unsaved.dot).toBe('bg-destructive');
  });
});

describe('the main checkout', () => {
  it('is never told it is safe to delete', () => {
    // Everything else hangs off it. A green all-clear beside the main checkout
    // invites exactly the wrong action, and it has no tick box for the same reason.
    const { label } = mainPillCopy('safe');
    expect(label).toBe('Main checkout');
    expect(label).not.toMatch(/delete/i);
  });

  it('still warns when it holds unsaved work', () => {
    // Suppressing "safe to delete" must not suppress a real warning — an
    // uncommitted file in the shared checkout matters as much as anywhere.
    expect(mainPillCopy('unsaved').label).toBe('Unsaved work');
    expect(mainPillCopy('unpushed').label).toBe('Unpushed work');
  });
});

describe('pillDetail', () => {
  it('shows the measurements the pill was made from', () => {
    expect(pillDetail(c({ dirty: 40 }))).toMatch(/40 uncommitted files/);
    expect(pillDetail(c({ ahead: 1 }))).toMatch(/1 commit ahead/);
  });

  it('says something rather than nothing for a clean merged checkout', () => {
    expect(pillDetail(c({ merged: true }))).toBeTruthy();
  });
});

describe('buildCleanupPrompt', () => {
  it('names every selected checkout with its branch and path', () => {
    const out = buildCleanupPrompt([c({ name: 'alpha', branch: 'feat/a', path: '/w/alpha' })]);
    expect(out).toContain('alpha');
    expect(out).toContain('feat/a');
    expect(out).toContain('/w/alpha');
  });

  it('carries the measurements, not just the pill, so the reader can re-check them', () => {
    const out = buildCleanupPrompt([c({ status: 'unsaved', dirty: 40 })]);
    expect(out).toMatch(/40/);
    expect(out).toMatch(/uncommitted/i);
  });

  it('warns explicitly when a selection would lose work', () => {
    const out = buildCleanupPrompt([c({ status: 'unsaved', dirty: 3 })]);
    expect(out).toMatch(/only copy/i);
  });

  it('does not warn when everything selected is safe', () => {
    const out = buildCleanupPrompt([c({ status: 'safe', merged: true, pushed: true })]);
    expect(out).not.toMatch(/only copy/i);
  });

  it('asks for a plan rather than instructing a deletion', () => {
    // A prompt that says "delete these" invites acting before checking, and the
    // summary is exactly the thing that has been wrong before.
    const out = buildCleanupPrompt([c({})]);
    expect(out).toMatch(/plan/i);
    expect(out).toMatch(/check each one yourself/i);
    expect(out).not.toMatch(/^delete /im);
  });
});
