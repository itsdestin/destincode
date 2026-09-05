// The check suites, each with its real weight on the label.
//
// WHY state the weight: the fast one is ten seconds and the UI sweep is five
// minutes with several browsers running at once. Side by side with no weight they
// look equivalent, and one of them slows the machine to a crawl.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// Results live on disk, not only in this process. WHY: a check you ran an hour
// ago is exactly the thing you want when something breaks, and "where did the
// results go?" is not a question a tool should leave you asking. Restarting the
// helper used to erase every verdict.
const RUNS_DIR = process.env.DEV_DASHBOARD_RUNS_DIR
  ?? path.join(os.homedir(), '.youcoded', 'dev-dashboard', 'runs');

function runFile(runId) {
  return path.join(RUNS_DIR, `${runId}.json`);
}

export function runsDir() {
  return RUNS_DIR;
}

function persist(run) {
  try {
    fs.mkdirSync(RUNS_DIR, { recursive: true });
    // Write-then-rename, so a reader never sees a half-written file.
    const tmp = runFile(run.runId) + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(run, null, 1));
    fs.renameSync(tmp, runFile(run.runId));
  } catch {
    // A failed write must not take down a run that is otherwise fine. The
    // in-memory copy still answers for this session.
  }
}

/** Every run this machine has recorded, newest first. Read from disk, so results
 *  from before the last restart are still here. */
