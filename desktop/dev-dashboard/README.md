# Dev dashboard

One browser page that lists every branch copy of YouCoded on this machine,
launches and stops a dev instance from any of them, runs the check suites against
them, and says which ones hold work that exists nowhere else.

```bash
bash dev-dashboard/run.sh
# → http://127.0.0.1:5240/?mode=dev-dashboard
```

Ctrl-C stops Vite, the helper, and every dev instance the page started.

## Is the workspace itself up to date?

The banner at the top of the page answers this, because nothing else on the
machine does. `.claude/rules/`, `CLAUDE.md`, `docs/MAP.md` and `scripts/` are read
— and RUN — from the shared checkout, so a stale one **governs every new session**
with stale rules and stale tooling, and you cannot read your way out of it. It has
sat 175 commits behind for 31 hours without a word.

The banner fetches from GitHub for real (twice on load: once from what git already
knows so it paints instantly, then again with the network so the number is
current), and says three things:

- **what it costs** — "new sessions are loading guidance that is 38 updates out of
  date", not a bare git count
- **what is blocking it** — the specific files that disagree with the incoming
  commits, which is usually one or two and usually leftovers of work already
  pushed from a worktree
- **when it last checked** — a behind-count is only as true as the fetch behind it

An offline check reports "could not check for updates". It never reports a
remembered number as current — that would be a lie with the same shape as the bug
the banner exists to catch.

## What each row can actually do

Click a row's name to open it. That is where "it says Unsaved work — so what?" gets
answered:

- **Which files**, grouped by what they ARE (notes, code, pictures, settings) with
  each one marked new or edited, because "40 uncommitted files" is not something
  anyone can act on. `site-themes` turned out to be mostly regenerated build output
  plus four brand-new theme packs that existed nowhere else.
- **What the branch was for** — its own commit subjects, so a name like
  `leu-t13-manifest` stops being a mystery.
- **How long it has sat**, and whether it has a pull request.
- **Back this up to GitHub** — the one action the page performs rather than
  prompts for. See below.
- **A copyable prompt** carrying the full file list, ready to paste into a new
  conversation.

## The one thing it does, and why only this one

**Back this up to GitHub** records the uncommitted files as a new `wip/` branch and
pushes it. It is the only action here that changes anything, because it is the only
one that cannot lose anything: it is purely additive.

It builds the commit with git plumbing against a **throwaway index**, so the working
tree, the real index, HEAD and the current branch are left byte-for-byte as found.
The files stay on disk, still uncommitted, exactly where a session working in that
folder expects them — and a copy now also exists on GitHub.

The obvious implementation (`checkout -b`, `add`, `commit`, `checkout` back) is
WRONG and was written first: committing and then switching back removes those files
from the working tree, so a session editing that folder would watch its work
disappear. `tests/dev-dashboard-detail.test.ts` pins the working tree before and
after; that test is why it is not shipped that way.

Everything destructive — removing worktrees, deleting branches, discarding files —
stays a copyable prompt. A judgement about whether some work matters is not
something a button should make.

## Where check results go

They are written to `~/.youcoded/dev-dashboard/runs/` as one JSON file per run, and
the **Results** button in the header opens them. They survive restarting this tool,
which they did not before — a check you ran an hour ago is exactly what you want
when something breaks.

Each result carries what ran, its exit code, how long it took, and everything it
printed. A failed one offers **Copy a prompt to fix this**, which carries the tail
of the output (where every one of our tools puts its verdict) plus a plain-language
note on what that check actually does.

The suite menu states each check's weight, and the results panel states in plain
words what each one is for — the labels alone were jargon.

## Three pieces

| Piece | Where | What it is |
|---|---|---|
| The screen | `../src/renderer/dev/dashboard/` | A real renderer screen, so moving it into Settings later is deleting the wrapper rather than a rewrite |
| The wrapper | `?mode=dev-dashboard` branch in `../src/renderer/index.tsx` | The same URL-query fork the workbench uses. **No `vite.config.ts` change** |
| The helper | this folder | The only piece that runs commands. Also proxies Vite, so there is one address to open |

`workspace.mjs` is the sync check; `checkouts.mjs` is the per-branch status;
`instances.mjs` owns the dev instances; `suites.mjs` is the check registry.

## Ports

| | Port |
|---|---|
| Helper (the one you open) | 5240 |
| Vite, behind it | 5241 |

Clear of the app (5173), dev instances (5223+), the workbench (5233), question
decks (5411) and live panes (5513). Override with `DEV_DASHBOARD_PORT`.

## What it deliberately will not do

**It never writes to your live app.** It reads `~/.claude/youcoded-appearance.json`
and `~/.claude/wecoded-themes/` read-only. `appearance.set` is a logged no-op:
that file belongs to the running app, and writing it would reach into it
(`.claude/rules/live-app-safety.md`).

**It has no delete button.** "Request cleanup" copies a prompt and nothing else. A
delete button one click from a red "unsaved work" pill is the most dangerous
control this page could carry.

**It does not spend money on a single click.** The model evaluation is marked,
confirms the dollar figure first, and always passes `--max-spend`. It refuses to
run when `OPENROUTER_API_KEY` is in the helper's environment, because
`harness-eval.mjs` refuses too — the models it hires could read the key.

## Security

The helper runs commands, so the page driving it is an attack surface.

- Binds `127.0.0.1` only.
- Refuses any request whose `Host` is not loopback, or whose `Origin` is not its
  own. A DNS name resolving to 127.0.0.1 would otherwise let any site on the
  internet drive it. Same guard as `scripts/questions/serve.py`.
- Checkouts are addressed by an **id from the helper's own enumerated list**,
  never by a path from a request.
- Every subprocess is spawned with an argument array. No request value is ever
  interpolated into a command string.
- Theme asset paths are resolved and then checked for containment, so neither the
  slug nor the relative path can climb out of the theme directory.

## Theming

Full active theme — colours, radius, wallpaper, blur — with **no change to the
app's theme system**. Inside Electron theme assets travel over a `theme-asset://`
custom protocol a browser cannot resolve; but `theme-asset-resolver.ts` passes any
value already starting with `http://` through untouched, so the helper serves the
files and rewrites the manifest's paths to loopback URLs.

## Packaging

Not packaged. `electron-builder.yml`'s `files:` is an allowlist (`dist/`,
`node_modules/`, `scripts/`, `hook-scripts/`, `assets/`, `package.json`) that
excludes this folder, the same way it already excludes `test-engine/`. It is
registered in `knip.jsonc` as an entry point for the same reason `test-engine/` is.

## Guard tests

```bash
npx vitest run tests/dev-dashboard-checkouts.test.ts tests/dev-dashboard-server.test.ts \
  tests/dev-dashboard-theme.test.ts tests/dev-dashboard-suites.test.ts \
  tests/dev-dashboard-screen.test.ts
```

The one that matters most is in `dev-dashboard-checkouts.test.ts`: a branch with
zero commits and uncommitted files must read **Unsaved work**, never "safe to
delete". `context-inject.sh` gets that case wrong today — it reads `ahead == 0` as
"candidate for cleanup" before consulting the dirty count, which labelled a
worktree holding 40 uncommitted files safe on 2026-09-01.
