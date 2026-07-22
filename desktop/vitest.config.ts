import { defineConfig } from 'vitest/config';
import path from 'path';
import fs from 'fs';
import os from 'os';
import react from '@vitejs/plugin-react';

// A throwaway HOME for the whole suite.
//
// The developer's real ~/.claude is a RUNNING YouCoded's live state — the app
// reads and writes .sync-warnings.json, toolkit-state/, backup.log while it is
// open. A test that reaches it is both editing production and racing a second
// process, which is exactly how sync-warnings-lifecycle.test.ts came to fail
// intermittently for months (ROADMAP :130).
//
// Note what that bug looked like: the TEST FILE never mentioned the home
// directory at all. sync-state.ts resolved it internally at import time. So no
// amount of reviewing test files would have caught it, and a detection-based
// tripwire would have reported it as a mystery diff. Redirecting HOME instead
// makes the whole class structurally impossible: os.homedir() reads HOME on
// POSIX and USERPROFILE on Windows, so every module resolving a path from it —
// directly or three imports deep — lands in the sandbox.
//
// Reset once per run by tests/global-setup.ts — NOT here. This module is
// evaluated in more than one process, so wiping at config load races workers
// that are already writing into the sandbox. The mkdir below is idempotent and
// safe to repeat; it exists so the directory is present even if globalSetup is
// bypassed (e.g. an editor running a single file).
// Pinned by tests/home-isolation.test.ts; delete that test and this becomes
// silently load-bearing for nothing.
const TEST_HOME = path.join(os.tmpdir(), 'youcoded-vitest-home');
fs.mkdirSync(path.join(TEST_HOME, '.claude'), { recursive: true });

export default defineConfig({
  // Fix: include the React plugin so TSX test files (JSX transform) compile correctly
  plugins: [react()],
  test: {
    include: ['tests/**/*.{test,spec}.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
    globalSetup: ['tests/global-setup.ts'],
    // Fix: use jsdom for .tsx test files (React components) so DOM APIs are available;
    // plain .ts files (main-process logic) stay in 'node' via environmentMatchGlobs.
    environment: 'node',
    environmentMatchGlobs: [
      ['tests/**/*.tsx', 'jsdom'],
    ],
    alias: {
      // Stub Electron APIs so main-process imports don't crash in Node.js
      electron: path.resolve(__dirname, 'tests/__mocks__/electron.ts'),
    },
    // Both vars: os.homedir() consults HOME on POSIX and USERPROFILE on Windows.
    // YOUCODED_REAL_HOME lets the isolation guard prove the redirect actually
    // moved (it cannot read the original HOME once overridden).
    env: {
      HOME: TEST_HOME,
      USERPROFILE: TEST_HOME,
      YOUCODED_REAL_HOME: os.homedir(),
    },
  },
});
