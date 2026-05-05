# OpenCode Coupling Registry

YouCoded depends on OpenCode's HTTP+SSE server, SDK, event shape, config-file format, and CLI behavior. This document tracks each touchpoint so the next OpenCode version bump has a clear coupling-impact list.

Format mirrors `cc-dependencies.md`.

## Pinned version

`@opencode-ai/sdk@1.14.35` + matching `opencode` binary on PATH. Bump together with a full coupling re-check (re-run the inspection that produced the "Verified API Surface" section in the OpenCode-MVP plan).

## Touchpoints

- **`opencode serve` CLI flags** — `--port` (default 4096; we override with a free port), `--hostname` (default 127.0.0.1). (`opencode-service.ts`)
- **Readiness probe endpoint** — `GET /global/health` returns `{ healthy: true, version: string }`. `OpenCodeService.start()` polls this until 200. (`opencode-service.ts`)
- **REST endpoints** — `POST /session` (create), `GET /session` (list), `DELETE /session/:id` (delete), `POST /session/:id/message` (sync prompt), `POST /session/:id/prompt_async` (async prompt — what we use), `GET /session/:id/message` (history), `POST /session/:id/abort` (cancel). (`opencode-service.ts`, `opencode-session-adapter.ts`)
- **`@opencode-ai/sdk` exports** — top-level `createOpencodeClient(config)` factory and `OpencodeClient` class. (`opencode-service.ts`)
- **`@opencode-ai/sdk` method paths** — `client.session.create()`, `.list()`, `.delete(id)`, `.abort(id)`, `.promptAsync(id, body)`, `.messages(id)`, plus `client.event.subscribe()` returning an SSE stream. (`opencode-service.ts`, `opencode-session-adapter.ts`)
- **SSE event `type` literals (dotted strings)** — used by the adapter: `message.part.updated` (carries `{ part: Part, delta?: string }` — incremental text chunks live in `delta`), `message.updated` (final message info), `session.idle` (turn-complete signal), `session.error`, `permission.updated` (we allow-all in MVP, so we ignore this). (`opencode-session-adapter.ts`)
- **`Part` discriminated union** — `text`, `reasoning`, `file`, `tool`, `step-start`, `step-finish`, `snapshot`, `patch`, `agent`, `retry`, `compaction`, `subtask`. (`opencode-session-adapter.ts`)
- **`ToolPart.state` discriminator** — field is `status` (NOT `type`); values `pending` | `running` | `completed` | `error`. Each variant has different fields: `completed` carries `output: string`, `error` carries `error: string`, both carry `input: {}` and `time: { start, end }`. (`opencode-session-adapter.ts`)
- **`prompt`/`promptAsync` body shape** — `{ parts: Array<TextPartInput | ...>, model?: { providerID, modelID }, agent?, system?, tools?, messageID?, noReply? }`. User text goes via `parts: [{ type: 'text', text }]`. (`opencode-service.ts`, `session-manager.ts`)
- **Config file format** — `~/.config/opencode/opencode.json` (Linux/macOS) / `%APPDATA%\opencode\opencode.json` (Windows). Provider declaration: `{ provider: { ollama: { npm: '@ai-sdk/openai-compatible', name, options: { baseURL: 'http://host:port/v1' }, models: {...} } } }`. Permission allow-all: top-level `"permission": "allow"` (string shorthand) — NOT `permission.default`. (`opencode-config-writer.ts`)
- **`auth.json`** — at `~/.local/share/opencode/auth.json` (Linux), `~/Library/Application Support/opencode/auth.json` (macOS), `%LOCALAPPDATA%\opencode\auth.json` (Windows). For local Ollama (no auth), this file is NOT required. We do not write it. (`opencode-config-writer.ts`)
- **Session storage path (SQLite)** — Linux `~/.local/share/opencode/opencode.db`, macOS `~/Library/Application Support/opencode/opencode.db`, Windows `%LOCALAPPDATA%\opencode\opencode.db`. Currently NOT read directly — we use REST. (No active reader.)
- **Binary distribution** — install bootstrap URL `https://opencode.ai/install` (POSIX bash). Windows installs from a GitHub Releases asset (`opencode-windows-x64.zip` etc. under `sst/opencode`). The SDK strictly requires `opencode` on PATH or a known absolute path — there is no in-process embedded server. (`prerequisite-installer.ts → installOpenCode`)
- **`OPENCODE_CONFIG_CONTENT` env var** — accepts a JSON-stringified config and bypasses file-based config loading. We do NOT use it for MVP (file-based config is more inspectable and editable), but it's a known alternative if file-write friction arises. (No active reader.)

## Native installer bootstrap script (Local — OpenCode)

**Touchpoint:** `src/main/prerequisite-installer.ts → installOpenCode`
**Coupling:** Depends on the canonical OpenCode repo (`sst/opencode`) publishing release assets at predictable URLs:
- POSIX: `https://opencode.ai/install` — bash bootstrap script that resolves to a platform-specific binary download.
- Windows: `https://github.com/sst/opencode/releases/latest/download/opencode-windows-{x64,arm64}.zip` — ZIP archive containing `opencode.exe`. Extracted with Windows' built-in `tar.exe` (Win10 1803+).

If OpenCode renames assets, splits the bash script into multiple per-platform installers, or moves the GitHub Releases URL pattern, `installOpenCode` breaks.

**Mitigation:** First-run failure surfaces a clear error pointing the user to `~/.local/bin/opencode`; manual install from opencode.ai recovers.
