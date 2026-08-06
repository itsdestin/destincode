// A disposable, deterministic mini-repo for the harness review battery.
//
// WHY a fixture rather than the real workspace (2026-08-06): the five reviews in
// docs/active/investigations/2026-08-01-native-agent-harness-reviews.md each ran
// against /home/destin/youcoded-dev while other sessions were changing it, and
// each left `<model>-test-*` artifacts behind. That makes two runs incomparable
// and pollutes the repo. An identical seeded tree per model fixes both.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** Every path the battery is expected to touch, with why it is here. Exported so
 *  the test can assert coverage rather than duplicating the list. */
export const FIXTURE_MANIFEST: Array<{ rel: string; why: string }> = [
  { rel: 'README.md', why: 'markdown read' },
  { rel: 'package.json', why: 'JSON read' },
  { rel: 'src/index.ts', why: 'TypeScript read + Grep target' },
  { rel: 'src/big-module.ts', why: 'large-file paging (offset/limit)' },
  { rel: 'app/Main.kt', why: 'Kotlin read' },
  { rel: 'config/settings.toml', why: 'TOML read' },
  { rel: 'assets/logo.png', why: 'binary-read refusal' },
  { rel: 'notes/duplicates.md', why: 'ambiguous-Edit guard (duplicate string)' },
  { rel: 'a dir with spaces/a file with spaces.txt', why: 'paths with spaces' },
];

const README = `# Fixture Project

A small deterministic project used to exercise the YouCoded native agent harness.

## Layout

- \`src/\` — TypeScript sources
- \`app/\` — Kotlin sources
- \`config/\` — configuration
`;

const BIG_MODULE = Array.from(
  { length: 2_400 },
  (_, i) => `export const value${i} = ${i}; // generated line ${i}`,
).join('\n');

/** Create a fresh fixture tree and return its absolute root.
 *  Deterministic: identical bytes on every call, so runs are comparable. */
export function seedFixtureWorkspace(): string {
  // realpathSync because macOS reports /var/... for a /private/var/... tmpdir, and
  // the harness's own path guard canonicalizes — a mismatch would read as "outside
  // the workspace" and revert every cd.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'yc-harness-review-'));
  const write = (rel: string, content: string | Buffer) => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  };

  write('README.md', README);
  write('package.json', JSON.stringify({ name: 'fixture-project', version: '1.0.0', scripts: { test: 'echo ok' } }, null, 2) + '\n');
  write('src/index.ts', `export function greet(name: string): string {\n  return \`Hello, \${name}!\`;\n}\n\nexport const MARKER = 'findme';\n`);
  write('src/big-module.ts', BIG_MODULE + '\n');
  write('app/Main.kt', `package com.example\n\nclass MainActivity {\n    fun onCreate() {\n        println("started")\n    }\n}\n`);
  write('config/settings.toml', `[server]\nport = 8080\nhost = "localhost"\n\n[features]\nsearch = true\n`);
  // A real NUL byte is what Read's binary sniff looks for in the first 8KB.
  write('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));
  write('notes/duplicates.md', `# Notes\n\nduplicate phrase hello\nsomething else\nduplicate phrase hello\n`);
  write('a dir with spaces/a file with spaces.txt', 'content in a path with spaces\n');
  return root;
}
