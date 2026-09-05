// Entry point for the dev dashboard's helper. Resolves the repo and workspace
// from this file's own location, so it works from any working directory.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from './server.mjs';
import * as instances from './instances.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoDir = path.resolve(here, '..', '..');     // the checkout this helper lives in

/** Find the workspace by walking up for the scripts the dashboard actually runs.
 *  WHY not `repoDir/..`: that is only right for the MAIN checkout. From a worktree
 *  the path is <workspace>/worktrees/<name>, so one level up lands on `worktrees/`
 *  and every Launch and every suite would resolve to a script that isn't there. */
function findWorkspaceRoot(from) {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    if (fs.existsSync(path.join(dir, 'scripts', 'run-dev.sh'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const workspaceRoot = findWorkspaceRoot(repoDir);
if (!workspaceRoot) {
  // Say exactly what was looked for and where. "Workspace not found" would leave
  // the reader with nothing to check.
  console.error(
    `[dev-dashboard] could not find the workspace: no scripts/run-dev.sh in ${repoDir} `
    + 'or any of its parents. Launch and the check suites both need it.',
  );
  process.exit(1);
}
const port = Number(process.env.DEV_DASHBOARD_PORT ?? 5240);
const vitePort = Number(process.env.VITE_PORT ?? 5241);

// Ctrl-C must not leave orphaned dev instances holding ports — CLAUDE.md's
// "shut the dev server down" rule, enforced instead of remembered.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    instances.stopAll();
    process.exit(0);
  });
}

const server = createServer({ repoDir, workspaceRoot, vitePort });
server.on('error', (e) => {
  // Name the real problem. "Port in use" and "permission denied" need different
  // answers from the reader, so the message must say which one happened.
  console.error(`[dev-dashboard] could not listen on ${port}: ${e.message}`);
  process.exit(1);
});
server.listen(port, '127.0.0.1', () => {
  console.log(`[dev-dashboard] http://127.0.0.1:${port}/?mode=dev-dashboard`);
  console.log(`[dev-dashboard] repo: ${repoDir}`);
});
