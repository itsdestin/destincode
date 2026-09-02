// ESLint — the bug-finding gate. NOT a style gate.
//
// WHY THIS EXISTS: for most of this project's life there was no linter at all.
// tsc, vitest (4207 tests), knip and the ast-grep scan were all green while
// three real defects shipped, because none of those tools can see the classes
// below:
//
//   * a runtime `import` of a package that is in NO dependency field, working
//     only by npm hoisting it out of another package's tree (react-markdown's,
//     in that case) — `npm ls` stays green right up until the day it breaks
//   * a React hook called after an early `return`, which throws "Rendered more
//     hooks than during the previous render" the moment the guard is reachable
//   * a floating promise in the main process, which under Node's default
//     --unhandled-rejections=throw kills the app and every open session
//
// Everything here is therefore a rule that catches a BUG. There are no
// formatting rules, no naming rules, and no stylistic preferences — those cost
// review time and catch nothing. If a rule can't fail a build for a real
// defect, it does not belong in this file.
//
// THE GREEN-GATE RULE: every rule below is at zero on the current tree. A gate
// that ships with known violations trains everyone to ignore it. When you want
// to adopt one of the deferred rules at the bottom, drive it to zero in the
// same commit that enables it.
//
// Run: npm run lint    (also runs inside `bash scripts/verify.sh`)

import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    // Build output. ESLint 9's flat config lints every file it is handed unless
    // ignored, and `dist/` is gitignored — so it is absent in a fresh worktree
    // and present in any checkout that has run `npm run build`. Without this the
    // gate passes on a clean tree and fails on a developer's, which is the worst
    // possible failure mode for a gate. dist/ also carries COMPILED copies of the
    // renderer's `eslint-disable` comments, which then reference rules no config
    // block defines (the src/** block doesn't match dist/**), so each one becomes
    // its own error. knip.jsonc ignores dist/** for the same reason.
    ignores: ['dist/**', 'release/**'],
  },
  {
    // Scoped to src/** to match tsconfig.json's `include`. The same rules run
    // over tests/ in the block at the bottom of this file, minus the type-aware
    // ones — see there for why.
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    plugins: { '@typescript-eslint': tseslint.plugin, 'react-hooks': reactHooks },
    // The tree carries ~32 `eslint-disable` comments for rules this config
    // deliberately leaves off (exhaustive-deps, no-console). Reporting them as
    // "unused" would be 32 lines of noise about directives that become correct
    // again the moment a deferred rule is adopted. Turn this back on if the
    // deferred list at the bottom is ever emptied.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: ['./tsconfig.json'], tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      // ---- React correctness -------------------------------------------------
      // Caught SessionDrawer's three hooks sitting below `if (!drawerOpen)
      // return null` — dormant only because every mount site happened to gate
      // on the same value.
      'react-hooks/rules-of-hooks': 'error',

      // ---- Impossible / dead code -------------------------------------------
      'no-self-compare': 'error',
      'no-constant-binary-expression': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-unsafe-negation': 'error',
      'no-unreachable-loop': 'error',
      'no-compare-neg-zero': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-loss-of-precision': 'error',

      // ---- Silent-wrong-answer traps ----------------------------------------
      // array-callback-return: a .map/.filter/.reduce callback that forgets to
      // return yields undefined for every element rather than failing.
      'array-callback-return': 'error',
      'no-sparse-arrays': 'error',
      'no-return-assign': 'error',
      'no-fallthrough': 'error',
      'default-case-last': 'error',
      // A '${...}' inside a plain quoted string is nearly always a missing backtick.
      'no-template-curly-in-string': 'error',
      // null/undefined comparisons stay loose on purpose — `x == null` is the
      // idiomatic both-checks-at-once form and is used widely here.
      'eqeqeq': ['error', 'always', { null: 'ignore' }],

      // ---- Async traps -------------------------------------------------------
      'no-async-promise-executor': 'error',
      '@typescript-eslint/no-for-in-array': 'error',
      '@typescript-eslint/no-array-delete': 'error',
      '@typescript-eslint/no-implied-eval': 'error',
    },
  },
  {
    // Main-process only. A floating promise in the renderer is a dropped UI
    // update; in main it can terminate the process and take every open session
    // with it, so this is where the rule earns a hard gate. The renderer has 79
    // of these and is deliberately left alone for now — see the deferred list.
    files: ['src/main/**/*.ts'],
    plugins: { '@typescript-eslint': tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: ['./tsconfig.json'], tsconfigRootDir: import.meta.dirname },
    },
    rules: { '@typescript-eslint/no-floating-promises': 'error' },
  },
  {
    // ---- The test tree ------------------------------------------------------
    // Until 2026-09-02 nothing linted tests/ at all: this config stopped at
    // src/**, and the stated reason was that tests were not in a TS project.
    // `tsconfig.tests.json` fixed the typecheck half; this block is the lint
    // half, and it is worth having on its own — a test is code, and a test with
    // a bug in it pins the wrong behaviour while reading as proof.
    //
    // WHY NO `parserOptions.project` HERE, deliberately: the type-aware rules
    // (no-for-in-array, no-floating-promises, …) require every linted file to be
    // inside the project, and tsconfig.tests.json currently EXCLUDES 57 files
    // that still have type errors. Pointing this block at it would fail those 57
    // with "not found in project" — a config error dressed up as a lint finding.
    // The syntactic rules below need no project and catch the classes that
    // actually bite in tests (a .filter callback with no return, a `==` on a
    // number, a dead branch in a fixture builder). Add the type-aware set once
    // the exclude list in tsconfig.tests.json is empty.
    //
    // Measured when this block was written: 5 errors across 4 files, every one a
    // false positive on deliberate code, each now carrying a named
    // eslint-disable with its reason. The gate ships at zero — same green-gate
    // rule as the rest of this file.
    files: ['tests/**/*.ts', 'tests/**/*.tsx'],
    plugins: { '@typescript-eslint': tseslint.plugin, 'react-hooks': reactHooks },
    // Same reasoning as the src/** block: the test tree carries disable comments
    // for rules this config leaves off, and reporting them is noise.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
    languageOptions: { parser: tseslint.parser },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'no-self-compare': 'error',
      'no-constant-binary-expression': 'error',
      'no-dupe-else-if': 'error',
      'no-duplicate-case': 'error',
      'no-unsafe-negation': 'error',
      'no-unreachable-loop': 'error',
      'no-compare-neg-zero': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',
      'no-loss-of-precision': 'error',
      'array-callback-return': 'error',
      'no-sparse-arrays': 'error',
      'no-return-assign': 'error',
      'no-fallthrough': 'error',
      'default-case-last': 'error',
      'no-template-curly-in-string': 'error',
      'eqeqeq': ['error', 'always', { null: 'ignore' }],
      'no-async-promise-executor': 'error',
    },
  },
);

