import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';

// The perf lab (youcoded-dev/scripts/perf-lab) parses these names verbatim.
// Renaming or dropping one silently blanks a column in every future report.
const src = readFileSync(join(__dirname, '..', 'src', 'main', 'main.ts'), 'utf8');
const REQUIRED = [
  'main:module-start', 'main:when-ready',
  'main:chore:rotate-log:done', 'main:chore:install-hooks:done', 'main:chore:hook-relay:done',
  'main:chore:legacy-cleanup:done', 'main:chore:hook-reconcile:done', 'main:chore:prompt-suggestion:done',
  'main:chore:retention-default:done', 'main:chore:symlink-cleanup:done', 'main:chore:stale-downloads:done',
  'main:chore:reconcile-mcp:done', 'main:chore:announcements:done', 'main:chore:remote-server:done',
  'main:chore:theme-protocol:done', 'main:chore:auth-store:done',
  'main:create-window:start', 'main:create-window:done', 'main:main-window:did-finish-load', 'main:post-window:done',
];

describe('main-process perf marks are all present', () => {
  for (const name of REQUIRED) {
    it(name, () => { expect(src).toContain(`perfMark('${name}')`); });
  }
  it('create-window:start precedes the createWindow call in whenReady', () => {
    const a = src.indexOf(`perfMark('main:create-window:start')`);
    const b = src.indexOf('createWindow(isFirstRun ? firstRunManager : undefined)');
    expect(a).toBeGreaterThan(0); expect(b).toBeGreaterThan(a);
  });
});
