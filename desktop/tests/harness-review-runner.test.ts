import { describe, it, expect } from 'vitest';
import { makeOpenRouterFactory } from '../src/main/harness/review/openrouter-factory';
import { appendReview } from '../src/main/harness/review/append-review';

describe('makeOpenRouterFactory', () => {
  it('refuses to build without a key, naming the env var to set', () => {
    expect(() => makeOpenRouterFactory('', 'x/y')).toThrow(/OPENROUTER_API_KEY/);
  });

  it('returns a factory that resolves a model without touching Electron', async () => {
    // The whole point: no app.whenReady(), no safeStorage, no userData. If this
    // ever needs Electron, the runner stops being a plain Node script.
    const factory = makeOpenRouterFactory('sk-test', 'moonshotai/kimi-k3');
    const model = await factory({ providerId: 'openrouter', modelId: 'moonshotai/kimi-k3' });
    expect(model).toBeTruthy();
  });
});

const DOC = `# Native Agent Harness Reviews

Intro text.

---

## Review: Existing Model — 2026-08-01

Body of an existing review.

---

## Prompt for other agents

Prompt block here.
`;

describe('appendReview', () => {
  it('inserts the new section above the prompt block, not at the end of the file', () => {
    const out = appendReview(DOC, { label: 'New Model', modelId: 'v/new', review: 'My review.' }, '2026-08-06');
    expect(out.indexOf('## Review: New Model')).toBeLessThan(out.indexOf('## Prompt for other agents'));
  });

  it('leaves every existing review byte-identical', () => {
    const out = appendReview(DOC, { label: 'New Model', modelId: 'v/new', review: 'My review.' }, '2026-08-06');
    expect(out).toContain('## Review: Existing Model — 2026-08-01\n\nBody of an existing review.');

    // A substring-presence check only proves that text exists SOMEWHERE in the
    // output — it would still pass if the new section duplicated the existing
    // one, reordered content, or corrupted the intro/separators outside that one
    // substring. Prove byte-identity for real: the output must equal the
    // original document with exactly one contiguous block inserted at exactly
    // one point (right above the prompt heading). Splitting the original at that
    // point and comparing both halves against the corresponding slices of `out`
    // establishes nothing outside the inserted block changed, in either direction.
    const insertAt = DOC.indexOf('## Prompt for other agents');
    expect(out.slice(0, insertAt)).toBe(DOC.slice(0, insertAt));
    expect(out.slice(out.indexOf('## Prompt for other agents'))).toBe(DOC.slice(insertAt));
  });

  it('signs the section with the model label and id', () => {
    const out = appendReview(DOC, { label: 'New Model', modelId: 'v/new', review: 'My review.' }, '2026-08-06');
    expect(out).toContain('## Review: New Model — 2026-08-06');
    expect(out).toContain('v/new');
  });

  it('refuses to write an empty review rather than adding a hollow section', () => {
    expect(() => appendReview(DOC, { label: 'X', modelId: 'v/x', review: '   ' }, '2026-08-06')).toThrow(/empty/i);
  });

  it('appends at the end when the doc has no prompt block', () => {
    const out = appendReview('# Doc\n', { label: 'X', modelId: 'v/x', review: 'r' }, '2026-08-06');
    expect(out).toContain('## Review: X — 2026-08-06');
  });
});
