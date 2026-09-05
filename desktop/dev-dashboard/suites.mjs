// The check suites, each with its real weight on the label.
//
// WHY state the weight: the fast one is ten seconds and the UI sweep is five
// minutes with several browsers running at once. Side by side with no weight they
// look equivalent, and one of them slows the machine to a crawl.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

// A hard ceiling passed on EVERY paid invocation, so a runaway plan cannot spend
// more than this no matter what the page asked for.
const MAX_SPEND_USD = '2.00';

export const SUITES = [
  {
    key: 'verify',
    label: 'Safety check',
    weight: '~10s',
    paid: false,
    argv: (c, ws) => ({ cmd: 'bash', args: [path.join(ws, 'scripts', 'verify.sh'), c.path], cwd: ws }),
  },
  {
    key: 'workbench-boot',
    label: 'Workbench boot check',
    weight: 'seconds',
    paid: false,
    argv: (c, ws) => ({ cmd: 'node', args: [path.join(ws, 'scripts', 'workbench-boot-check.mjs')], cwd: c.path }),
  },
  {
    key: 'docs-audit',
    label: 'Docs audit',
    weight: 'seconds',
    paid: false,
    argv: (c, ws) => ({ cmd: 'node', args: [path.join(ws, 'scripts', 'audit-anchors.mjs')], cwd: ws }),
  },
  {
    key: 'android',
    label: 'Android tests',
    weight: 'minutes',
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

export const getRun = (id) => runs.get(id);
export const listRuns = () => [...runs.values()];

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
  runs.set(run.runId, run);

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
  });
  child.on('error', (e) => {
    run.status = 'failed';
    run.exitCode = -1;
    // The real error, not a guess: a missing ./gradlew reads very differently from
    // a failing test, and the message has to say which actually happened.
    run.output += `\ncould not start ${cmd}: ${e.message}\n`;
    run.endedAt = Date.now();
  });

  return run;
}
