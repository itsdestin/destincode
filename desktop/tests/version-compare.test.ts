import { describe, it, expect } from 'vitest';
import { isNewerVersion } from '../src/shared/version-compare';
describe('isNewerVersion', () => {
  it.each([
    ['0.1.0', '0.2.0', true], ['0.2.0', '0.1.0', false], ['1.0.0', '1.0.0', false],
    ['v1.2', '1.2.1', true], ['1.0', '1.0.0', false], [undefined, '1.0.0', false], ['1.0.0', undefined, false],
    ['1.0.0-beta', '1.0.0', true], ['abc', 'abd', true],
  ])('%s → %s = %s', (a, b, want) => { expect(isNewerVersion(a, b)).toBe(want); });
});
