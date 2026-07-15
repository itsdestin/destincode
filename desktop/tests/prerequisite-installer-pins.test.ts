// desktop/tests/prerequisite-installer-pins.test.ts
// Pins the Windows-spawn invariants in prerequisite-installer.ts that previously
// had no unit guard (see .claude/rules/prereq-installer.md — "Guard: none — candidate").
import { describe, it, expect } from 'vitest';
import {
  shouldUseShell,
  getRegPath,
  getPowerShellPath,
} from '../src/main/prerequisite-installer';

// Invariant 1: runCommand flips `shell: true` ONLY for Windows .cmd/.bat shims
// (the CVE-2024-27980 EINVAL mitigation). Real .exe/bare paths must stay
// shell:false so the no-shell-injection guarantee holds; non-Windows never
// needs the shell flag.
describe('shouldUseShell (runCommand shell-flag decision)', () => {
  it('uses shell for .cmd/.bat on win32 (case-insensitive)', () => {
    expect(shouldUseShell('C:\\Program Files\\nodejs\\npm.cmd', 'win32')).toBe(true);
    expect(shouldUseShell('npm.CMD', 'win32')).toBe(true);
    expect(shouldUseShell('foo.bat', 'win32')).toBe(true);
  });

  it('does NOT use shell for .exe or bare commands on win32', () => {
    expect(shouldUseShell('C:\\Windows\\System32\\reg.exe', 'win32')).toBe(false);
    expect(shouldUseShell('claude.exe', 'win32')).toBe(false);
    expect(shouldUseShell('git', 'win32')).toBe(false);
  });

  it('never uses shell off Windows, even for .cmd/.bat', () => {
    expect(shouldUseShell('npm.cmd', 'darwin')).toBe(false);
    expect(shouldUseShell('foo.bat', 'linux')).toBe(false);
  });
});

// Invariant 2: getRegPath() returns a QUOTED path (interpolated into a cmd.exe
// execSync string) while getPowerShellPath() returns an UNQUOTED path (passed as
// the file arg of execFile with shell:false — embedded quotes would become part
// of the filename and CreateProcess fails with ENOENT). The asymmetry is
// load-bearing. These read System32 via fs.existsSync, so they only resolve to
// the real absolute paths on Windows; on other OSes both fall back to bare names.
describe.runIf(process.platform === 'win32')('reg/powershell path quoting asymmetry', () => {
  it('getRegPath() is quoted and points at reg.exe', () => {
    const reg = getRegPath();
    expect(reg.startsWith('"')).toBe(true);
    expect(reg.endsWith('"')).toBe(true);
    expect(reg.endsWith('reg.exe"')).toBe(true);
  });

  it('getPowerShellPath() is UNQUOTED and points at powershell.exe', () => {
    const ps = getPowerShellPath();
    expect(ps.includes('"')).toBe(false);
    expect(ps.endsWith('powershell.exe')).toBe(true);
  });
});
