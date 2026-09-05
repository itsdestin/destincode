# Dev dashboard

One browser page that lists every branch copy of YouCoded on this machine,
launches and stops a dev instance from any of them, runs the check suites against
them, and says which ones hold work that exists nowhere else.

```bash
bash dev-dashboard/run.sh
# → http://127.0.0.1:5240/?mode=dev-dashboard
```

Ctrl-C stops Vite, the helper, and every dev instance the page started.

## Three pieces

| Piece | Where | What it is |
|---|---|---|
| The screen | `../src/renderer/dev/dashboard/` | A real renderer screen, so moving it into Settings later is deleting the wrapper rather than a rewrite |
| The wrapper | `?mode=dev-dashboard` branch in `../src/renderer/index.tsx` | The same URL-query fork the workbench uses. **No `vite.config.ts` change** |
| The helper | this folder | The only piece that runs commands. Also proxies Vite, so there is one address to open |

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
