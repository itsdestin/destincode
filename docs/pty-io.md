> Migrated from youcoded-dev docs/PITFALLS.md (2026-07-15 triage). The path-scoped rule in youcoded-dev/.claude/rules/pty-io.md is the terse always-injected layer; this doc is the depth.

# PTY I/O mechanism — depth

Writing programmatically into Claude Code's Ink TUI input bar exposes undocumented behaviors. Submit logic: `desktop/src/main/pty-worker.js` (case `'input'`) + `app/.../PtyBridge.kt` (`writeInput`). Renderer safety net: `useSubmitConfirmation.ts`. Gate: `state/pty-input-gate.ts`.

## The mechanism (April 2026 audit, CC v2.1.119)

- **Paste classification is LENGTH-GATED.** Empirical bisection (`test-conpty/cc-snapshot.mjs`): an atomic 63-byte write (62-char body + `\r`) submits cleanly; an atomic 64-byte write (63-char body + `\r`) leaves the body in the input bar with a literal `\n` — the `\r` was absorbed as paste content. The threshold is **exactly 64 bytes** for CC v2.1.119 (likely an Ink buffer-size constant); future versions may shift it. The bisected value lives in `test-conpty/snapshots/cc-<version>.json` — re-run `cc-snapshot.mjs` on each CC bump and diff.
- **CC echoes typed bytes back through stdout** (Ink re-renders the input bar). Cold-start delay ~6.7s on Windows; warm-session sub-second. Universal TUI behavior but also a CC-internal contract — see `docs/cc-dependencies.md` "PTY input-bar echo."
- **Windows ConPTY drops bytes on large single writes** (>~600). Bracketed-paste markers don't survive ConPTY at all. Both are addressed by chunking the body ≤56 bytes.

## The submit protocol (post-April-2026 redesign)

Three deterministic shapes; no 600ms timing guesses on the Windows path:

1. **Passthrough** — no trailing `\r`. Single write.
2. **Atomic submit** — `\r` AND total ≤ `SAFE_ATOMIC_LEN` (56 bytes; 8-byte margin under the threshold). One write.
3. **Echo-driven submit** (desktop) / **600ms split** (Android) — `\r` AND >56. Chunk body ≤56 bytes, then `\r` separately.
   - **Desktop:** wait for the body tail to echo from CC stdout (proving CC drained the body from its input pipe), then write `\r` as one byte — no timing assumption. On echo timeout (`ECHO_TIMEOUT_MS`, 12s) SUPPRESS the CR (no echo ⇒ a live Ink select menu has focus; a blind `\r` answers it). Recovery is the renderer retry. Do NOT reintroduce the blind fallback CR (2026-07-09 stray-Enter fix, youcoded#110).
   - **Android:** still 600ms gap (Linux PTY has no ConPTY gap-collapse). Mirroring desktop's echo-driven approach is a TODO in `PtyBridge.writeInput`.

## Invariants

- Don't reintroduce a 600ms enter-split in the desktop worker (echo observation makes it superfluous + timing-fragile).
- Don't atomic-write any `body + \r` longer than 56 bytes — the constants are version-coupled and can shift downward.
- Don't reintroduce bracketed-paste markers (`\x1b[200~...\x1b[201~`) on Windows (ConPTY mangles them).
- **`useSubmitConfirmation` is the second-line defense** — sends a bare `\r` only when `pending` stays set 8s after submit AND `canRetrySubmit()` passes: `attentionState==='ok'`, no awaiting-approval/running current-turn tools, no in-flight assistant turn, no uncompleted interactive prompt. `attentionState==='ok'` ALONE is not idle (normal mid-turn + while a permission/AskUserQuestion menu is up); gating on it alone auto-answered prompts. Don't gate on `!isThinking` (never clears if CC never got the message).
- **Never write to the PTY during a pending interaction** — CC's Ink select menu is LIVE while a hook permission card is up. Every automated writer consults `hasPendingInteraction`/`canRetrySubmit` or main-side `HookRelay.hasPendingPermission(sessionId)`. Deliberate menu-drivers (ToolCard plan-approval arrows, TrustGate, terminal-view xterm keystrokes) intentionally bypass. Fixed youcoded#110.
- **One sanitized string** — the optimistic bubble + PTY send both derive from `components/outgoing-message.ts`; the transcript confirms by EXACT content match (PTY send replaces newlines with spaces). A newline-bearing bubble stayed `pending` forever + armed a stray retry `\r`.

## Diagnostics

- `YOUCODED_PTY_TRACE=1` → per-event trace at `~/.claude/youcoded-pty-trace-<pid>.log` (`IN`, `ATOMIC`, `CHUNK k=X/Y`, `ECHO_WAIT`, `ECHO_OK`, `ECHO_TIMEOUT … suppressing CR`, `CR after-echo`, `PASSTHROUGH`, `INPUT_ERROR`). Zero overhead when unset.
- `test-conpty/test-worker-submit.mjs` runs the actual forked `pty-worker.js` against real `claude`.
- `test-conpty/test-multiline-submit.mjs` runs `node-pty` directly (distinguishes CC behavior from worker regressions).
- `test-conpty/cc-snapshot.mjs` captures the empirical baseline (paste threshold, echo). `test-conpty/README.md` is the reusable methodology.

## PTY resize (Windows) & ESC routing

- **`TerminalView.fitAndSync` dedups on unchanged cols/rows** before the resize IPC — ConPTY reflows + re-emits its buffer on every resize, and the ResizeObserver + `proposeDimensions()` fire spuriously (font load, jitter), so without dedup CC's Ink UI is re-emitted into xterm scrollback (duplicated chrome). The dedup is a closure (`lastCols`/`lastRows`) in the mount effect — keep it in the renderer, which owns "what dimensions should the PTY be." Android unaffected (no reflow on SIGWINCH).
- **ESC flows through `useEscClose` → chat-passthrough** (capture-phase `preventDefault` on a popped overlay; App bubble-phase reads `defaultPrevented` before forwarding `\x1b`). Returns when `viewMode==='terminal'` (xterm forwards ESC natively). Chat-to-PTY interrupt is single-byte — don't wrap it in the paste-splitter. Interrupt markers (`[Request interrupted by user]`) become `user-interrupt` events → `TRANSCRIPT_INTERRUPT` → `endTurn()`.

## Launch environment

- **Spawned `claude` must NOT inherit CC's session-identity env vars** (`CLAUDECODE`, `CLAUDE_CODE_SESSION_ID`, etc.). Launched from inside a CC session, the child believes it's nested — nested interactive CC writes NO top-level transcript, so the chat view stays permanently EMPTY (terminal view works, hooks fire — masking the cause). `pty-worker.js` case `'spawn'` DELETES those vars. Don't re-add a raw `...process.env` spread. `CLAUDE_DESKTOP_SESSION_ID`/`_PIPE` are ours, set fresh. Android unaffected. Shipped youcoded#106. Diagnostic signature: terminal view works + chat view empty + no `<session-id>*.jsonl` under `~/.claude/projects` even though `topics/`, `.gitbranch-`, `.session-stats-` sidecars exist. (`claude -p` is NOT a repro — print mode always writes a transcript.)
