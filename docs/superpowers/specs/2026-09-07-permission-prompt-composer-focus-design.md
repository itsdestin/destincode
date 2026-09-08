# Permission prompt composer-focus design

## Goal

Pressing Enter to choose **Yes**, **No**, or **Always allow** on a permission prompt must not briefly move focus to the message composer. This allows consecutive prompts to be answered with the keyboard without an intermediate focus change.

## Cause

`InputBar` installs a window-level keydown listener that focuses the composer when a printable key, Backspace, or Enter is pressed outside a typing field. Permission buttons are not typing fields. Therefore, an Enter press on a focused permission button reaches this listener before the prompt handles the decision, and the composer receives focus.

## Chosen approach

Broaden the composer listener's guard from "typing target" to "interactive target." If focus is on a native interactive control—button, link, menu option, checkbox, radio button, select, summary, or an explicitly interactive ARIA role—the listener returns without focusing the composer.

The change is deliberately local to `InputBar` because the behavior being changed is the composer's global auto-focus behavior. Permission cards continue to own their existing keyboard handling.

## Behavior

- Enter on a permission choice stays on that prompt; the composer is not focused.
- Arrow-key selection and Enter activation in permission cards are unchanged.
- Typing on an unfocused, non-interactive page area still moves focus to the composer.
- Text fields and CodeMirror continue to be protected by the existing `isTypingTarget` rule.
- Other buttons, links, menu controls, and equivalent accessible controls are protected consistently, preventing the same focus theft elsewhere.

## Error handling

No new failures or user-facing errors are introduced. The guard only decides whether the composer shortcut should act on an existing key event.

## Verification

Run the focused desktop typecheck/lint test command appropriate to the changed renderer file, then the required desktop verification script. Manual behavior can be checked only in the isolated dev app, never the live app. Per user direction, no new regression test will be added for this focused fix.
