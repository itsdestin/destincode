import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Guard for the 2026-08-05 quit-route fix.
//
// `main.ts` cannot be imported in a test — it runs Electron app setup at module
// top level — so this pins the invariant against the SOURCE TEXT, the same
// idiom ipc-channels.test.ts uses for preload.ts. That makes it a weaker guard
// than a behavioral test (it proves the listeners are registered, not that they
// tear down correctly), and it is deliberately the weakest link in this fix.
// Verifying the actual teardown means quitting a real app on each route, which
// is a manual check.
//
// What it prevents is the specific regression that caused the bug: for months
// `window-all-closed` was the app's ONLY quit-related listener, so macOS Cmd+Q,
// dock quit, and an OS-shutdown SIGTERM ran no teardown at all — leaking
// llama-server (which holds its fixed port for the next launch to wrongly
// adopt), the hook relay's pipe, sync watchers, and every stdio MCP server's
// spawned subprocess. Nothing failed loudly when that was true, which is
// exactly why it survived so long. If someone deletes a route here, this fails.
describe('app quit routes', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8');

  it('registers teardown on all three quit routes', () => {
    // Route 1 — last window closed.
    expect(src).toMatch(/app\.on\(\s*'window-all-closed'/);
    // Route 2 — app.quit() from anywhere: macOS Cmd+Q, dock quit, menu quit.
    // before-quit specifically, because it is the only cancellable one and so
    // the only one that can hold the process open for an async teardown.
    expect(src).toMatch(/app\.on\(\s*'before-quit'/);
    // Route 3 — OS shutdown / logout / kill / Ctrl+C, which never reach
    // Electron's quit events at all.
    expect(src).toMatch(/'SIGTERM'/);
    expect(src).toMatch(/'SIGINT'/);
  });

  it('routes every quit through one idempotent teardown', () => {
    // A single named teardown, not the body copy-pasted per route — three
    // copies would drift, and the whole failure mode here is a route quietly
    // doing less than the others.
    expect(src).toMatch(/function shutdownApp\(\)/);
    // Idempotence is load-bearing, not defensive: before-quit fires a SECOND
    // time when the handler re-issues app.quit(), and window-all-closed can
    // fire alongside it. Without the guard, teardown runs twice per quit.
    expect(src).toMatch(/if \(shuttingDown\) return shuttingDown;/);
    // before-quit must cancel the first pass, or the process exits before an
    // async teardown can finish and the leak is unchanged.
    expect(src).toMatch(/e\.preventDefault\(\)/);
  });
});
