import { seed, type MockState, type ScenarioId } from './scenarios';

export interface MockStore {
  getState(): MockState;
  setState(fn: (s: MockState) => MockState): void;
  subscribe(fn: () => void): () => void;
  /** When true every write channel resolves {ok:false} WITHOUT mutating, so the
   *  real components' optimistic-revert paths actually run (spec §3.3). */
  refuseWrites: boolean;
}

export function createStore(scenario: ScenarioId): MockStore {
  let state = seed(scenario);
  const subs = new Set<() => void>();
  return {
    getState: () => state,
    setState(fn) {
      state = fn(state);
      subs.forEach((f) => f());
    },
    subscribe(fn) {
      subs.add(fn);
      // Braces matter: `subs.delete(fn)` returns a boolean, and an arrow
      // returning it would not match a `() => void` unsubscribe.
      return () => { subs.delete(fn); };
    },
    refuseWrites: scenario === 'refused',
  };
}
