# Chat Persistence Between Panels

**Date:** 2026-03-19
**Status:** Approved

## Problem

Chat messages and text input do not persist when switching between Chat, Terminal, and Shell modes. Text typed in the input field is lost on mode switch. Messages sent in Terminal mode don't appear in the Chat view.

## Requirements

1. **Shared input draft** — one text field state per session, persists across Chat/Terminal/Shell mode switches
2. **Terminal input captured to ChatState** — every Send in terminal mode creates a user message bubble
3. **Claude responses already sync** — hook events flow to ChatState regardless of mode (no change needed)
4. **Remove Enter pill** — remove the `⏎` button from TerminalKeyboardRow; Send button and Gboard IME action are the only submit mechanisms
5. **Send requires text** — no empty sends in any mode
6. **Per-session drafts** — switching sessions restores that session's draft; drafts are in-memory only

## Approach: Lift draft into ChatState

ChatState already serves as the per-session UI state container (messages, processing flags, expanded card state). Adding `inputDraft` follows the existing pattern.

### Changes

#### 1. ChatState

Add one field:

```kotlin
var inputDraft by mutableStateOf("")
```

#### 2. ChatScreen — Chat mode input

- Replace local `chatInputText` with `chatState.inputDraft`
- Remove the `var chatInputText by remember { mutableStateOf("") }` declaration
- Send button clears `chatState.inputDraft = ""`

#### 3. ChatScreen — Terminal mode input

- `TerminalInputBar` becomes a controlled component: receives `chatState.inputDraft` as parameter and an `onDraftChange` callback
- On send: `chatState.addUserMessage(text)` → `bridge.writeInput(text + "\r")` → clear draft
- Send guard: require `isNotBlank()`

#### 4. TerminalKeyboardRow

- Remove the `⏎` Enter pill (lines 76-83)
- Remaining keys: Ctrl, Esc, Tab, ←, ↑, ↓, →

### Data Flow

```
User types in any mode
        ↓
chatState.inputDraft (shared, per-session)
        ↓
User taps Send / Gboard Send
        ↓
chatState.addUserMessage(text)  ← message bubble created
bridge.writeInput(text + "\r")  ← sent to PTY
chatState.inputDraft = ""       ← draft cleared
        ↓
Claude processes in PTY
        ↓
Hook events → chatState (already working)
        ↓
Chat view shows full conversation
regardless of which mode it was sent from
```

### What's NOT changing

- No disk persistence for drafts (matches current behavior — messages aren't persisted either)
- No changes to Shell mode input (DirectShellBridge)
- No changes to hook event routing
- No changes to session lifecycle
- TerminalKeyboardRow special keys (Ctrl, Esc, Tab, arrows) still bypass the text field via `onKeyPress`
