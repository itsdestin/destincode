import { describe, it, expect, beforeEach } from 'vitest';
import { installMock } from '../src/renderer/dev/workbench/install-mock';

describe('installMock', () => {
  beforeEach(() => { delete (globalThis as any).window; (globalThis as any).window = {}; });

  it('installs a claude bridge when none exists', () => {
    installMock();
    expect((window as any).claude).toBeTruthy();
  });

  // The load-bearing safety property: it must never shadow a real preload
  // bridge or a live remote shim.
  it('refuses to install over an existing bridge', () => {
    const real = { session: {} };
    (window as any).claude = real;
    installMock();
    expect((window as any).claude).toBe(real);
  });
});
