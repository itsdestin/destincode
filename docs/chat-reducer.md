---
origin: youcoded-dev@1f60c2a:docs/chat-reducer.md
---

> Migrated from youcoded-dev docs/PITFALLS.md (2026-07-15 triage). The path-scoped rule in youcoded-dev/.claude/rules/chat-reducer.md is the terse always-injected layer; this doc is the depth.

# Chat Reducer Architecture

Chat state lives in `youcoded/desktop/src/renderer/state/chat-reducer.ts` with types in `chat-types.ts`. A few non-obvious invariants govern how tool activity and turns are scoped.

## Tool activity scoping

`toolCalls` is a **session-lifetime Map** — never cleared. ToolCards need old results for display, so entries persist. Individual entries are updated in-place (status flipped to `failed`), but the Map never resets.

To prevent stale `running` / `awaiting-approval` entries from old turns affecting status indicators, `activeTurnToolIds` (a Set) tracks which tools belong to the current turn. All status checks — StatusDot color, ThinkingIndicator visibility, attention classifier — scan this Set only, not the full Map.

## endTurn() helper

`endTurn()` in chat-reducer.ts:145-167 is the shared path for ending a turn. It:

- Iterates `activeTurnToolIds` and marks any `running` or `awaiting-approval` tool as `failed` with error `'Turn ended'`
- Returns a fresh empty `activeTurnToolIds: new Set()`
- Clears `isThinking`, `streamingText`, `currentGroupId`, `currentTurnId`, and resets `attentionState: 'ok'`

**Always use this helper when adding a new turn-ending code path.** Don't manually clear these fields.

`SESSION_PROCESS_EXITED` spreads `endTurn()` and then overrides `attentionState: 'session-died'` — one of two cases where the post-endTurn attention is not `'ok'`. The other is `NATIVE_SESSION_ERROR` (native runtime, PR Plan A), which spreads `endTurn()` then overrides `attentionState: 'error'` + `errorMessage`; both follow the same spread-then-override pattern.

## Attention classifier

The old 30-second `thinkingTimedOut` watchdog was replaced by a per-session `attentionState` enum driven by three independent signals:

