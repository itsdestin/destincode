// Guards the suite-wide HOME sandbox configured in vitest.config.ts.
//
// Why this file exists: sync-warnings-lifecycle.test.ts spent months reading
// and DELETING the developer's real ~/.claude/.sync-warnings.json — a file a
// running YouCoded owns and rewrites at launch. It surfaced as an intermittent
// failure (ROADMAP :130), not as an obvious "this test edits production",
// because the test file never referenced the home directory: sync-state.ts
// resolved it internally at import time.
//
// vitest.config.ts now points HOME/USERPROFILE at a throwaway dir so that class
// of mistake cannot reach real state. That redirect is invisible — nothing else
// fails if someone deletes it during a config cleanup — so these assertions
// exist to make its removal loud and self-explaining.
import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import fs from 'fs';

describe('test-suite home isolation', () => {
  it('os.homedir() resolves to the sandbox, not the real home', () => {
    // The check that matters: every module resolving a path from os.homedir()
    // — directly or several imports deep — must land in the sandbox.
    expect(os.homedir()).toBe(path.join(os.tmpdir(), 'youcoded-vitest-home'));
  });

  it('the sandbox is not the developer real home', () => {
    const real = process.env.YOUCODED_REAL_HOME;
    expect(real, 'YOUCODED_REAL_HOME missing — vitest.config.ts env block changed').toBeTruthy();
    expect(os.homedir()).not.toBe(real);
  });

  it('writing ~/.claude state cannot escape the sandbox', () => {
    // End-to-end proof rather than a restatement of the config: resolve a path
    // the way the app's modules do, write to it, and confirm the bytes landed
    // in the sandbox and NOT in the real home.
    const claudeDir = path.join(os.homedir(), '.claude');
    const probe = path.join(claudeDir, '.home-isolation-probe');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(probe, 'probe');
    try {
      expect(fs.existsSync(probe)).toBe(true);
      const realProbe = path.join(process.env.YOUCODED_REAL_HOME!, '.claude', '.home-isolation-probe');
      expect(fs.existsSync(realProbe)).toBe(false);
    } finally {
      fs.rmSync(probe, { force: true });
    }
  });

  it('HOME and USERPROFILE agree, so the redirect holds on every platform', () => {
    // os.homedir() reads HOME on POSIX and USERPROFILE on Windows. Setting only
    // one would sandbox one CI leg and leave the other pointed at real state —
    // the worst outcome, because it would look green where it was tested.
    expect(process.env.HOME).toBe(os.homedir());
    expect(process.env.USERPROFILE).toBe(os.homedir());
  });
});
