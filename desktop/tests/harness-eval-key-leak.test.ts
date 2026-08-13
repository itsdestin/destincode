import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

/**
 * THE CREDENTIAL LEAK DETECTOR.
 *
 * This branch spent four review rounds on one bug class: the API key kept being
 * readable by the model under test — first through the worker's argv, then
 * through the worker's environment, then through captured stderr. Each fix was
 * certified by a check aimed at exactly the boundary it had just left, so each
 * one passed while the key was still readable one process further up.
 *
 * The threat model is therefore stated once, here, and the detector is built to
 * match it: **any channel a same-uid DESCENDANT can read.** The model under test
 * drives a Bash tool that spawns children with the environment it was handed, so
 * those children are descendants of the ORCHESTRATOR, not merely of the worker.
 * Everything they print is captured into `run.events` and written to a
 * transcript file. So the boundary that matters is the OUTERMOST key-holding
 * process.
 *
 * The rig below is three real processes, matching the real topology:
 *
 *   L1 orchestrator  — holds the key. Acquires it through the REAL `loadApiKey`
 *                      from test-engine/harness-eval.mjs.
 *   L2 worker        — spawned with the REAL `workerEnv()` allowlist, config
 *                      (key included) delivered over stdin.
 *   L3 bash grandchild — spawned with `{ ...process.env }`, which is literally
 *                      what src/main/harness/tools/bash.ts does. This is the
 *                      process the model controls, and it does the probing.
 *
 * L3 probes BOTH L1 and L2 on every channel, and the NEGATIVE CONTROL
 * reproduces the old env-inherited style and must report LEAKED. A detector that
 * cannot see the old bug certifies nothing, so the control is not optional
 * decoration — it is what makes a CLEAN result mean anything.
 *
 * WHY Linux-only: `/proc/<pid>/environ` and `ps eww` are the channels. On
 * Windows and macOS the equivalent exposure is different (macOS `ps -E` requires
 * root for other processes), so this suite asserts nothing there rather than
 * pretending to.
 */

const DESKTOP = path.resolve(__dirname, '..');
const CLI = path.join(DESKTOP, 'test-engine/harness-eval.mjs');
const q = (v: string) => JSON.stringify(v);

/** L3 — the Bash-tool-style grandchild. Reads every channel of two named pids
 *  and reports, per channel, whether it could read it at all and whether the
 *  canary was in it. `readable` matters: an unreadable channel that reported
 *  CLEAN would be a false negative, which is this whole file's failure mode. */
const PROBE_L3 = `
import * as fs from 'fs';
import { execFileSync } from 'child_process';
// The needle arrives from a TEST-OWNED file, never from the environment or from
// argv. WHY that matters: the first draft had L2 read the canary out of its own
// inherited environment and pass it down, so in the negative control — where the
// old code's \`delete\` genuinely does clean the child's copy — L2 searched for
// the string "undefined" and every channel reported CLEAN. The detector looked
// perfect and measured nothing. Sourcing the needle out-of-band is what makes
// the control able to fail.
const [, , needleFile, orchPid, workerPid, keyFilePath] = process.argv;
const canary = fs.readFileSync(needleFile, 'utf8').trim();

function readFile(file) {
  try { return { readable: true, text: fs.readFileSync(file, 'utf8') }; }
  catch (err) { return { readable: false, text: '<' + (err.code || err.message) + '>' }; }
}
function psEnv(pid) {
  try { return { readable: true, text: execFileSync('ps', ['eww', '-p', String(pid)], { encoding: 'utf8' }) }; }
  catch (err) { return { readable: false, text: '<ps failed: ' + err.message + '>' }; }
}

const channels = {};
const record = (name, probe) => { channels[name] = { readable: probe.readable, leaked: probe.text.includes(canary) }; };

record('L1 orchestrator /proc/<pid>/environ', readFile('/proc/' + orchPid + '/environ'));
record('L1 orchestrator /proc/<pid>/cmdline', readFile('/proc/' + orchPid + '/cmdline'));
record('L1 orchestrator ps eww', psEnv(orchPid));
record('L2 worker /proc/<pid>/environ', readFile('/proc/' + workerPid + '/environ'));
record('L2 worker /proc/<pid>/cmdline', readFile('/proc/' + workerPid + '/cmdline'));
record('L2 worker ps eww', psEnv(workerPid));
// The channel every earlier round checked, and the reason they all passed: the
// grandchild's OWN environment really is clean, and always was.
channels['L3 own inherited environment'] = {
  readable: true,
  leaked: Object.values(process.env).some((v) => typeof v === 'string' && v.includes(canary)),
};
// The two halves of the residual a --key-file mechanism creates. Probed rather
// than assumed away, because an unprobed channel is exactly how the previous
// three rounds got certified.
if (keyFilePath) {
  // (a) does L1's cmdline still SIGNPOST the key file? scrubProcessTitle() is
  //     supposed to have overwritten it.
  const cmdline = readFile('/proc/' + orchPid + '/cmdline');
  channels['L1 cmdline signposts the key file path'] = {
    readable: cmdline.readable,
    leaked: cmdline.text.includes(keyFilePath),
  };
  // (b) and if a descendant learns the path anyway, can it read the file? Yes —
  //     same uid. Inherent to a file-based credential, pinned so nobody
  //     re-certifies this mechanism as "no channel at all".
  record('key file contents, when the path is already known', readFile(keyFilePath));
}

console.log('PROBE ' + JSON.stringify(channels));
`;

