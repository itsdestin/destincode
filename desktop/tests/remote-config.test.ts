import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Must mock before importing the module
vi.mock('fs');
vi.mock('os');

// child_process.execFile is required() inside detectTailscale. We intercept
// it so each test can deterministically simulate the tailscale CLI's behavior.
// vi.hoisted is required because vi.mock factories run before normal `const`
// declarations are initialized — without hoisting, the closure would capture
// an undefined execFileMock and the real binary would run.
const { execFileMock } = vi.hoisted(() => ({ execFileMock: vi.fn() }));
vi.mock('child_process', () => ({
  execFile: (file: string, args: string[], cb: (err: Error | null, result?: { stdout: string; stderr: string }) => void) => {
    try {
      const stdout = execFileMock(file, args);
      cb(null, { stdout, stderr: '' });
    } catch (err) {
      cb(err as Error);
    }
  },
}));

// `which` is also require()'d inside resolveTailscalePath. Force it to throw
// so the candidate-path fallback runs (and uses our mocked fs.accessSync).
vi.mock('which', () => ({
  default: { sync: () => { throw new Error('not found'); } },
  sync: () => { throw new Error('not found'); },
}));

describe('RemoteConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    vi.mocked(os.homedir).mockReturnValue('/mock/home');
  });

  it('returns defaults when config file does not exist', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig();

    expect(config.enabled).toBe(false);
    expect(config.port).toBe(9900);
    expect(config.passwordHash).toBeNull();
    expect(config.trustTailscale).toBe(false);
  });

  it('loads config from disk', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify({
      enabled: false,
      port: 8080,
      passwordHash: '$2b$10$fakehash',
      trustTailscale: true,
    }));
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig();

    expect(config.enabled).toBe(false);
    expect(config.port).toBe(8080);
    expect(config.passwordHash).toBe('$2b$10$fakehash');
    expect(config.trustTailscale).toBe(true);
  });

  it('setPassword hashes and saves to disk', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig();

    await config.setPassword('test123');

    expect(config.passwordHash).toBeTruthy();
    expect(config.passwordHash).toMatch(/^\$2[ab]\$/);
    expect(fs.writeFileSync).toHaveBeenCalled();
  });

  it('verifyPassword returns true for correct password', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig();

    await config.setPassword('mypass');
    const result = await config.verifyPassword('mypass');

    expect(result).toBe(true);
  });

  it('verifyPassword returns false for wrong password', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.writeFileSync).mockImplementation(() => {});
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any);
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig();

    await config.setPassword('mypass');
    const result = await config.verifyPassword('wrongpass');

    expect(result).toBe(false);
  });

  it('isTailscaleIp detects CGNAT range', async () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const { RemoteConfig } = await import('../src/main/remote-config');
    const config = new RemoteConfig();

    expect(config.isTailscaleIp('100.64.1.1')).toBe(true);
    expect(config.isTailscaleIp('100.127.255.255')).toBe(true);
    expect(config.isTailscaleIp('100.128.0.0')).toBe(false);
    expect(config.isTailscaleIp('192.168.1.1')).toBe(false);
    // IPv6-mapped IPv4
    expect(config.isTailscaleIp('::ffff:100.64.1.1')).toBe(true);
    expect(config.isTailscaleIp('::ffff:192.168.1.1')).toBe(false);
  });

  describe('detectTailscale', () => {
    beforeEach(() => {
      execFileMock.mockReset();
      vi.mocked(fs.existsSync).mockReturnValue(false);
    });

    it('returns installed:false when binary is missing', async () => {
      // No candidate path exists on disk and `tailscale version` is never reached
      // because resolveTailscalePath falls through to the literal 'tailscale',
      // which then fails the version probe.
      vi.mocked(fs.accessSync).mockImplementation(() => { throw new Error('ENOENT'); });
      execFileMock.mockImplementation(() => { throw new Error('ENOENT'); });

      const { RemoteConfig } = await import('../src/main/remote-config');
      const result = await RemoteConfig.detectTailscale(9900);

      expect(result).toEqual({
        installed: false,
        connected: false,
        ip: null,
        hostname: null,
        url: null,
      });
    });

    it('returns installed:true, connected:false when VPN is stopped (regression test)', async () => {
      // Binary exists at a candidate path on disk...
      vi.mocked(fs.accessSync).mockImplementation(() => {});
      // ...but `tailscale status --json` fails because the daemon is stopped.
      // Previously this also tried `tailscale ip -4` first and the failure
      // caused the function to return installed:false. Regression guard.
      execFileMock.mockImplementation((_file: string, args: string[]) => {
        if (args[0] === 'status') throw new Error('failed to connect to local Tailscale daemon');
        if (args[0] === 'ip') throw new Error('Tailscale is stopped');
        return '';
      });

      const { RemoteConfig } = await import('../src/main/remote-config');
      const result = await RemoteConfig.detectTailscale(9900);

      expect(result.installed).toBe(true);
      expect(result.connected).toBe(false);
      expect(result.ip).toBeNull();
      expect(result.url).toBeNull();
    });

    it('returns installed:true, connected:false when daemon reports BackendState !== Running', async () => {
      vi.mocked(fs.accessSync).mockImplementation(() => {});
      execFileMock.mockImplementation((_file: string, args: string[]) => {
        if (args[0] === 'status') return JSON.stringify({ BackendState: 'Stopped', Self: { HostName: 'mybox' } });
        return '';
      });

      const { RemoteConfig } = await import('../src/main/remote-config');
      const result = await RemoteConfig.detectTailscale(9900);

      expect(result.installed).toBe(true);
      expect(result.connected).toBe(false);
      expect(result.hostname).toBe('mybox');
      expect(result.ip).toBeNull();
      expect(result.url).toBeNull();
    });

    it('returns installed:true, connected:true with IP from status JSON when running', async () => {
      vi.mocked(fs.accessSync).mockImplementation(() => {});
      execFileMock.mockImplementation((_file: string, args: string[]) => {
        if (args[0] === 'status') return JSON.stringify({
          BackendState: 'Running',
          Self: { HostName: 'mybox', TailscaleIPs: ['100.64.1.5', 'fd7a:115c::1'] },
        });
        return '';
      });

      const { RemoteConfig } = await import('../src/main/remote-config');
      const result = await RemoteConfig.detectTailscale(9900);

      expect(result.installed).toBe(true);
      expect(result.connected).toBe(true);
      expect(result.hostname).toBe('mybox');
      expect(result.ip).toBe('100.64.1.5');
      expect(result.url).toBe('http://100.64.1.5:9900');
    });

    it('falls back to `tailscale ip -4` when status JSON has no TailscaleIPs', async () => {
      vi.mocked(fs.accessSync).mockImplementation(() => {});
      execFileMock.mockImplementation((_file: string, args: string[]) => {
        if (args[0] === 'status') return JSON.stringify({ BackendState: 'Running', Self: { HostName: 'mybox' } });
        if (args[0] === 'ip') return '100.64.1.5\n';
        return '';
      });

      const { RemoteConfig } = await import('../src/main/remote-config');
      const result = await RemoteConfig.detectTailscale(9900);

      expect(result.connected).toBe(true);
      expect(result.ip).toBe('100.64.1.5');
      expect(result.url).toBe('http://100.64.1.5:9900');
    });
  });
});