1. **Process liveness** — main-process `session-exit` forwards `exitCode` via IPC; App.tsx dispatches `SESSION_PROCESS_EXITED`. If a turn was in flight OR the exit was nonzero, the reducer calls `endTurn()` and sets `attentionState: 'session-died'`. Clean exits during idle are no-ops.
2. **PTY buffer classifier** — `useAttentionClassifier` ticks every 1s while `isThinking && !hasRunningTools && !hasAwaitingApproval && visible`. It reads the xterm buffer via `getScreenText`, passes the last 40 lines to the pure `classifyBuffer` function (`src/renderer/state/attention-classifier.ts`), and dispatches `ATTENTION_STATE_CHANGED` only when the mapped state differs from the current one. Reset to `'ok'` on unmount.
3. **Transcript corroboration** — `TRANSCRIPT_USER_MESSAGE`, `TRANSCRIPT_ASSISTANT_TEXT`, `TRANSCRIPT_TOOL_USE`, `TRANSCRIPT_TOOL_RESULT`, `PERMISSION_REQUEST`, `TRANSCRIPT_THINKING_HEARTBEAT` (payload-less `assistant-thinking` events — CC's watcher always emits these with `data: {}`), and `TRANSCRIPT_ASSISTANT_REASONING` (added 2026-07-10, PR #115: `assistant-thinking` events WITH `data.text` — per-token reasoning deltas merged into one `reasoning` segment by `partId`, rendered as a collapsed "Show reasoning" disclosure by AssistantTurnBubble; dormant for CC sessions, fires for the Phase 2 native harness) clear `attentionState` back to `'ok'`.

`ChatView` renders `<ThinkingIndicator />` when `attentionState === 'ok' && isThinking`, and shows `<AttentionBanner state={attentionState} />` when `attentionState !== 'ok'`. The banner gate is NOT purely `isThinking`-scoped: the mid-turn state `'stuck'` renders while thinking, but the two **terminal** states (`'session-died'`, `'error'`) render *after* `endTurn()` has cleared `isThinking` — the gate explicitly allows terminal attention through regardless of `isThinking`, else the banner for a turn-ending failure could never appear. The reachable states are `'ok' | 'stuck' | 'session-died' | 'error'` — `'stuck'` covers spinner-glyph-flat-for-30s with no counter advancement, and no-liveness-signal-for-20s (no glyph and no advancing counter); `'session-died'` is set by `SESSION_PROCESS_EXITED` only; `'error'` is set by `NATIVE_SESSION_ERROR` only (native-runtime provider/stream failures — CC sessions never enter it), and its human-readable message rides `SessionChatState.errorMessage`, rendered in preference to the generic banner copy.

The classifier matches `<glyph> <single- or multi-word Gerund>…` (e.g. `* Installing + verifying on device…`). Active vs. stalled is decided by glyph rotation OR seconds-counter advancement across ticks: same glyph for ≥30s AND counter not advancing ⇒ stalled; any glyph rotation OR counter advancement ⇒ active. CC's paren-wrapped `(Nm Ns · …)` / `(Ns · …)` counter is matched by a parallel `COUNTER_RE` so a CC version that pauses glyph rotation but keeps the counter live still classifies as active. The 2026-04-30 empirical audit confirmed the gerund body now allows multi-word phrases. The classifier's patterns are Claude Code CLI-version sensitive — see the version-anchor comment at the top of `attention-classifier.ts`, and re-run `test-conpty/test-spinner-fullcapture.mjs` + `test-conpty/test-attention-states.mjs` whenever CC visuals change.

## Deduplication

User timeline entries carry a `pending?: boolean` flag. `USER_PROMPT` always appends a new entry with `pending: true`. `TRANSCRIPT_USER_MESSAGE` finds the **oldest** pending entry with matching content and clears its flag — confirming the optimistic bubble rather than adding a duplicate. If no pending match exists (remote/replay client, or user typed directly in the terminal), the transcript event appends a new `pending: false` entry.

Replaces the prior content-match-against-last-10-entries approach, which silently dropped legitimate rapid-fire duplicates (e.g. "yes" sent twice within five turns). Pending/confirmed correctly distinguishes "transcript confirms a send already shown" from "two distinct sends that happen to have identical text."

### Tool cards dedup STRUCTURALLY, never by uuid

`TRANSCRIPT_TOOL_USE` deliberately has **no `seenUuids` guard**, unlike `TRANSCRIPT_USER_MESSAGE` / `TRANSCRIPT_ASSISTANT_TEXT`. CC rewrites a JSONL line as the assistant message grows, and a rewrite can carry **new** `tool_use` blocks under the already-seen line uuid — so the watcher re-emits tool-use on repeats by design (`transcript-watcher.ts` `readNewLines`). A uuid guard here would silently swallow those tools; missing cards are far worse than doubled ones.
<!-- verify: {"path": "youcoded/desktop/src/renderer/state/chat-reducer.ts", "contains": "group placement must be IDEMPOTENT"} -->

Instead every write on this path is idempotent by `toolUseId`:

- the `toolCalls` Map — `Map.set` overwrites;
- **group placement** — the handler scans `toolGroups` for the id first and no-ops if already placed, so neither the append nor the new-group branch can double it. A re-emit must also leave `currentGroupId` untouched, or it would retarget where subsequent new tools land;
- `injectPlanSegment` (ExitPlanMode) — dedups by `toolUseId`, updating in place so a later, fuller emit still refreshes content.

`PERMISSION_REQUEST` matches only `running` tools, so a re-delivery for a tool already flipped to `awaiting-approval` would fall through to the synthetic-placeholder branch; it bails first if any tool already carries that `requestId`.
<!-- verify: {"path": "youcoded/desktop/src/renderer/state/chat-reducer.ts", "contains": "never synthesize a SECOND placeholder"} -->

Guard: `chat-reducer.test.ts` → "chatReducer tool card duplication". Historically this surfaced as **duplicate AskUserQuestion prompts appearing once answered** — `AssistantTurnBubble` hides `awaiting-approval` tools from groups (they render as a bottom bubble instead), so a doubled group entry stayed invisible until the answer cleared that status.

## Per-turn metadata

`AssistantTurn` carries four fields populated from the JSONL transcript:

- `stopReason: string | null` — set only for non-`end_turn` completions (`max_tokens`, `refusal`, `stop_sequence`, `pause_turn`). Rendered inline as a footer under the affected turn; `null` means the turn completed normally. The transcript-watcher filters `tool_use` upstream; `end_turn` reaches the reducer but is filtered at the `AssistantTurnBubble` render gate (it's the normal case — no note needed).
- `model: string | null` — Anthropic model ID (e.g. `claude-opus-4-7`). Captured on the first `TRANSCRIPT_ASSISTANT_TEXT` action (Task 2.4) and reconfirmed on `TRANSCRIPT_TURN_COMPLETE`. Drives (a) the opt-in per-turn metadata strip and (b) a reconciliation `useEffect` in App.tsx that silently updates the session-pill `sessionModels` when the transcript reveals drift (user typed `/model X` in the terminal, rate-limit downshift, session resume).
- `usage: TurnUsage | null` — `{ inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens }` from `message.usage`. Populated on `TRANSCRIPT_TURN_COMPLETE`. Displayed only when the `showTurnMetadata` theme-context preference is on (default off — follows the "default hidden" precedent set by the derived StatusBar widgets).
- `anthropicRequestId: string | null` — `req_…` from the transcript line's outer `requestId` field. Surfaced in `AttentionBanner` when state is `session-died` or `error` so the user can reference it when reporting issues.

**Distinct from the permission-flow `requestId`** on `ToolCallState` (used by `PERMISSION_REQUEST` / `PERMISSION_RESPONSE`). The permission `requestId` is a YouCoded-internal approval-flow ID; `anthropicRequestId` is the Anthropic API request ID. Don't conflate — the distinctive name prevents silent cross-wiring.

All four fields default to `null` on turn creation. The reducer's `TRANSCRIPT_TURN_COMPLETE` handler attaches metadata to the completing turn via a spread-then-override BEFORE calling `endTurn()`, because `endTurn()` doesn't touch `assistantTurns` and the override must survive the endTurn state merge.

## PITFALLS-triage additions (2026-07-15)

### Transcript watcher read-integrity (`transcript-watcher.ts`, `subagent-watcher.ts`)

- **`readNewLines` must isolate each emit in try/catch.** `session.offset` advances before the emit loop, so a throwing listener aborting the loop strands every subsequent chunk in the batch (next `readNewLines` reads from the advanced offset forward). A root cause of "rare Claude message not appearing." Keep the per-emit try/catch — do NOT collapse to a batch-level wrapper.
- **`readNewLines` is SERIALIZED per session (`reading` flag + coalesced rerun)** (2026-07-10, both watchers). The read is async (stat → open → read) and triggered concurrently by fs.watch bursts, the global poll, and manual calls. Un-serialized, two overlapping reads consumed the same byte range (duplicate user bubbles, tool cards flapping back to `running`) and — because the read POSITION was re-evaluated after the first read advanced the offset while `bytesRead` was ignored — a short/empty second read decoded its zero-filled buffer into the partial-line carry, wedging NUL bytes in and dropping the next message at `JSON.parse`. The other root cause of "rare missing Claude message." Pinned in `transcript-watcher.test.ts → read integrity`.
- **The incomplete-line carry is BYTES (`partialBytes: Buffer`), not a decoded string.** A string carry decodes each half of a multi-byte UTF-8 char to U+FFFD independently — emoji/CJK split across a read boundary garbled permanently. Stitch bytes before decoding. Don't "simplify" back to `partialLine: string`.
- **`getHistory` replay dedups by uuid with the SAME semantics as the live path** (skip repeated `assistant-text`, first write wins; tool-use/result/turn-complete still emit). The reducer absorbs the re-emitted tool events structurally, not by uuid — see "Deduplication" below. If replay semantics change, change the live path in the same commit.
- **`usePromptDetector` reads `getVisibleScreenText` (screen + margin), NOT the full scrollback; the classifier's IPC eval passes a 120-row tail.** Serializing the whole 1000+-row buffer per rAF flush was the top renderer CPU cost while streaming. The tail walk-back in `terminal-registry.getScreenText` never starts mid-wrapped-line — keep it. Load-bearing side effect: menus that scrolled into scrollback can no longer shadow a live Ink menu.
- **SubagentWatcher polls are slow (5s) safety nets by design — the fast paths are event-driven.** `TranscriptWatcher` calls `kickScan()` when a parent Agent tool_use lands (instant discovery of the subagents dir/new files) and `settleByParent()` when the parent's tool-result lands (final read, then the per-file stat poll stops; fs.watch stays attached). Don't speed the polls up "for responsiveness" (regresses idle-CPU accumulation) and don't remove the kick/settle calls.
- **`<local-command-stdout>`/`<local-command-stderr>` are STRIPPED ENTIRELY in `stripSystemTags` — DO NOT switch back to unwrapping.** CC writes these as dimmed status echoes. After every `/compact` it writes a follow-up user-type line `<local-command-stdout>[2mCompacted (ctrl+o to see full summary)[22m</local-command-stdout>`. Unwrapping let CC's echo reach `TRANSCRIPT_USER_MESSAGE`'s "no pending match" path, which BOTH appended a fake "Compacted…" user bubble AND set `isThinking:true` with no turn to ever clear it (chat permanently stuck thinking after compaction). Both TS and Kotlin parsers strip these entirely; `transcript-watcher.test.ts` pins the JSONL fixture line. Route any new slash-command output through a NEW event type — don't reintroduce the user-message path.
- **The `compact-summary` transcript event carries the full summary text in `data.summary`.** `SystemMarker.tsx` renders click-to-expand on the thin "Compacted · freed X tokens" divider. Both `App.tsx` and `BubbleFeed.tsx` forward `event.data.summary` into `COMPACTION_COMPLETE`; the reducer stores it on `SystemMarker.summary`. Aborted/watchdog completions carry no summary — keep the `expandable = !!marker.summary` gate.

### Spinner classifier regex-anchoring (`attention-classifier.ts`)

- **Spinner classifier matches glyph + gerund + ellipsis ONLY — no seconds counter, no "esc to interrupt".** CC v2.1.119 emits `<glyph> Gerund…` with no suffix. The old regex required `(Ns · esc to interrupt)` and silently failed on every real turn → the no-spinner-20s escalation flashed the wrong "Still waiting on Claude" banner during every long thinking turn. Active-vs-stalled is decided by glyph rotation (same glyph ≥30s = stalled, threshold raised from 10s after CC was observed holding one glyph 10–20s during silent thinking). Since 2026-04-30 (`669fc86d`) a parallel paren-wrapped `(Nm Ns · …)` `COUNTER_RE` gives an independent OR liveness signal; `previousCounterSeconds` feeds back through `ClassifierContext` so the no-signal-20s escalation gates on BOTH glyph absence AND counter non-advancement. `SPINNER_RE` was widened `[A-Za-z]+…` → `[A-Za-z][A-Za-z +\-]*…` for multi-word gerunds.
- **`SPINNER_RE` is anchored to start of line — DO NOT remove the `^`.** The false-match probe (`test-conpty/test-attention-false-match.mjs`, `@xterm/headless` for production-accurate rendering) confirmed that without the anchor the classifier matches Claude's response text containing `* Loading…` bullets, echoed prompts with literal spinner glyphs (`❯ Output…: ✻ Pondering…`), and `●`-prefixed assistant turns. Real CC spinner lines always have the glyph at column 0. The pattern STOPS at `…` so it still matches the hook-execution variant `✶ Channelling… (running stop hook · 3s · ↓ 1 tokens)`. If you tighten further (e.g. requiring trailing whitespace), the hook variant silently stops matching. Verify on a CC bump: `test-conpty/test-spinner-fullcapture.mjs` + `test-conpty/test-attention-states.mjs` (both wired into `cc-dependencies.md` "PTY spinner regex").

### Terminal byte stream — Android xterm-in-WebView (`terminal-emulator-vendored/`, `usePtyRawBytes.ts`, `TerminalView.tsx`)

- **`terminal-emulator-vendored/` is pinned to Termux v0.118.1 with a single documented patch** (a `RawByteListener` hook on `TerminalEmulator.append()`). `VENDORED.md` is the source of truth. Never edit outside the documented patch.
- **The vendored emulator is HEADLESS as of Tier 2.** The native Termux `TerminalView` Compose block was removed from `ChatScreen.kt` + the `terminal-view:v0.118.1` Maven dep dropped. `TerminalSession` still owns the PTY fork + JNI waitpid loop + `TerminalEmulator.append()`; `RawByteListener` is the single tap point feeding bytes to React xterm via `pty:raw-bytes`. Don't reintroduce a native render path.
- **`RawByteListener` fires on the terminal thread** (same thread that calls `append()`). Implementations MUST copy bytes before any async work — Termux reuses the same `byte[]` across PTY reads. `PtyBridge.rawByteFlow` uses `tryEmit` on a bounded `MutableSharedFlow` so a slow consumer drops bytes rather than blocking the terminal thread.
- **`pty:raw-bytes` payload is base64-encoded** (JSON can't carry binary; UTF-8 corrupts high-bit ANSI bytes). Never change the encoding without updating `raw-byte-listener-contract.test.ts` + every consumer at once. Full three-surface parity: `preload.ts` (no-op stub), `remote-shim.ts` (real per-session dispatch), `SessionService.kt` — asserted by `ipc-channels.test.ts` (no `ipc-handlers.ts` entry — it's a push event).
- **xterm display-only on touch.** `TerminalView` passes `disableStdin:true` on touch platforms (Android + remote browser) and skips `terminal.onData → sendInput`; typing flows through InputBar minimal-mode `<textarea>`. Don't reintroduce xterm-side touch input (re-exposes xterm.js #2403 IME issues). Single-finger touch scroll is custom capture-phase JS routing to `terminal.scrollLines()` (xterm's mouse selection bypassed via `preventDefault`); text selection on touch is unavailable — don't "fix" by removing the handlers.
- **`shared-fixtures/attention-classifier/` is the contract** — adding a `BufferClass` or tweaking a `classifyBuffer` regex requires a fixture change in the same commit; `attention-classifier-parity.test.ts` enforces it.
- **xterm scrollback can show duplicated TUI chrome** — CC (Ink) redraws its full TUI on certain events; when it exceeds visible rows, older content scrolls into xterm's scrollback. No xterm option discards programmatically-scrolled content (alt-screen would lose ALL scrollback). Mitigation deferred (bumping `scrollback` to 5000+ would let history coexist with banner duplicates).
