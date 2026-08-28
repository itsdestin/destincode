// The Windows half of "honestly killed": no process group to signal, so the
// tree is torn down with taskkill /T /F, falling back to child.kill() when
// taskkill itself cannot start. Unit-mocked — this runs on every platform.
import { describe, it, expect, vi, afterEach } from 'vitest';

const spawnMock = vi.fn();
vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  return { ...real, spawn: (...args: any[]) => spawnMock(...args) };
});

describe('killTree on win32', () => {
  const realPlatform = process.platform;
  afterEach(() => { Object.defineProperty(process, 'platform', { value: realPlatform }); vi.resetModules(); spawnMock.mockReset(); });

  it('spawns taskkill /PID <pid> /T /F', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    spawnMock.mockReturnValue({ on: vi.fn() });
    const { killTree } = await import('../src/main/harness/shell-registry');
    const child: any = { pid: 4242, kill: vi.fn(), exitCode: null, signalCode: null };
    killTree(child);
    expect(spawnMock).toHaveBeenCalledWith('taskkill', ['/PID', '4242', '/T', '/F'], expect.objectContaining({ windowsHide: true }));
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('falls back to child.kill() when taskkill cannot start', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    let onError: ((e: Error) => void) | undefined;
    spawnMock.mockReturnValue({ on: (ev: string, cb: any) => { if (ev === 'error') onError = cb; } });
    const { killTree } = await import('../src/main/harness/shell-registry');
    const child: any = { pid: 4242, kill: vi.fn(), exitCode: null, signalCode: null };
    killTree(child);
    onError!(new Error('ENOENT'));
    expect(child.kill).toHaveBeenCalled();
  });
});
