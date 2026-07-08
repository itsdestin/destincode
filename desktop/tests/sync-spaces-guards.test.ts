import { describe, it, expect } from 'vitest';
import {
  validateSyncName, DEFAULT_IGNORES, MAX_SYNC_FILE_BYTES,
  conflictCopyName, findCaseCollisions,
} from '../src/main/sync-spaces/guards';

describe('validateSyncName', () => {
  it('accepts normal names', () => {
    expect(validateSyncName('budget-app')).toBeNull();
    expect(validateSyncName('My Notes 2026')).toBeNull();
  });
  it('rejects Windows reserved device names (any case, with extension)', () => {
    expect(validateSyncName('CON')).toMatch(/reserved/i);
    expect(validateSyncName('aux.txt')).toMatch(/reserved/i);
    expect(validateSyncName('com1')).toMatch(/reserved/i);
  });
  it('rejects characters invalid on Windows', () => {
    for (const bad of ['a<b', 'a>b', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b']) {
      expect(validateSyncName(bad)).toMatch(/character/i);
    }
  });
  it('rejects empty, dot-only, and trailing dot/space names', () => {
    expect(validateSyncName('')).toBeTruthy();
    expect(validateSyncName('.')).toBeTruthy();
    expect(validateSyncName('name.')).toBeTruthy();
    expect(validateSyncName('name ')).toBeTruthy();
  });
});

describe('DEFAULT_IGNORES', () => {
  it('covers the spec §8 credential + junk set', () => {
    for (const p of ['node_modules/', '.youcoded/', '.git/', '.env', '*.pem', '.DS_Store']) {
      expect(DEFAULT_IGNORES).toContain(p);
    }
  });
});

describe('MAX_SYNC_FILE_BYTES', () => {
  it('is 50MB per spec §7', () => expect(MAX_SYNC_FILE_BYTES).toBe(50 * 1024 * 1024));
});

describe('conflictCopyName', () => {
  const d = new Date('2026-07-03T14:00:00Z');
  it('inserts device + date before the extension', () => {
    expect(conflictCopyName('docs/notes.md', 'Laptop', d))
      .toBe('docs/notes (from Laptop, 2026-07-03).md');
  });
  it('handles extensionless files', () => {
    expect(conflictCopyName('Makefile', 'Laptop', d))
      .toBe('Makefile (from Laptop, 2026-07-03)');
  });
});

describe('findCaseCollisions', () => {
  it('groups paths differing only by case', () => {
    expect(findCaseCollisions(['a/Readme.md', 'a/readme.md', 'b/x.ts']))
      .toEqual([['a/Readme.md', 'a/readme.md']]);
  });
  it('returns empty when no collisions', () => {
    expect(findCaseCollisions(['a.ts', 'b.ts'])).toEqual([]);
  });
});
