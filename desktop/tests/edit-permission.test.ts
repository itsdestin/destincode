import { describe, it, expect } from 'vitest';
import { canEditArtifact } from '../src/renderer/components/artifact-views/edit-permission';
import { EDIT_MAX_BYTES } from '../src/shared/artifacts/editable-path-policy';

describe('canEditArtifact', () => {
  it('allows an ordinary small text file', () => {
    expect(canEditArtifact({ sizeBytes: 1024 }, 'hi', 'free')).toBe(true);
  });
  it('refuses while content has not resolved', () => {
    expect(canEditArtifact({ sizeBytes: 1024 }, null, 'free')).toBe(false);
  });
  it('refuses a policy-denied path', () => {
    expect(canEditArtifact({ sizeBytes: 1024 }, 'hi', 'denied')).toBe(false);
  });
  it('refuses a binary file', () => {
    expect(canEditArtifact({ binary: true, sizeBytes: 10 }, '', 'free')).toBe(false);
  });
  // The whole point: a prefix must never be savable over the original.
  it('refuses anything larger than the cap, prefix or fully loaded', () => {
    expect(canEditArtifact({ sizeBytes: EDIT_MAX_BYTES + 1, truncated: true }, 'x', 'free')).toBe(false);
    expect(canEditArtifact({ sizeBytes: EDIT_MAX_BYTES + 1, truncated: false }, 'x', 'free')).toBe(false);
  });
  it('keeps working when size is unknown (legacy hosts, workbench fixtures)', () => {
    expect(canEditArtifact({}, 'hi', 'free')).toBe(true);
    expect(canEditArtifact(null, 'hi', 'free')).toBe(true);
  });
});
