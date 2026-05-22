import { describe, expect, it } from 'vitest';
import { canonicalize } from '../../src/shared/artifacts/canonicalize';
import fixtures from '../../../shared-fixtures/artifacts/canonicalize-cases.json';

describe('canonicalize', () => {
  for (const c of fixtures.cases) {
    it(`${c.input} → ${c.expected}`, () => {
      const result = canonicalize(c.input, c.projectRoot);
      expect(result).toBe(c.expected);
    });
  }

  it('handles NFC-vs-NFD Unicode normalization', () => {
    const nfc = 'café.md'; // single codepoint é
    const nfd = 'café.md'; // e + combining acute
    expect(canonicalize(nfc, null)).toBe(canonicalize(nfd, null));
  });
});
