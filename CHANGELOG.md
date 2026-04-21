# Changelog

All notable changes to YouCoded are documented in this file.

## [1.1.1] — 2026-04-20

**Claude Code CLI baseline:** v2.1.116

Patch release. Fixes the Windows CI test failure that blocked v1.1.0's desktop installer upload (Mac + Linux built fine, Windows test failed so the whole upload step was skipped and v1.1.0 shipped Android-only). Also ships the About popup and Android tier-picker styling polish.

### Added
- **About popup** — Replaces the inline collapsible About blocks in Desktop and Android settings with a shared `AboutPopup` rendered via `<Scrim>` + `<OverlayPanel>` at layer 2 with Escape-to-close and platform-specific privacy/licenses content. Matches the rest of the settings-menu popups (centered, glassmorphism from theme tokens, scrim-to-dismiss).
- **Android tier picker styling** — First-run `TierPickerScreen` Compose content wrapped in a dim-scrim + centered themed Surface so the package selector matches the popup aesthetic. Tier list scrolls inside the card; Continue stays pinned to the bottom.

### Fixed
- **Windows desktop installer CI** — `tests/ipc-handlers.test.ts` electron mock now includes `setAppUserModelId` (no-op). The AUMID hot-swap added in v1.1.0 calls this at `main.ts:159` on Windows during module load; desktop-ci runs Linux-only so the gap was invisible until v1.1.0's release matrix hit the Windows leg and skipped the installer upload. The test mock covers the call so Windows CI can complete the build → upload cycle.

### Notes
- v1.1.0's GitHub release has Android artifacts (APK + AAB) only. Users who want desktop installers should grab v1.1.1. The v1.1.0 → v1.1.1 upgrade is otherwise purely additive (UI polish + CI infra).

## [1.1.0] — 2026-04-20

**Claude Code CLI baseline:** v2.1.116

Headline: Buddy floater mascot companion, nested subagent timelines, typed sync warnings with fix-actions, per-turn transcript metadata, and three cross-cutting Windows PTY fixes.

### Added
- **Buddy floater** — A companion mascot window that floats above your desktop, reflects session attention state (idle vs. shocked), and opens an inline chat bubble on click. Session pill in the bubble lets you switch sessions or spawn a new one from the welcome screen. Multi-window session subscriptions + attention aggregation under the hood. Windows-only capture exclusion (via koffi + `SetWindowDisplayAffinity`, Win10 19041+) keeps the mascot out of screenshares. Toggleable in Settings.
- **Subagent threading** — When Claude invokes the `Agent` tool, its nested work (text, tool calls, results) now renders as a chat-style grouped timeline inside the parent tool card. Correlation by `parentAgentToolUseId` on both the desktop TranscriptWatcher and Android parity, with a directory-level SubagentWatcher tailing sub-session transcripts.
- **Typed sync warnings** — Replaces the old string-code sync warnings with a typed `SyncWarning[]` store (`~/.claude/.sync-warnings.json`). SyncPanel renders fix-action buttons per-warning; StatusBar chips stay in sync; a red dot appears on the Settings gear when danger-severity warnings exist. Health-check and per-backend push failures own non-overlapping codes.
- **Per-turn transcript metadata** — Every completing turn now carries `stopReason`, `model`, `usage` (input/output/cache-read/cache-creation tokens), and `anthropicRequestId`. Drives an opt-in per-turn metadata strip under assistant bubbles, an inline footer explaining non-`end_turn` stop reasons, and a session-pill model reconciliation effect that picks up `/model X` from the terminal, rate-limit downshifts, or resume drift. AttentionBanner now surfaces the Anthropic request ID on `session-died` / `error` so you can reference it when reporting issues.
- **Remote chat hydration** — New remote clients receive a full chat state snapshot via `chat:hydrate` immediately on connect, so they see full timelines without waiting for transcript replay. Replaces the old `transcriptBuffers` side channel.
- **Android IPC parity (4 new handlers)** — `marketplace:read-component`, `model:read-last`, `theme:list`, `theme:read-file`, `theme:write-file`. Android now handles the same read/write paths desktop does for marketplace and theme flows. `github:auth` upgraded from stub to real `/system/bin/linker64`-routed `gh` invocation.
- **Usage-limit prompt parser** — Recognizes Claude Code's usage-limit prompt as a titled Ink menu so the renderer can anchor its popover correctly and forward Arrow/Enter.
- **`docs/cc-dependencies.md`** — Spine doc mapping every YouCoded touchpoint that depends on Claude Code CLI behavior. Feeds the `review-cc-changes` release agent.
- **Dev profile isolation** — `scripts/run-dev.sh` now supports concurrent dev profiles via `YOUCODED_PROFILE` + `YOUCODED_PORT_OFFSET`, with hardened hook-path safety so the dev instance can't clobber the built app's `~/.claude/`.
- **Landing page redesign** — Word-cycling hero headline, theme crossfade, halftone animation, combined features/integrations flow, demo mockups rebuilt, gallery populated with screenshots, mobile-responsive scaling for mockup chrome + content, `#demo` anchor and "Installing now..." popup with platform-gated launch tips. Hosted at `itsdestin.github.io/youcoded`.
- **Root `CLAUDE.md` + `.claude/rules/android-runtime.md`** — Contributors opening Claude Code directly in this repo now get orientation + path-gated Android runtime rules.