// ---------------------------------------------------------------------------
// DEFERRED RULES — measured, not guessed
//
// These all fire today, so enabling one means paying down its count first.
// The numbers are from a full run on 2026-08-06 (all / src/main only) and are
// recorded so the next session can price the work instead of re-measuring:
//
//   no-unnecessary-condition        631 / 224   mostly TS not narrowing across
//                                               callbacks + deliberate defensive
//                                               checks at IPC boundaries. Low
//                                               signal-to-noise; adopt last.
//   require-await                   152 /  93   largely async-for-interface-shape.
//   no-unnecessary-type-assertion   138 /  41
//   return-await                    111 / 106   stylistic, but affects stack traces.
//   no-floating-promises (renderer)  79 /   0   real, but each needs a judgement
//                                               call about the right recovery.
//   react-hooks/exhaustive-deps      43 /   0   HIGHEST VALUE of the deferred set:
//                                               stale-closure bugs. Spot-checked
//                                               hits were correctly hand-maintained,
//                                               so expect a high false-positive
//                                               rate and adopt file-by-file.
//   no-promise-executor-return       26 /  24   all `new Promise(r => setTimeout(r, ms))`
//                                               — returns a Timeout handle. Cosmetic.
//   require-atomic-updates           21 /  13   all inspected were correct
//                                               `finally { flag = false }` guards.
//   no-cond-assign                   14 /   4   all idiomatic `while ((m = re.exec(s)))`.
//   no-base-to-string                13 /  10   `unknown`-typed values interpolated
//                                               into strings; ToolCard.tsx:99/103/120
//                                               are the chat-visible ones.
// ---------------------------------------------------------------------------
