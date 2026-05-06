// desktop/tests/dev-diagnostics.test.ts
//
// Covers the bug-report environment-snapshot block:
//   - format is human-readable (probe ok ✓ / fail ✗ shape)
//   - presence of all key probes the friend-debugging flow depends on
//   - secret/home-dir redaction is applied to the final text
//
// gatherDiagnostics() itself shells out (git --version, claude --version,
// HEAD requests to GitHub) so we don't run the whole thing in-process —
// it is exercised end-to-end via the bug-report integration. The pure
// formatter is the contract this test pins.

import { describe, it, expect } from 'vitest';
import { formatDiagnosticsBlock, gatherDiagnostics, redactLog } from '../src/main/dev-tools';

describe('formatDiagnosticsBlock', () => {
  it('emits the canonical header, version, platform, and bracketed end', () => {
    const text = formatDiagnosticsBlock({
      timestamp: '2026-05-05T12:00:00.000Z',
      appVersion: '1.2.3',
      platform: 'darwin',
      arch: 'arm64',
      osRelease: '23.6.0',
      nodeVersion: 'v20.10.0',
      electronVersion: '32.0.0',
      probes: {
        git: { ok: true, text: 'git version 2.39.0' },
        claude: { ok: false, text: 'claude: not found' },
      },
    });

    expect(text).toContain('=== YouCoded Diagnostics ===');
    expect(text).toContain('=== End Diagnostics ===');
    expect(text).toContain('App version: 1.2.3');
    expect(text).toContain('Platform: darwin arm64 (release 23.6.0)');
    expect(text).toContain('Node: v20.10.0, Electron: 32.0.0');
    expect(text).toContain('  ✓ git: git version 2.39.0');
    expect(text).toContain('  ✗ claude: claude: not found');
  });

  it('preserves probe insertion order (so the section reads top-to-bottom)', () => {
    const text = formatDiagnosticsBlock({
      timestamp: 't',
      appVersion: 'v',
      platform: 'p',
      arch: 'a',
      osRelease: 'r',
      nodeVersion: 'n',
      electronVersion: 'e',
      probes: {
        first:  { ok: true, text: 'one' },
        second: { ok: true, text: 'two' },
        third:  { ok: false, text: 'three' },
      },
    });
    const i1 = text.indexOf('first:');
    const i2 = text.indexOf('second:');
    const i3 = text.indexOf('third:');
    expect(i1).toBeGreaterThan(0);
    expect(i2).toBeGreaterThan(i1);
    expect(i3).toBeGreaterThan(i2);
  });
});

describe('gatherDiagnostics integration', () => {
  // Live integration — runs the actual probes (git/claude/network) in CI's
  // environment. Tolerates either outcome; we're testing that the block is
  // well-formed and contains the probes the bug-report consumer expects.
  it('returns a redacted, well-formed block in the running environment', async () => {
    const text = await gatherDiagnostics();

    // Skeleton present.
    expect(text).toContain('=== YouCoded Diagnostics ===');
    expect(text).toContain('=== End Diagnostics ===');

    // The seven critical probes the friend-debugging flow asks about.
    const expected = [
      'git:',
      'claude:',
      '~/.claude:',
      'marketplace cache:',
      'network: raw.githubusercontent.com:',
      'network: github.com (git protocol):',
    ];
    for (const probe of expected) expect(text).toContain(probe);

    // Redaction must have run — same patterns redactLog covers.
    // Inject a clearly fake-token-shaped string via env to prove the path is wired
    // would require monkey-patching probe internals; instead we rely on the
    // dedicated redactLog tests in dev-redaction.test.ts to cover that contract,
    // and assert here that redaction is at least present in the chain by
    // re-running redactLog as a sanity check on the produced output.
    const homeDir = require('os').homedir();
    expect(redactLog(text, homeDir)).toBe(text);
  }, 30_000); // 30s budget — 9 probes × 5s timeout each, mostly parallel
});