export function loadRuns(limit = 200) {
  try {
    return fs.readdirSync(RUNS_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try { return JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf-8')); } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit);
  } catch {
    return [];
  }
}

// A hard ceiling passed on EVERY paid invocation, so a runaway plan cannot spend
// more than this no matter what the page asked for.
const MAX_SPEND_USD = '2.00';

export const SUITES = [
  {
    key: 'verify',
    label: 'Safety check',
    weight: '~10s',
    does: 'Checks this branch still holds together: the code compiles, its tests pass, '
      + 'nothing is left unused, and none of our written rules are broken. This is the one '
      + 'to run before deciding a branch is finished.',
    covers: 'The desktop app only — not Android, not the marketplace server.',
    paid: false,
    argv: (c, ws) => ({ cmd: 'bash', args: [path.join(ws, 'scripts', 'verify.sh'), c.path], cwd: ws }),
  },
  {
    key: 'workbench-boot',
    // Says what it NEEDS, because without a workbench serving its port this
    // refuses with exit 2 — an honest refusal that reads like a failure if the
    // label does not warn you first.
    label: 'Workbench boot check',
    weight: 'seconds · needs the workbench running',
    does: 'Opens every screen of the app in a browser, one after another, and fails if any of '
      + 'them errors on the way up. Catches the case where the tests all pass but the app is '
      + 'blank when you actually open it.',
    covers: 'Needs a workbench already serving. Without one it refuses rather than guessing.',
    paid: false,
    argv: (c, ws) => ({ cmd: 'node', args: [path.join(ws, 'scripts', 'workbench-boot-check.mjs')], cwd: c.path }),
  },
  {
    key: 'docs-audit',
    // Workspace-wide, NOT per-branch: audit-anchors.mjs checks the workspace's
    // own docs and rules, so it gives the same answer from every row. The label
    // says so rather than letting the row imply otherwise.
    label: 'Docs audit',
    weight: 'seconds · whole workspace, not this branch',
    does: 'Checks our own notes and rules still match the code they describe — every file path '
      + 'they name still exists, every claim they pin is still true. Stops sessions acting on '
      + 'instructions that quietly went stale.',
    covers: 'The whole workspace, so it gives the same answer from every row.',
    paid: false,
    argv: (c, ws) => ({ cmd: 'node', args: [path.join(ws, 'scripts', 'audit-anchors.mjs')], cwd: ws }),
  },
  {
    key: 'android',
    label: 'Android tests',
    weight: 'minutes',
    does: "Runs the phone app's own tests. The safety check above does not touch Android at "
      + 'all, so this is the only thing that says whether a change broke the phone build.',
    covers: 'Android only.',
    paid: false,
    // `-x bundleWebUi` is MANDATORY in a worktree: it transitively runs `npm ci`,
    // which is destructive against a hardlinked node_modules (CLAUDE.md). The two
    // env vars are set because ANDROID_HOME is unset on this machine and the
    // system default java is 26, which AGP 8.7 rejects.
    argv: (c) => ({
      cmd: './gradlew',
      args: ['test', '-x', 'bundleWebUi'],
      cwd: c.path,
      env: {
        JAVA_HOME: '/usr/lib/jvm/java-21-openjdk',
        ANDROID_HOME: path.join(process.env.HOME ?? '', '.android-sdk'),
      },
    }),
  },
  {
    key: 'ui-sweep',
    label: 'UI screenshot sweep',
    weight: '~5 min · slows the machine',
    does: 'Opens and photographs every screen, menu and popup in all six themes, then reports '
      + 'anything it could not open and anything unreadable. Use it when a change touches how '
      + 'the app looks.',
    covers: 'Runs several browsers at once and will slow this machine while it works.',
    paid: false,
    argv: (c, ws) => ({
      cmd: 'bash',
      args: [path.join(ws, 'scripts', 'ui-review', 'run-review.sh'), c.path],
      cwd: ws,
    }),
  },
  {
    key: 'model-eval',
    label: 'Model evaluation',
    weight: 'minutes · ~$0.25 a cell',
    does: 'Hires real AI models to actually use the app\'s tools on a task, then grades what '
      + 'they did — twice, once mechanically and once by a judge that has to quote the text it '
      + 'scored. Finds the things ordinary tests cannot, because only a real model exercises '
      + 'the judgement these tools are built for.',
    covers: 'Spends real money. Capped at $2.00 per run, and asks before it starts.',
    paid: true,
    argv: (c) => ({
      cmd: 'node',
      args: [
        path.join(c.path, 'desktop', 'test-engine', 'harness-eval.mjs'),
        '--plan', path.join(c.path, 'desktop', 'test-engine', 'eval-plans', 'prompt-doctrine.json'),
        '--max-spend', MAX_SPEND_USD,
      ],
      cwd: c.path,
    }),
  },
];

export function suiteByKey(key) {
  const s = SUITES.find((x) => x.key === key);
  if (!s) throw new Error(`no suite named ${key}`);
  return s;
}

const runs = new Map();

export const getRun = (id) => runs.get(id) ?? loadRuns().find((r) => r.runId === id);

/** The in-memory runs merged over what is on disk, so a live run's output stays
 *  fresh while yesterday's verdicts are still readable. */
export function listRuns(limit = 200) {
  const merged = new Map();
  for (const r of loadRuns(limit)) merged.set(r.runId, r);
  for (const r of runs.values()) merged.set(r.runId, r);
  return [...merged.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, limit);
}

export async function runSuite(suiteKey, checkout, opts) {
  const suite = suiteByKey(suiteKey);
  const { workspaceRoot, confirmSpend } = opts;

  if (suite.paid) {
    if (!confirmSpend) throw new Error('this suite spends real money — confirm the spend first');
    // harness-eval.mjs refuses to start when OPENROUTER_API_KEY is in its
    // environment, because the models it runs could read it. Refuse here too,
    // rather than letting the child fail with a message the page cannot explain.
    if (process.env.OPENROUTER_API_KEY) {
      throw new Error(
        'OPENROUTER_API_KEY is set in this shell — the evaluator refuses to run with a key '
        + 'the models it hires could read. Start the helper from a shell without it.',
      );
    }
  }

  const { cmd, args, cwd, env } = suite.argv(checkout, workspaceRoot);
  const run = {
    runId: randomUUID(),
    suiteKey,
    checkoutId: checkout.id,
    status: 'running',
    exitCode: null,
    output: '',
    startedAt: Date.now(),
    endedAt: null,
  };
  run.checkoutName = checkout.name;
  run.checkoutBranch = checkout.branch ?? null;
  run.command = [cmd, ...args].join(' ');
  runs.set(run.runId, run);
  persist(run);

  const child = spawn(cmd, args, {
    cwd,
    env: { ...process.env, ...(env ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const append = (b) => {
    run.output += String(b);
    // Cap the buffer: the UI sweep prints a great deal and this is held in memory.
    // Keeping the TAIL is deliberate — the verdict is always at the end.
    if (run.output.length > 512 * 1024) run.output = run.output.slice(-512 * 1024);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  child.on('exit', (code) => {
    run.exitCode = code;
    run.status = code === 0 ? 'passed' : 'failed';
    run.endedAt = Date.now();
    persist(run);
  });
  child.on('error', (e) => {
    run.status = 'failed';
    run.exitCode = -1;
    // The real error, not a guess: a missing ./gradlew reads very differently from
    // a failing test, and the message has to say which actually happened.
    run.output += `\ncould not start ${cmd}: ${e.message}\n`;
    run.endedAt = Date.now();
    persist(run);
  });

  return run;
}
