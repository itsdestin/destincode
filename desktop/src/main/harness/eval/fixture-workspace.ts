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
  // Reserved for battery area 4's "edit a file you haven't Read" step, and for
  // nothing else — see the WHY in seedFixtureWorkspace().
  { rel: 'notes/pristine.md', why: "read-gate negative test — the one file no other battery area reads" },
  { rel: 'a dir with spaces/a file with spaces.txt', why: 'paths with spaces' },
  // Deliberately contradicts config/settings.toml on `port` — see the WHY comment
  // in seedFixtureWorkspace(). This is the seeded ambiguity that battery area 7
  // (Configuration) leads a model into, so AskUserQuestion has a genuine reason
  // to fire instead of a model guessing which file governs the real port.
  { rel: 'config/app.toml', why: 'contradicts config/settings.toml on the server port — the seeded AskUserQuestion ambiguity' },
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
  // WHY this second file exists and deliberately disagrees with settings.toml on
  // `port` (8080 vs 9090): across two full review rounds AskUserQuestion has
  // never once been called — every model correctly found nothing in the fixture
  // ambiguous enough to ask about (see the finding recorded in
  // docs/active/investigations/2026-08-01-native-agent-harness-reviews.md).
  // This is the seeded fix: both files use the identical `[server]` table shape,
  // both live in the one directory the README calls "configuration", and neither
  // name implies precedence (no .local/.override/.dev convention) — so there is
  // no discoverable fact about which one the real server reads. Battery area 7
  // asks a model to bump "the" port, which is genuinely unanswerable from the
  // tree alone; the correct move is to ask, not to pick one file and guess.
  // DO NOT "fix" this by reconciling the two files to the same value or deleting
  // one — the contradiction is the point, and a pinning test in
  // tests/harness-review-fixture.test.ts asserts the values still differ.
  // `host` is kept identical to settings.toml (not e.g. 0.0.0.0) and this file
  // gets its own unrelated extra section ([client], mirroring settings.toml's
  // [features]) on purpose: without those, "richer file" or "bind-all host reads
  // as prod" would each be a weak but real tiebreaker a model could reach for
  // instead of asking. Symmetric shape removes both escape hatches.
  write('config/app.toml', `[server]\nport = 9090\nhost = "localhost"\n\n[client]\ntimeout = 30\n`);
  // A real NUL byte is what Read's binary sniff looks for in the first 8KB.
  write('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]));
  write('notes/duplicates.md', `# Notes\n\nduplicate phrase hello\nsomething else\nduplicate phrase hello\n`);
  // WHY a file reserved for one battery step (2026-08-11 review round 8): area 4
  // asks the model to "try to edit a file you haven't Read", but area 2 has
  // already had it Read README.md — and a Read (even a partial one) satisfies the
  // gate for the rest of the session. Whichever file a model reached for in area
  // 4 was usually one it had already touched, so the Edit SUCCEEDED and the
  // negative test silently became a positive one. GPT 5.6 Luna filed that as
  // "read-gate enforcement is inconsistent — biggest issue, priority fix"; the
  // gate was right and the fixture was wrong.
  //
  // This file is named in BATTERY_PROMPT area 4 and nowhere else, so the step no
  // longer depends on which file the model happens to pick or what it read
  // earlier. Keep it out of every other area: the moment something else reads it,
  // the negative test is gone again.
  write('notes/pristine.md', '# Pristine\n\nReserved for the read-before-edit test. Nothing else in the battery reads this file.\n');
  write('a dir with spaces/a file with spaces.txt', 'content in a path with spaces\n');
  return root;
}
