import { describe, it, expect } from 'vitest';
import { isFileLockError } from '../src/main/prerequisite-installer';

// Pins the file-lock detection used by installClaude's retry loop and the
// friendly-error mapping. The strings below are the real shapes seen in the
// wild: Anthropic's bootstrap surfaces a Windows sharing violation as
// "being used by another process" / "cannot access the file" (PowerShell
// Invoke-WebRequest -OutFile), and Node raises EBUSY for the same condition.
// Root case captured 2026-05-30 from a real first-run install.
describe('isFileLockError', () => {
  it('matches the real bootstrap sharing-violation message', () => {
    const msg =
      "Failed to download binary: The process cannot access the file " +
      "'C:\\Users\\Conno\\.claude\\downloads\\claude-2.1.158-win32-x64.exe' " +
      'because it is being used by another process.';
    expect(isFileLockError(msg)).toBe(true);
  });

  it('matches assorted lock phrasings (case-insensitive)', () => {
    expect(isFileLockError('being used by another process')).toBe(true);
    expect(isFileLockError('cannot access the file')).toBe(true);
    expect(isFileLockError('Sharing violation on path X')).toBe(true);
    expect(isFileLockError('lock violation')).toBe(true);
    expect(isFileLockError('Error: EBUSY: resource busy or locked')).toBe(true);
    expect(isFileLockError('ERROR_SHARING_VIOLATION')).toBe(true);
  });

  it('does NOT match unrelated install failures', () => {
    expect(isFileLockError('spawn powershell.exe ENOENT')).toBe(false);
    expect(isFileLockError('HTTP 404 downloading claude.exe')).toBe(false);
    expect(isFileLockError('Neither curl nor wget is installed.')).toBe(false);
    expect(isFileLockError('')).toBe(false);
  });
});