/** L2 — the worker stand-in. Secure variant reads the config from stdin; the
 *  negative control reads the key from its inherited environment, the way the
 *  pre-fix worker did. Either way it spawns L3 the way bash.ts does. */
const worker = (probeFile: string, variant: 'stdin' | 'env') => `
import { spawnSync } from 'child_process';
${variant === 'stdin'
    ? `let raw = ''; process.stdin.setEncoding('utf8');
       for await (const chunk of process.stdin) raw += chunk;
       // apiKey is destructured but unused on purpose: holding it in this
       // process's heap is what makes L2 a genuine key-holder, which is what the
       // '/proc/<L2>/...' channels are being probed about.
       const { apiKey, orchPid, keyFilePath, needleFile } = JSON.parse(raw);`
    : `const apiKey = process.env.OPENROUTER_API_KEY;
       const orchPid = process.argv[2];
       const needleFile = process.argv[3];
       const keyFilePath = '';`}
// Exactly what src/main/harness/tools/bash.ts does: '{ ...process.env, ... }'.
spawnSync(process.execPath, [${q(probeFile)}, needleFile, String(orchPid), String(process.pid), keyFilePath || ''], {
  env: { ...process.env },
  stdio: 'inherit',
});
`;

/** L1 — the orchestrator stand-in. The SECURE variant uses the real production
 *  code path: `loadApiKey` (which refuses an inherited env var outright) and
 *  `workerEnv` (the allowlist), with the key delivered over the worker's stdin.
 *  The CONTROL variant reproduces the shape this branch shipped three times —
 *  and the shape `review-harness.mjs:113` still has today — verbatim. */
const orchestrator = (workerFile: string, variant: 'secure' | 'control') => `
import { spawnSync } from 'child_process';
${variant === 'secure'
    ? `import { loadApiKey, workerEnv, scrubProcessTitle } from ${q(CLI)};
       const keyFilePath = process.argv[2];
       const needleFile = process.argv[3];
       const apiKey = loadApiKey({ keyFile: keyFilePath });
       // Same order main() uses: key in hand, then scrub argv.
       scrubProcessTitle('harness-eval (leak-detector)');
       const r = spawnSync(process.execPath, [${q(workerFile)}], {
         env: workerEnv(),
         input: JSON.stringify({ apiKey, orchPid: process.pid, keyFilePath, needleFile }),
         stdio: ['pipe', 'inherit', 'inherit'],
       });`
    : `// The old shape, verbatim: capture from the environment, then delete —
       // which is unsetenv, and does not rewrite /proc/<pid>/environ.
       const apiKey = process.env.OPENROUTER_API_KEY;
       delete process.env.OPENROUTER_API_KEY;
       const r = spawnSync(process.execPath, [${q(workerFile)}, String(process.pid), process.argv[2]], {
         env: { ...process.env },
         stdio: 'inherit',
       });`}
if (r.error) { console.error('L1 could not spawn L2: ' + r.error.message); process.exit(1); }
`;

type Channels = Record<string, { readable: boolean; leaked: boolean }>;

function buildRig(variant: 'secure' | 'control'): { run: () => Channels; keyFile: string; canary: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `harness-eval-leak-${variant}-`));
  const probeFile = path.join(dir, 'l3-probe.mjs');
  const workerFile = path.join(dir, 'l2-worker.mjs');
  const orchFile = path.join(dir, 'l1-orchestrator.mjs');
  const keyFile = path.join(dir, 'openrouter-key');
  /** The needle L3 searches for, handed to it out-of-band. Separate from
   *  `keyFile` so that the "can L3 read the key file itself" probe stays an
   *  honest question rather than a tautology. */
  const needleFile = path.join(dir, 'needle');
  // A distinctive canary so a substring match cannot hit by accident.
  const canary = `sk-or-v1-LEAKCANARY-${variant}-${Math.random().toString(36).slice(2, 12)}`;

  fs.writeFileSync(probeFile, PROBE_L3);
  fs.writeFileSync(workerFile, worker(probeFile, variant === 'secure' ? 'stdin' : 'env'));
  fs.writeFileSync(orchFile, orchestrator(workerFile, variant));
  fs.writeFileSync(keyFile, `${canary}\n`, { mode: 0o600 });
  fs.writeFileSync(needleFile, canary);

  const env = { ...process.env };
  delete env.OPENROUTER_API_KEY;
  if (variant === 'control') env.OPENROUTER_API_KEY = canary;

  return {
    keyFile,
    canary,
    run: () => {
      const stdout = execFileSync(
        process.execPath,
        variant === 'secure' ? [orchFile, keyFile, needleFile] : [orchFile, needleFile],
        { encoding: 'utf8', env, stdio: 'pipe' },
      );
      const line = stdout.split('\n').find((l) => l.startsWith('PROBE '));
      if (!line) throw new Error(`the L3 probe produced no PROBE line. Full output:\n${stdout}`);
      return JSON.parse(line.slice('PROBE '.length)) as Channels;
    },
  };
}

