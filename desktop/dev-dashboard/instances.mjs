// Owns every dev instance this helper started.
//
// WHY own the child rather than probe ports: scripts/run-dev.sh ends in
// `npm run dev` in the FOREGROUND — it does not background itself — so the handle
// we get back IS the instance. "Running" is then a fact rather than an inference,
// and Stop kills a pid we already hold. It is never a pattern match: a `pkill -f`
// matches the shell running the command that issued it, which has killed the wrong
// process on this machine before.
import { spawn } from 'node:child_process';
import path from 'node:path';

// Spaced by 10 so each instance's Vite / remote-server / debugger ports cannot
// overlap the next one's. Two instances sharing an offset SIGKILL each other's
// window silently — that collision is possible by hand today.
export const OFFSET_POOL = [50, 60, 70, 80, 90, 100, 110, 120];

export function takeOffset(taken) {
  const free = OFFSET_POOL.find((o) => !taken.includes(o));
  if (free === undefined) throw new Error('no free port offset: too many dev instances running');
  return free;
}

const instances = new Map(); // checkout id -> Instance

export function list() {
  // `log` is internal bookkeeping and can be large; it never crosses the wire.
  return [...instances.values()].map(({ log, ...rest }) => rest);
}

export function start(checkout, { workspaceRoot }) {
  const existing = instances.get(checkout.id);
  if (existing && existing.status !== 'exited') {
    const { log, ...rest } = existing;
    return rest;
  }

  const offset = takeOffset(
    [...instances.values()].filter((i) => i.status !== 'exited').map((i) => i.offset),
  );
  const profile = `dash-${offset}`;

  // Argument ARRAY, never a shell string: nothing from a request is interpolated
  // into a command. The checkout was chosen by id from our own enumerated list, so
  // its path came from git, not from the network.
  const child = spawn(
    'bash',
    [
      path.join(workspaceRoot, 'scripts', 'run-dev.sh'),
      '--path', checkout.path,
      '--offset', String(offset),
      '--profile', profile,
      '--label', checkout.branch ?? checkout.name,
    ],
    { cwd: workspaceRoot, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const inst = {
    id: checkout.id,
    offset,
    profile,
    pid: child.pid,
    startedAt: Date.now(),
    status: 'starting',
    exitCode: null,
    error: null,
    log: [],
  };

  const note = (buf) => {
    const text = String(buf);
    inst.log.push(text);
    if (inst.log.length > 200) inst.log.shift();
    // run-dev.sh prints this line once it has resolved the checkout and is about
    // to hand off to Electron.
    if (inst.status === 'starting' && /Starting YouCoded dev/.test(text)) inst.status = 'running';
  };
  child.stdout.on('data', note);
  child.stderr.on('data', note);

  child.on('exit', (code) => {
    inst.status = 'exited';
    inst.exitCode = code;
    // A dev instance that dies in the first few seconds failed to start; say so
    // with the script's own last words rather than a guess at the cause.
    if (code !== 0 && Date.now() - inst.startedAt < 15000) {
      inst.error = inst.log.join('').trim().split('\n').slice(-4).join('\n');
    }
  });
  child.on('error', (e) => {
    inst.status = 'exited';
    inst.exitCode = -1;
    inst.error = `could not start run-dev.sh: ${e.message}`;
  });

  instances.set(checkout.id, inst);
  const { log, ...rest } = inst;
  return rest;
}

export function stop(id) {
  const inst = instances.get(id);
  if (!inst || inst.status === 'exited') return false;
  try {
    // Negative pid = the whole process GROUP. run-dev.sh spawns Vite and Electron
    // as children; killing only the script would orphan both, and an orphaned Vite
    // holds the port the next launch needs.
    process.kill(-inst.pid, 'SIGTERM');
  } catch {
    return false;
  }
  inst.status = 'exited';
  return true;
}

/** Kill everything we started. Called when the helper shuts down, so Ctrl-C does
 *  not leave orphaned Electron windows holding ports — CLAUDE.md's "shut the dev
 *  server down" rule, enforced instead of remembered. */
export function stopAll() {
  for (const inst of instances.values()) {
    if (inst.status !== 'exited') stop(inst.id);
  }
}
