import { describe, it, expect } from 'vitest';
import { createStore } from '../src/renderer/dev/workbench/mock-store';

describe('mock store', () => {
  it('seeds sessions from the default scenario', () => {
    const s = createStore('default');
    expect(s.getState().sessions.length).toBeGreaterThan(0);
    expect(s.getState().providers.some((p) => p.ready)).toBe(true);
  });

  it('empty scenario seeds nothing', () => {
    const s = createStore('empty');
    expect(s.getState().sessions).toEqual([]);
    expect(s.getState().past).toEqual([]);
    expect(s.getState().tags).toEqual([]);
  });

  it('no-providers scenario has zero ready providers', () => {
    const s = createStore('no-providers');
    expect(s.getState().providers.filter((p) => p.ready)).toEqual([]);
  });

  // The stress scenario is what stops UI-first development shipping designs
  // that only survive pretty data. Spec §4.
  it('stress scenario has long names and a large list', () => {
    const s = createStore('stress');
    expect(s.getState().past.length).toBeGreaterThanOrEqual(200);
    expect(Math.max(...s.getState().past.map((p) => p.name.length))).toBeGreaterThanOrEqual(80);
  });

  // Real data has holes. A stress seed where every optional field is populated
  // is just a bigger happy path — the rows that break layouts are the ones
  // missing a project, a model, or a note.
  it('stress scenario exercises the degraded row states', () => {
    const past = createStore('stress').getState().past;
    expect(past.some((p) => p.missingProject)).toBe(true);
    expect(past.some((p) => p.notSyncedYet)).toBe(true);
    expect(past.some((p) => !p.tags || p.tags.length === 0)).toBe(true);
  });

  it('refused scenario flags writes as refused', () => {
    expect(createStore('refused').refuseWrites).toBe(true);
    expect(createStore('default').refuseWrites).toBe(false);
  });

  it('notifies subscribers on setState', () => {
    const s = createStore('default');
    let calls = 0;
    const off = s.subscribe(() => { calls += 1; });
    s.setState((st) => ({ ...st, sessions: [] }));
    expect(calls).toBe(1);
    off();
    s.setState((st) => st);
    expect(calls).toBe(1);
  });

  // Scenarios must not share mutable seed objects — mutating one store's
  // sessions would otherwise leak into the next store built in the same
  // process, which in the browser means "reload showed stale data".
  it('each store gets its own arrays', () => {
    const a = createStore('default');
    const b = createStore('default');
    a.setState((s) => ({ ...s, sessions: [] }));
    expect(b.getState().sessions.length).toBeGreaterThan(0);
  });
});
