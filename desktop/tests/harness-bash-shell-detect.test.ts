// detectShell() had ZERO test coverage until 2026-07-19, which is how the
// Windows branch shipped probing only two hardcoded Program Files paths.
// These tests drive it as a pure function via mocked fs/which, so they run
// identically on every CI platform (the win32 cases never touch a real disk).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const existsMock = vi.fn<(p: string) => boolean>();
const whichMock = vi.fn<(c: string, o?: any) => string | null>();

vi.mock('fs', async (importActual) => {
  const actual = await importActual<typeof import('fs')>();
  return { ...actual, existsSync: (p: any) => existsMock(String(p)) };
});
vi.mock('which', () => ({ sync: (c: string, o?: any) => whichMock(c, o) }));

import { detectShell, getShell, resetShellCache } from '../src/main/harness/tools/bash';

const realPlatform = process.platform;
function setPlatform(p: string) {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => {
  existsMock.mockReset().mockReturnValue(false);
  whichMock.mockReset().mockReturnValue(null);
  resetShellCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  setPlatform(realPlatform);
  resetShellCache();
  vi.restoreAllMocks();
  delete process.env.CLAUDE_CODE_GIT_BASH_PATH;
});

describe('detectShell', () => {
  it('uses /bin/bash off win32 without probing the filesystem', () => {
    setPlatform('linux');
    expect(detectShell()).toEqual({ cmd: '/bin/bash', args: ['-c'], label: 'bash' });
    expect(existsMock).not.toHaveBeenCalled();
  });

  it('finds Git Bash at the default Program Files path', () => {
    setPlatform('win32');
    existsMock.mockImplementation((p) => p === 'C:/Program Files/Git/bin/bash.exe');
    const s = detectShell();
    expect(s.cmd).toBe('C:/Program Files/Git/bin/bash.exe');
    expect(s.label).toBe('bash (Git Bash)');
  });

  // The regression that motivated this file: git installed anywhere other than
  // the two hardcoded paths (scoop/choco user-scope, a D: drive) resolved to
  // PowerShell even though git.exe was plainly on PATH.
  it('derives bash.exe from git.exe for a NON-default install location', () => {
    setPlatform('win32');
    whichMock.mockImplementation((c) => (c === 'git' ? 'D:\\Tools\\Git\\cmd\\git.exe' : null));
    const derived = 'D:\\Tools\\Git\\bin\\bash.exe';
    existsMock.mockImplementation((p) => p === derived);
    expect(detectShell().cmd).toBe(derived);
  });

  it('honors CLAUDE_CODE_GIT_BASH_PATH above everything else', () => {
    setPlatform('win32');
    process.env.CLAUDE_CODE_GIT_BASH_PATH = 'E:\\custom\\bash.exe';
    existsMock.mockReturnValue(true); // every candidate "exists" — override must still win
    expect(detectShell().cmd).toBe('E:\\custom\\bash.exe');
  });

  // System32\bash.exe is the WSL launcher. Using it would run commands in a
  // Linux VM against a Windows cwd, so every path would be wrong — strictly
  // worse than the PowerShell fallback.
  it('never selects the WSL launcher at System32\\bash.exe', () => {
    setPlatform('win32');
    whichMock.mockImplementation((c) => (c === 'bash' ? 'C:\\Windows\\System32\\bash.exe' : null));
    existsMock.mockImplementation((p) => p === 'C:\\Windows\\System32\\bash.exe');
    expect(detectShell().label).toBe('PowerShell');
  });

  it('falls back to PowerShell and WARNS when no bash exists', () => {
    setPlatform('win32');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = detectShell();
    expect(s).toEqual({ cmd: 'powershell.exe', args: ['-NoProfile', '-Command'], label: 'PowerShell' });
    // Silence here is what kept this invisible in bug reports.
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(/CLAUDE_CODE_GIT_BASH_PATH/);
  });
});

describe('getShell', () => {
  it('memoizes so repeated tool calls do not re-probe the disk', () => {
    setPlatform('win32');
    getShell();
    const callsAfterFirst = existsMock.mock.calls.length;
    getShell();
    getShell();
    expect(existsMock.mock.calls.length).toBe(callsAfterFirst);
  });

  // The timing bug: main.ts -> ipc-handlers.ts -> bash.ts all import eagerly, so
  // resolving at module load pinned a new Windows user to PowerShell for the
  // whole session even after first-run's `winget install Git.Git` delivered bash.
  it('resolves on FIRST USE, so a git install during first-run still counts', () => {
    setPlatform('win32');
    expect(existsMock).not.toHaveBeenCalled(); // nothing probed at import
    existsMock.mockImplementation((p) => p === 'C:/Program Files/Git/bin/bash.exe');
    expect(getShell().label).toBe('bash (Git Bash)');
  });
});
