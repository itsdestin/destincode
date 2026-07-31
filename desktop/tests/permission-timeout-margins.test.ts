import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Pins the §1 tier margins by reading the LITERALS, not process.env-resolved
// values (the env override would make an env-based test pass vacuously —
// spec §Constraints). All six sites live in this one repo.
//
// Structure note (for tasks 7/8, which EXTEND this file): the file-reading
// helpers below (repoRoot, read, literal) are module-scope and generic —
// Task 7 adds an APP_HOLD_MS assertion reading desktop/src/main/hook-relay.ts,
// Task 8 adds a PERMISSION_HOLD_MS assertion reading EventBridge.kt. Both can
// reuse `literal()` as-is.
const repoRoot = path.resolve(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');

function literal(file: string, re: RegExp): number {
  const m = read(file).match(re);
  if (!m) throw new Error(`pattern ${re} not found in ${file}`);
  return parseInt(m[1].replace(/_/g, ''), 10);
}

const RELAY_RE = /CLAUDE_RELAY_TIMEOUT \|\| '(\d+)'/;

describe('permission timeout tier margins (2026-07-30 spec §1)', () => {
  const desktopRelay = () => literal('desktop/hook-scripts/relay-blocking.js', RELAY_RE);
  const androidRelay = () => literal('app/src/main/assets/hook-relay-blocking.js', RELAY_RE);
  const desktopCcSeconds = () =>
    literal('desktop/scripts/install-hooks.js', /command: expectedBlockingCmd, timeout: (\d+)/);
  const androidCcSeconds = () => literal(
    'app/src/main/kotlin/com/youcoded/app/runtime/Bootstrap.kt',
    /PERMISSION_HOOK_TIMEOUT_SECONDS = ([\d_]+)/);

  it('relay backstop is 2h30m on both platforms', () => {
    expect(desktopRelay()).toBe(9000000);
    expect(androidRelay()).toBe(9000000);
  });

  it('CC hook entry is 3h on both platforms', () => {
    expect(desktopCcSeconds()).toBe(10800);
    expect(androidCcSeconds()).toBe(10800);
  });

  it('relay fires strictly BEFORE CC, with a real margin', () => {
    // CC winning is the bad outcome: hook killed with no decision →
    // AskUserQuestion waits forever on its default-"never" question timeout.
    expect(desktopRelay()).toBeLessThanOrEqual(desktopCcSeconds() * 1000 - 15 * 60 * 1000);
    expect(androidRelay()).toBeLessThanOrEqual(androidCcSeconds() * 1000 - 15 * 60 * 1000);
  });

  it('every value is under the 32-bit setTimeout ceiling', () => {
    for (const v of [desktopRelay(), androidRelay(), desktopCcSeconds() * 1000, androidCcSeconds() * 1000]) {
      expect(v).toBeLessThan(2147483647); // overflow fires IMMEDIATELY — the bug, disguised
    }
  });

  const appHold = () => literal('desktop/src/main/hook-relay.ts', /APP_HOLD_MS = ([\d_]+)/);
  it('app hold is 2h and strictly under the relay backstop', () => {
    expect(appHold()).toBe(7200000);
    expect(appHold()).toBeLessThanOrEqual(desktopRelay() - 15 * 60 * 1000);
  });
});