### Changed
- **Dedup: `pending` flag, not content match** — User timeline entries carry a `pending` flag; `USER_PROMPT` always appends with `pending: true`, and `TRANSCRIPT_USER_MESSAGE` finds the oldest matching pending entry and clears the flag. Replaces the prior last-10-entries content match, which silently dropped legitimate rapid-fire duplicates (e.g. "yes" sent twice within five turns).
- **Opus label: 4.6 → 4.7** — Model selector display and chat header pill reflect the current model ID.
- **Integration install** — Now plugin-backed with icons and `postInstallCommand` support. `IntegrationReconciler` removed; install/sync flows simplified.
- **Multi-session lag** — Reducer, IPC, and transcript-watcher perf fixes for sessions in double digits. Measurable improvements in session-switch latency and chat-view scroll.
- **Model selector scoped to active session** — Changing model no longer affects other sessions; `SessionInfo` now includes the model.
- **Subagent view styling** — Chat-style grouped timeline with compact rows, card-styled sections, real ToolCard icons, and drop nested left border (parent card frames it).
- **Licensing clarified** — Desktop code = MIT, Android APK = GPLv3 (due to Termux). Root `LICENSE`, `desktop/LICENSE`, `app/LICENSE`, and README License section all state the split and invoke GPLv3 § 5 aggregation for the shared React UI.
- **Windows AUMID alignment** — Packaged taskbar icon now hot-swaps with theme.