/** Human-readable table, printed so a run of this file IS the detector report. */
function render(title: string, channels: Channels): string {
  const width = Math.max(...Object.keys(channels).map((k) => k.length));
  const rows = Object.entries(channels).map(([name, r]) =>
    `  ${name.padEnd(width)}  ${r.leaked ? 'LEAKED' : 'CLEAN '}${r.readable ? '' : '  (channel NOT READABLE — result proves nothing)'}`);
  return [`\n=== ${title} ===`, ...rows].join('\n');
}

const linux = process.platform === 'linux';

describe.skipIf(!linux)('credential leak detector (three real processes)', () => {
  it('NEGATIVE CONTROL: the env-inherited style leaks the key from the ORCHESTRATOR', () => {
    const { run } = buildRig('control');
    const channels = run();
    console.log(render('NEGATIVE CONTROL — key inherited in L1\'s environment (the old shape)', channels));

    // This is the assertion that makes every CLEAN in the next test meaningful.
    // If the detector cannot see the bug it was built for, it certifies nothing.
    expect(channels['L1 orchestrator /proc/<pid>/environ'].readable).toBe(true);
    expect(channels['L1 orchestrator /proc/<pid>/environ'].leaked).toBe(true);
    expect(channels['L1 orchestrator ps eww'].leaked).toBe(true);

    // ...and the channels that fooled three earlier review rounds read CLEAN
    // even here. `delete process.env.X` really does clean the child's inherited
    // copy — that was never the question.
    expect(channels['L3 own inherited environment'].leaked).toBe(false);
    expect(channels['L1 orchestrator /proc/<pid>/cmdline'].leaked).toBe(false);
  }, 60_000);

  it('the real mechanism leaks on NO channel of either key-holding process', () => {
    const { run } = buildRig('secure');
    const channels = run();
    console.log(render('REAL MECHANISM — loadApiKey(--key-file) + workerEnv() + stdin config', channels));

    // The residual pair is asserted on its own terms below; everything else must
    // be readable AND clean.
    const residualNames = ['L1 cmdline signposts the key file path', 'key file contents, when the path is already known'];
    for (const [name, result] of Object.entries(channels)) {
      if (residualNames.includes(name)) continue;
      // A channel nobody could read is not evidence of safety, so require both.
      expect(result.readable, `${name} was not readable, so CLEAN proves nothing`).toBe(true);
      expect(result.leaked, `${name} LEAKED the credential`).toBe(false);
    }
  }, 60_000);

  it('scrubs the key file PATH out of the orchestrator cmdline, and pins what is left', () => {
    // Half of the --key-file residual is closed and half is inherent, and the
    // difference matters enough to be two assertions rather than a paragraph.
    //
    // CLOSED: the path was in L1's argv, so a descendant could read
    // /proc/<ppid>/cmdline and learn exactly where to `cat`. scrubProcessTitle()
    // overwrites that region (libuv writes the new title into the original argv
    // memory on Linux).
    //
    // INHERENT: the file is same-uid readable, and the model's Bash tool runs as
    // the same uid. A descendant that learns the path another way still gets the
    // key. Closing THAT means never having the key on disk at all — an
    // interactive prompt, or piping it into the orchestrator's own stdin — and
    // both cost the unattended run this tool is for. Pinned here so nobody
    // re-certifies this mechanism as "no channel at all".
    const { run } = buildRig('secure');
    const channels = run();
    expect(channels['L1 cmdline signposts the key file path'].readable).toBe(true);
    expect(channels['L1 cmdline signposts the key file path'].leaked).toBe(false);
    expect(channels['key file contents, when the path is already known'].leaked).toBe(true);
  }, 60_000);
});

describe.skipIf(linux)('credential leak detector', () => {
  it('is Linux-only and asserts nothing here', () => {
    // Stated rather than silently skipped: `/proc/<pid>/environ` and `ps eww` are
    // the measured channels, and neither exists in this form on this platform.
    expect(process.platform).not.toBe('linux');
  });
});
