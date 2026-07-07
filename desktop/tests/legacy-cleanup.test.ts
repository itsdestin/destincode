import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { cleanupLegacyYoucodedCore } = await import('../src/main/legacy-cleanup');

describe('cleanupLegacyYoucodedCore', () => {
  let tmpHome: string;
  let origHomedir: typeof os.homedir;

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'youcoded-legacy-cleanup-'));
    origHomedir = os.homedir;
    (os as any).homedir = () => tmpHome;
  });

  afterEach(() => {
    (os as any).homedir = origHomedir;
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch {}
  });

  function mkdir(p: string) { fs.mkdirSync(p, { recursive: true }); }
  function write(p: string, content: string) { mkdir(path.dirname(p)); fs.writeFileSync(p, content); }

  it('no-ops and returns removed:false when the legacy directory is absent', () => {
    const result = cleanupLegacyYoucodedCore();
    expect(result.removed).toBe(false);
    expect(result.error).toBeUndefined();
  });

  it('deletes the directory recursively and returns removed:true', () => {
    const legacyDir = path.join(tmpHome, '.claude', 'plugins', 'youcoded-core');
    write(path.join(legacyDir, 'hooks', 'write-guard.sh'), '#!/bin/bash\n');
    write(path.join(legacyDir, 'VERSION'), '1.1.1\n');
    write(path.join(legacyDir, 'nested', 'deep', 'file.txt'), 'content');

    const result = cleanupLegacyYoucodedCore();

    expect(result.removed).toBe(true);
    expect(result.path).toBe(legacyDir);
    expect(fs.existsSync(legacyDir)).toBe(false);
  });

  it('leaves sibling plugin directories alone', () => {
    const legacyDir = path.join(tmpHome, '.claude', 'plugins', 'youcoded-core');
    const siblingDir = path.join(tmpHome, '.claude', 'plugins', 'marketplaces');
    write(path.join(legacyDir, 'VERSION'), '1.1.1\n');
    write(path.join(siblingDir, 'youcoded', 'plugins', 'somepkg', 'plugin.json'), '{}');

    const result = cleanupLegacyYoucodedCore();

    expect(result.removed).toBe(true);
    expect(fs.existsSync(legacyDir)).toBe(false);
    expect(fs.existsSync(siblingDir)).toBe(true);
  });
});
