#!/usr/bin/env node
// build-transcript-watcher-cli.js — bundles the transcript-watcher CLI into a
// single-file CommonJS script suitable for running under Termux Node on Android.
//
// Output: dist/cli/transcript-watcher-cli.js
//
// The Android build (scripts/build-web-ui.sh) copies the output into
// app/src/main/assets/ where Bootstrap.deployTranscriptWatcherCli() picks it
// up and writes it to ~/.claude-mobile/ at session start.
//
// Single source of truth: same TS code parses transcripts on Electron (in-
// process) and on Android (subprocess). See docs/PITFALLS.md → "Transcript
// Watcher" entry.

const path = require('node:path');
const fs = require('node:fs');

async function main() {
  // esbuild is loaded dynamically so the script can fail with a clear error
  // when the dep isn't installed yet (fresh clone / forgot to npm ci).
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch {
    console.error('build-transcript-watcher-cli: esbuild is not installed. Run `npm ci` in desktop/ first.');
    process.exit(1);
  }

  const root = path.resolve(__dirname, '..');
  const outDir = path.join(root, 'dist', 'cli');
  fs.mkdirSync(outDir, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(root, 'src/cli/transcript-watcher-cli.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18', // Termux ships current Node; node18 is safely below floor
    format: 'cjs',
    outfile: path.join(outDir, 'transcript-watcher-cli.js'),
    // Node builtins are always external. Keep external empty otherwise — the
    // bundle should be self-contained so Termux doesn't need any node_modules.
    external: [],
    // Source file already starts with `#!/usr/bin/env node`; esbuild preserves
    // it. Don't add a banner — duplicating the shebang puts the second one on
    // line 2 where Node parses it as syntax and crashes.
    logLevel: 'info',
    minify: false, // unminified for easier Android logcat debugging
    sourcemap: false,
  });

  // Ensure the output is executable so a `chmod +x` isn't required on Android.
  fs.chmodSync(path.join(outDir, 'transcript-watcher-cli.js'), 0o755);

  console.log('Built dist/cli/transcript-watcher-cli.js');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