### Fixed
- **PTY: long-text paste on Windows ConPTY + Ink** — `pty-worker.js` now splits `content + trailing \r` into two writes with a 600 ms gap to work around Ink's 500 ms `PASTE_TIMEOUT`, and chunks writes >64 bytes into 64-byte pieces with 50 ms gaps to work around ConPTY's silent byte drop on large writes. Paste of 2500+ chars now lands reliably.
- **PTY: resize dedup + debounce** — `TerminalView.fitAndSync` dedupes on unchanged cols/rows and debounces real resize IPCs to coalesce drag jitter. Previously, ConPTY re-emitted the Ink-rendered UI into xterm scrollback on every spurious resize.
- **Android marketplace / theme install** — Skill marketplace discovery, theme list/install/apply, and quick-chip defaults all unbroken after recent changes.
- **Android: pin Claude Code to 2.1.112** — Restores cli.js launch. Bootstrap now gates `isFullySetup` on cli.js existence, not just the install directory.
- **Android: TurnComplete metadata parity** — `TranscriptEvent.TurnComplete` + `TranscriptSerializer.turnComplete` now emit `stopReason` / `model` / `usage` / `anthropicRequestId`, so remote clients connecting to an Android session see the same per-turn metadata, StopReasonFooter, request-ID in AttentionBanner, and sessionModels reconciliation as desktop.
- **Sync: conversation tags survive reinstall/sync** (#52).
- **Chat: rare message loss from dedup + emit-throw races** — `readNewLines` isolates each emit in try/catch so a throwing listener can't strand subsequent chunks in the batch.
- **Chat: `stopReason` footer only on non-`end_turn`** — Normal completions no longer render the explainer.
- **Input bar cursor drift + text selection** on narrow/Android and long text.
- **Theme inline-code color derived from tokens** — No longer hardcoded; adapts to the active theme.
- **Desktop file picker defaults to all file types** — Was defaulting to a filtered subset.
- **Session strip overflow** — `+N` badge for sessions that don't fit.
- **Reconnect copy** — Sync setup wizard reconnect flow steers the user to the same Google account.
- **Status: preserve last-known session chip values across poll misses** — Transient read failures no longer blank context / git-branch / session stats.
- **Header: set `__PLATFORM__` synchronously** so module-level `isAndroid()` works correctly; Android chat/terminal toggle stays on the right side.
- **Icon: desktop app icon rebranded DC → YC.**

### Removed
- **Dead transcript-buffer replay** in the remote server — superseded by `chat:hydrate`.
- **`IntegrationReconciler` + `integration-context.md` generation** — Integration install is plugin-backed now.

### Protocol notes (for custom remote clients / automation)
- `chat:hydrate` is a new WebSocket message sent once per authenticated remote connection, carrying a serialized `ChatState`. Old `transcript-buffer` replay is gone.
- `remote:attention-changed` (renderer → main) and `attentionMap` in `status:data` (main → remote) keep remote browsers in sync with desktop's `AttentionState`.
- `transcript:event` `turn-complete` events now carry `{stopReason, model, usage, anthropicRequestId}` in their `data` field on both desktop and Android. Consumers that previously treated this as an empty object should now read the new fields.
- Subagent-tagged events (`assistant-text`, `tool-use`, `tool-result`) carry optional `parentAgentToolUseId` + `agentId`.

## [1.0.1] — 2026-04-15

### Fixed
- **DC → YC monogram everywhere** — SkillCard badge label and Android launcher adaptive icon + monochrome variant. The "D" glyph in the launcher icons was retraced from Consolas Bold as a "Y" to match the existing "C" glyph's styling.
- **First-party plugin prefix matching** — `skill-scanner.ts`, `sync-service.ts`, and Android `SkillScanner.kt` used `startsWith('youcoded-core')` after the rebrand sed, which missed sibling first-party plugins (`youcoded-encyclopedia`, `youcoded-inbox`, etc.). Now matches `startsWith('youcoded')`.

## [1.0.0] — 2026-04-15

Rebrand release. DestinCode is now YouCoded. All app identifiers, config file names, localStorage keys, IPC names, and user-visible strings updated. This is a fresh v1 line — the old v2.x series was DestinCode.

### Changed
- **App name** — DestinCode → YouCoded. Window title, installers, and menus all reflect the new name.
- **Electron appId** — `com.destinclaude.desktop` → `com.youcoded.desktop`.
- **Android applicationId / package** — `com.destin.code` → `com.youcoded.app`. All Kotlin sources moved to the new package tree.
- **URI scheme** — `destincode://` → `youcoded://` for skill and plugin deep links.
- **Marketplace ID** — The Claude Code registry key is now `youcoded` (was `destincode`). Plugin IDs carry the `@youcoded` suffix in `enabledPlugins`.
- **Config paths** — All `~/.claude/destincode-*.json` files renamed to `~/.claude/youcoded-*.json` (remote, skills, model, appearance, defaults, folders, model-modes).
- **localStorage keys** — `destincode-theme`, `destincode-font`, `destincode-reduced-effects`, `destincode-show-timestamps`, `destincode-statusbar-widgets`, `destincode-remote-token`, `destincode-sound-*`, etc. all renamed to the `youcoded-` prefix.
- **Env vars** — `DESTINCODE_PORT_OFFSET`, `DESTINCODE_PROFILE`, `DESTINCODE_MARKETPLACE_BRANCH` renamed to the `YOUCODED_` prefix.
- **PartyKit** — Multiplayer lobby moved from `destinclaude-games.itsdestin.partykit.dev` to `youcoded-games.itsdestin.partykit.dev`. Old project deleted.
- **GitHub URLs** — All internal references updated: `itsdestin/destincode` → `itsdestin/youcoded`, `itsdestin/destincode-marketplace` → `itsdestin/wecoded-marketplace`, `itsdestin/destinclaude-themes` → `itsdestin/wecoded-themes`, `itsdestin/destinclaude` → `itsdestin/youcoded-core`.
- **Android keystore alias** — `destincode` → `youcoded`. A fresh keystore is required for signed release builds.

## [2.4.0] — 2026-04-15

Headline: marketplace auth, attention classifier, parsed tool cards, glassmorphism overhaul, and the app now owns DestinClaude toolkit reconciliation.

### Added
- **Marketplace authentication** — Sign in with GitHub via the OAuth device flow. Installs, ratings, likes, and reports are now tied to your account. Token storage hardened (cookie-bound CSRF, no raw token at rest).
- **Attention classifier** — Replaces the old 30-second "thinking" timer with a per-second PTY-buffer classifier. New `AttentionBanner` surfaces five distinct states (`awaiting-input`, `shell-idle`, `error`, `stuck`, `session-died`) with banner copy that explains what's happening.
- **Parsed tool-card views** — Edit / Write / Bash / Read / TodoWrite / Agent / Grep / Glob / WebFetch / TaskUpdate now render with a preview-and-expand interface instead of raw JSON blobs.
- **Chrome-style session tear-off** — Drag a session pill out of the SessionStrip to detach it into its own window; drag back to reattach.
- **Per-theme transparency sliders** — Panel Blur, Panel Opacity, Bubble Blur, and Bubble Opacity are now per-theme settings (with a pencil-per-theme editor in Appearance) rather than global. Reduce Effects forces blur off but preserves your opacity intent.
- **Combined model + effort pill** — StatusBar pill collapses model and reasoning effort into a single control with a fast-mode cost warning.
- **Game lobby reconnect** — Real reconnect path with accurate error hints when the room is full or the opponent left.
- **Cross-destination drawer buttons** — Jump between marketplace and library (Library tile dropped in favor of explicit destination buttons).
- **Notification sound picker** — `dialog:open-sound` IPC for choosing custom notification sounds (desktop only).
- **Per-platform header layout** — Chat/terminal toggle moves to the side opposite the OS window controls (left on Windows/Linux, right on macOS). Header packing is space-aware, not viewport-aware.
- **Announcement widget** — Moved from the header into a default-visible StatusBar widget under "Updates."
- **Theme hot-swap window/dock icon** — Active theme controls the OS-level icon.
- **Compounding wheel-scroll acceleration** — Scrolling builds momentum the longer you scroll.
- **Dev port + userData isolation** — `scripts/run-dev.sh` shifts ports (Vite 5173→5223, remote 9900→9950) and splits Electron `userData` so dev coexists with the built app.

### Changed
- **Glassmorphism is fully variable-driven** — All glass surfaces read `--panels-blur` / `--panels-opacity` / `--bubble-blur` / `--bubble-opacity` directly. The old `[data-panels-blur]` attribute gate is gone; blur and opacity are independent knobs.
- **Bottom chrome scroll-behind** — Input + status bars float over chat with frosted glass, padded via ResizeObserver.
- **Plugin install paths** — Marketplace plugins now install under `~/.claude/plugins/marketplaces/destincode/plugins/<id>/` (was `~/.claude/marketplaces/...`); `installed_plugins.json` lives at `~/.claude/plugins/installed_plugins.json` (was `~/.claude/installed_plugins.json`). Both moves match Claude Code v2.1+ expectations — plugins installed against the old paths are invisible to the CLI.
- **Plugin discovery uses four registries** — `ClaudeCodeRegistry` writes `settings.json` (`enabledPlugins`), `installed_plugins.json`, `known_marketplaces.json`, and `marketplaces/<src>/.claude-plugin/marketplace.json` atomically. Without all four, `/reload-plugins` reports zero new plugins.
- **Theme file watcher** — `chokidar` replaces `fs.watch`; recursive directory hot-reload is now reliable on macOS and Windows.
- **Theme publish upload** — Body piped via stdin with a pre-flight size check (no more silent failure on large themes).
- **Network security config** — Tailscale `*.ts.net` cleartext exception now documented inline (traffic still rides inside the WireGuard tunnel).

### Fixed
- **Hook reconciler now prunes dead plugin entries** — On every app launch, `settings.json` hook entries that point inside a plugin root at a missing file are removed. Cleans up stale registrations from the DestinClaude phase-3 decomposition (sync, title-update, todo-capture, checklist-reminder, done-sound, session-end-sync, contribution-detector, check-inbox). Never touches user-added hooks.
- **Orphan symlinks cleaned up** — New `cleanupOrphanSymlinks()` startup sweep removes broken `~/.claude/{hooks,commands,skills}/` symlinks pointing into deleted toolkit subtrees. Claude Code v2.1+ doesn't read these dirs anyway, but they were visible clutter.
- **Wizard symlink block dropped** — The DestinCode app no longer creates `setup-wizard` symlinks in `~/.claude/skills/` or `~/.claude/commands/` during toolkit clone — those paths were broken post-decomposition and Claude Code discovers commands/skills via `plugin.json` regardless.
- **Game presence + remote access status** — Various reliability fixes (per 2.3.2 follow-on commits).
- **Toggle pill** — Cached endpoints survive label visibility flip.
- **Glass UX** — Reduce Effects now lives above the Glass sliders; sliders hide entirely when Reduce Effects is on; sliders only show on themes with wallpapers.
- **Diag panel removed** — From theme settings (was leftover debug surface).
- **Bootstrap.kt** — Removed duplicate `bashPath` declaration that broke Android build under newer Kotlin.

### Removed
- **`gmessages` integration** — Pre-built Go binary and related setup paths.
- **Setup-wizard symlink creation in `prerequisite-installer.ts`** — Dead code from pre-decomposition layout.
- **`desktop/electron-debug.log`** — Was committed by accident; `*.log` now in `.gitignore`.

### Backend
- **Cloudflare Worker (marketplace)** — OAuth device flow hardened. CI deploy order locked: `migrations apply --remote` → `deploy` → `secret put` (avoids `Binding name already in use`).
- **PartyKit** — Server changes deploy automatically via `partykit-deploy` workflow.

## [2.3.2] — 2026-04-08

### Added
- **AskUserQuestion UI** — multiple-choice option selection with keyboard nav (Arrow Up/Down, Enter, Ctrl+Enter to submit)
- **Notification sounds** — selectable Web Audio presets for completion, attention (red status), and ready (blue status) events with per-category toggles
- **Welcome screen form** — expandable New Session with project folder, model picker, and skip-permissions toggle; Resume Session button
- **Glassmorphism sliders** — Panel Blur, Panel Opacity, Bubble Blur, Bubble Opacity controls in appearance settings
- **Appearance persistence** — theme, cycle list, reduced effects, and timestamps now persist to disk across app restarts (localStorage kept as FOUC cache)
- **Sync Management UI** — visual control plane for DestinClaude sync in Settings (backend cards, force sync, warning resolution, config editor, log viewer)
- **Keyboard shortcuts** — Ctrl+` toggles chat/terminal view; shortcuts help panel in settings

### Fixed
- **Enter key stolen by ToolCard** — global Enter handler no longer intercepts when user is typing in InputBar textarea
- **Paste fails after idle blur** — Ctrl+V refocuses textarea; paste resets idle timer
- **PTY paste swallowed** — text and Enter sent as separate PTY writes with 50ms delay so Ink processes them in distinct read cycles
- **Initializing overlay covers chrome** — lowered z-index so glassmorphism header/bottom bars remain accessible
- **Game presence** — server pong returns full user list every 30s for self-correction; challenge-failed feedback when target offline; green dot checks connected state
- **Remote access status** — green only when remote enabled + Tailscale installed + VPN active
- **Android session:destroyed** — broadcast added so React UI removes closed sessions from selector (desktop parity)
- **Glass dropdown blur** — portaled to #root for live content backdrop-filter; removed transform-based centering that broke Chromium compositing
- **Bubble blur slider** — engine override rules injected after theme custom_css to ensure manifest fields take precedence
- **macOS traffic lights** — overlay-header padding on all overlay screens; fullscreen state relay removes padding when traffic lights disappear
- **Session dropdown corners** — child backgrounds clipped to container border-radius

### Changed
- **Glassmorphism CSS** — all glass rules now use --panels-blur and --panel-glass CSS variables (slider-controlled in real-time)
- **Bottom chrome scroll-behind** — input + status bars absolutely positioned with ResizeObserver-driven padding so chat scrolls behind frosted glass
- **Sound settings** — converted from inline section to popout panel with master volume, per-category toggles, and preset selectors

## [2.3.1] — 2026-04-08

### Added
- **Message timestamps** — Show time sent in each chat bubble (e.g. "2:34 PM"). Toggleable via "Message Timestamps" switch in the appearance popup.
- **Donate confirmation modal** — Themed confirmation dialog before opening BMC donation link, matching existing popup patterns. Applied to both Android and desktop settings.
- **Desktop test build CI** — Manual `desktop-test-build.yml` workflow builds .exe/.dmg/.AppImage on all 3 platforms without versioning or release upload.

### Changed
- **Terminal font** — Hardcoded to Cascadia Code with Consolas/monospace fallbacks. User font selection now only affects the chat UI.
- **Terminal wallpaper** — Uses container opacity (0.88) instead of backdrop-filter/transparent xterm. WebGL renderer stays always loaded for performance.
- **Remote setup** — "Set Up Remote Access" button now drives Tailscale install/auth via IPC instead of sending `/remote-setup` to a Claude session. Shows confirmation, progress states, and auto-detects if Tailscale is already installed.
- **Hidden terminals** — Collapse to 0x0 instead of visibility:hidden alone, eliminating scrollbar overlap from multiple sessions.
- **Add Device button** — Always visible when Tailscale installed + password set.

### Fixed
- **Glassmorphism toggle** — Restored "Reduce Visual Effects" toggle removed in a prior refactor.
- **Session browser retries** — readdir/stat calls retry up to 3x with increasing delay to handle Windows antivirus/search indexer transient locks.
- **App icon path** — electron-builder now points to `assets/` instead of nonexistent `build/`. Icon upgraded to 512x512 for macOS .icns requirement.
- **Settings close button** — Inline `-webkit-app-region: no-drag` on panel, backdrop, and close button to bypass Electron's OS-level drag hit-test.
- **Hidden terminal paste** — xterm.js paste handler no longer fires on collapsed terminals, preventing bracketed paste from reaching the PTY when pasting into the chat input.
- **Terminal text bunching** — fitAddon.fit() skips when container is 0x0 and fits twice on visibility change to catch slow browser reflows.
- **Folder switcher** — Centered dropdown with `left-1/2 + translateX(-50%)`. Fixed duplicate style attribute that broke tsc compilation.

## [2.3.0] — 2026-04-07

First unified release. Desktop and Android now share the same version number and release from a single `v*` tag.

### Added
- **Desktop app** — Full Electron app with React UI, now lives in this repo alongside the Android app.
- **Theme system** — Theme packs with custom colors, patterns, particles, glassmorphism, wallpapers, mascots, and icon overrides. Includes theme editor in settings.
- **Theme marketplace** — Browse, install, preview, and publish community themes.
- **Skill marketplace** — Browse, search, install, and share Claude Code plugins. Favorites, quick chips, and curated defaults.
- **Multiplayer games** — Connect 4 via PartyKit (Cloudflare Durable Objects) with lobby, challenges, reconnection, and incognito mode.
- **Remote access** — Built-in HTTP + WebSocket server for browser-based access from any device. Password auth + Tailscale trust.
- **First-run setup wizard (Desktop)** — Zero-terminal onboarding: detects prerequisites, installs Claude Code, handles OAuth sign-in.
- **Session resume** — Browse and resume past Claude Code sessions with history loading.
- **Folder switcher** — Quick-access saved directories for session creation.
- **Model selector** — Cycle between Claude models with persistence and transcript verification.
- **Desktop CI** — New `desktop-ci.yml` runs vitest + tsc on every push. `android-ci.yml` now runs `./gradlew test`.
- **Unified release tags** — Single `v*` tag triggers both `android-release.yml` and `desktop-release.yml`.

### Changed
- **CI consolidation** — Renamed workflows to `{platform}-{purpose}.yml` convention. Standardized all actions to `@v4`.
- **Release APKs** — `android-release.yml` now runs `build-web-ui.sh` so release APKs include the full React UI instead of placeholders.
- **License** — Split licensing: MIT for desktop (`desktop/LICENSE`), GPLv3 for Android (root `LICENSE`).

### Fixed
- **Auto-approve safety** — AskUserQuestion prompts are no longer auto-approved in dangerous mode; they now require actual user input.
- **Protocol parity** — Theme API calls no longer crash on Android/remote (optional chaining guards). Session status uses consistent `"destroyed"` value across platforms. Added `model.readLastModel` stub and `session.switch` handler for cross-platform consistency.
- **Security hardening** — Remote access server defaults to disabled. Cleartext traffic scoped to localhost only. Deep link skill imports now require user confirmation. Plaintext password no longer persisted to disk.
- **Android runtime** — Restored `claude-wrapper.js` asset file as canonical source. Replaced `isRunning` polling with reactive `sessionFinished` StateFlow for instant session death detection.
- **Remote access** — Added folder switcher handlers to remote server.
- **13 broken desktop tests** — session-manager (missing electron mock), transcript-reducer (updated for turn-based model), transcript-watcher (async read timing), theme-preview-sync (cross-repo path).
- **TypeScript error** — Aligned `onResumeSession` callback signature across App, HeaderBar, SessionStrip.
- **Android protocol** — Added `game:getIncognito`/`game:setIncognito` IPC handlers.
- **Execute bits** — Set +x on all 6 shell scripts.
- **build-web-ui.sh** — Added build output existence check with clear error message.

## [1.0.0] — 2026-03-20

First stable release. DestinCode runs Claude Code natively on Android with a touch-optimized chat and terminal interface.

### Core
- Native Android app (Kotlin + Jetpack Compose) running Claude Code via embedded Termux runtime
- 3-layer SELinux bypass routing all binary execution through `/system/bin/linker64`
- Claude Code JS wrapper (`claude-wrapper.js`) patches Node.js `child_process` and `fs` for on-device compatibility
- Foreground service keeps sessions alive in background
- Bootstrap system downloads and extracts Termux `.deb` packages with SHA256 verification

### Chat Interface
- Chat view with structured message rendering (user bubbles, Claude responses, tool cards)
- Tool cards: Running, Awaiting Approval, Complete, Failed states with expandable details
- Markdown rendering with syntax highlighting
- Interactive prompt buttons for Claude Code setup menus (theme, login, trust folder)
- Generic Ink Select menu parser — auto-detects numbered menus from terminal output
- Hardcoded fallback for multi-line menus (login method selection)
- Activity indicator ("Working...", "Reading...") during Claude processing
- URL detection with tappable link pills
- Image attachment support via file picker
- Quick action chips (journal, inbox, briefing, draft)
- Auto-scroll on new messages

### Terminal Interface
- Full terminal emulator via Termux `TerminalView` with raw PTY access
- Floating up/down arrow buttons overlaid on terminal view (for Ink menu navigation)
- Terminal keyboard row: Ctrl, Esc, Tab, left/right arrows
- Permission mode pill with canvas-drawn play/pause icons (Normal ▶, Auto-Accept ▶▶, Bypass ▶▶▶, Plan Mode ⏸)
- Optimistic permission mode cycling with screen-poll correction
- Bypass mode excluded from cycle in non-dangerous sessions
- Shared input draft across Chat, Terminal, and Shell modes

### Shell Mode
- Direct bash shell (long-press terminal icon) via `DirectShellBridge`
- Independent from Claude Code session — no parser, no hooks

### Multi-Session
- Up to 5 concurrent Claude Code sessions
- Session switcher dropdown with color-coded status indicators (Active, Idle, Awaiting Approval, Dead)
- Session creation dialog with working directory selection
- Session destroy and relaunch support
- Auto-titling from Claude Code session files

### Theming
- Default Dark and Light themes with neutral terminal-style colors
- Material You (Dynamic Color) support: Material Dark and Material Light pull accent colors from wallpaper
- Theme selector in app menu with 4 options
- Cascadia Mono font throughout

### Events & Hooks
- Unix socket event bridge (`hook-relay.js` → `EventBridge`) for structured hook events
- Hook event types: PreToolUse, PostToolUse, PostToolUseFailure, Stop, Notification
- Permission prompt detection from notification events with 2/3-option support
- Screen text polling for interactive prompt and permission mode detection

### Icon
- Custom adaptive icon with terminal window, chevron prompt, "DC" monogram, and cursor block
- Scaled to adaptive icon safe zone for Samsung launcher compatibility

## [0.2.0] — 2026-03-15

Phase 2: Hook-based architecture rebuild.

### Changed
- Replaced heuristic text parser with structured hook event system
- Rewrote ChatState with 7 message content types
- Added ToolCard with Running/AwaitingApproval/Complete/Failed states
- Added animated activity indicator
- Deployed `hook-relay.js` and `EventBridge` socket server

### Fixed
- SELinux exec permission for subprocess binaries
- Browser-based OAuth on Android
- Shell detection (`CLAUDE_CODE_SHELL` with bash path)
- Git HTTPS auth with `.netrc` credential sync

## [0.1.0] — 2026-03-14

Initial prototype. Chat UI with heuristic text parsing, basic terminal panel, approval detection.
