// Regression pins for the 2026-08-01 harness tool-honesty review (Tasks 6-9):
// Grep's error advice, Grep/Glob path-format agreement, Grep's per-file/output
// caps, and Glob's "newest first" claim.
import { describe, it, expect } from 'vitest';
import { grepErrorMessage } from '../src/main/harness/tools/grep';

describe('grepErrorMessage', () => {
  const P = '/ws/youcoded/desktop/src/main';
  const CWD = '/ws';

  it('keeps regex advice when ripgrep actually reported a regex parse error', () => {
    const err = 'rg: regex parse error:\n  (?:ipcMain\\.handle(()\n                    ^\nerror: unclosed group';
    const out = grepErrorMessage(err, P, CWD);
    expect(out).toContain('unclosed group');
    expect(out).toContain('Check the regex syntax.');
  });

  it('names the path and workspace root when ripgrep reported a missing directory', () => {
    const err = `rg: ${P}: IO error for operation on ${P}: No such file or directory (os error 2)`;
    const out = grepErrorMessage(err, P, CWD);
    expect(out).toContain(P);
    expect(out).toContain(CWD);
    // The wrong path was the whole problem. Never send the model regex-hunting.
    expect(out).not.toContain('Check the regex syntax.');
  });

  it('offers NO advice when the failure matches neither shape', () => {
    const out = grepErrorMessage('rg: something entirely unexpected', P, CWD);
    expect(out).toContain('something entirely unexpected');
    expect(out).not.toContain('Check the regex syntax.');
    expect(out).not.toContain('does not exist');
  });
});
