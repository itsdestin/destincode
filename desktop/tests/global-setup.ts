import fs from 'fs';
import path from 'path';
import os from 'os';

// Resets the suite-wide HOME sandbox (see vitest.config.ts) exactly ONCE per
// run, before any worker starts.
//
// This deliberately does NOT live in vitest.config.ts: that module is evaluated
// in more than one process, so wiping there deletes the directory out from
// under workers that are already writing to it — observed as
// "ENOENT: rename '<sandbox>/.claude/youcoded-skills.json.tmp'" mid-run.
// globalSetup is the only hook that runs once, before everything.
export default function setup() {
  const testHome = path.join(os.tmpdir(), 'youcoded-vitest-home');
  // Fresh each run: a sandbox carrying state from a previous run would make
  // tests pass or fail based on what ran before, which is the failure mode this
  // whole sandbox exists to remove.
  fs.rmSync(testHome, { recursive: true, force: true });
  fs.mkdirSync(path.join(testHome, '.claude'), { recursive: true });
}
