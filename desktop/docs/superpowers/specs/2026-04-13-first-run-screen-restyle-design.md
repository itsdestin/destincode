# First-Run Screen Restyle — Design

**Status:** Design
**Scope:** `destincode/desktop/src/renderer/components/FirstRunView.tsx`

## Problem

The first-run screen is the literal first impression of DestinCode. Today it's a flat, generic "installer dialog" that doesn't match the app's visual language or prepare the user for what comes next.

Specifically:
- Uses hardcoded Tailwind grays/blues/oranges (`bg-gray-950`, `bg-blue-500`, `bg-orange-600`) — no relation to the app's theme system.
- Uses a crude `<span className="animate-spin">⦖</span>` as its progress indicator, ignoring the `BrailleSpinner` component that powers the rest of the app.
- Prerequisite list is a flat `<ul>` with no pill/card shaping.
- Provides no step-by-step explanation of *what* is being installed or *why*.
- Completion state vanishes into the app with no "here's what to do next" guidance.

## Goal

Make the first-run screen feel like part of DestinCode — branded, warm, friendly to non-technical users — and tell the user what's happening and what to do next.

## Design

### Theme basis: Creme (fixed, not user-driven)

The user has no theme preference on first launch. Rather than hardcode hex values, `FirstRunView` sets `data-theme="creme"` on `<html>` while mounted and clears it on unmount. All styling then uses theme tokens (`bg-canvas`, `bg-panel`, `bg-inset`, `bg-well`, `bg-accent`, `text-on-accent`, `text-fg`, `text-fg-2`, `text-fg-dim`, `text-fg-muted`, `text-fg-faint`, `border-edge`, `border-edge-dim`).

When the main app mounts after completion, `ThemeProvider` takes over and overrides `data-theme` with whatever default the provider applies. The `FirstRunView` cleanup should not race with `ThemeProvider` — since `FirstRunView` unmounts *before* the main app mounts in `App.tsx`, this is safe, but we explicitly clear the attribute on unmount to be defensive.

### Layout (top → bottom)

```
┌─────────────────────────────────────────────┐
│                                             │
│              DestinCode                     │   ← wordmark, text-fg
│                                             │
│   Installing Node.js — this runs the AI     │   ← per-step explainer, text-fg-dim
│   engine under the hood. One-time setup,    │
│   about a minute.                           │
│                                             │
│   ╭─────────────────────────────────────╮   │
│   │ ✓  Node.js                v20.11.0  │   │   ← completed pill, border-edge
│   ╰─────────────────────────────────────╯   │
│   ╭─────────────────────────────────────╮   │
│   │ ⠏  Git             installing...    │   │   ← active pill, bg-inset + BrailleSpinner
│   ╰─────────────────────────────────────╯   │
│   ╭─────────────────────────────────────╮   │
│   │ ○  Claude Code           waiting    │   │   ← pending pill, text-fg-faint
│   ╰─────────────────────────────────────╯   │
│   ╭─────────────────────────────────────╮   │
│   │ ○  DestinClaude toolkit  waiting    │   │
│   ╰─────────────────────────────────────╯   │
│                                             │
│   ▰▰▰▰▰▱▱▱▱▱▱▱▱▱▱▱▱▱▱▱   42%              │   ← bar: bg-inset track, bg-accent fill
│                                             │
│                                             │
│               Skip setup                    │   ← tiny, text-fg-faint
│                                             │
└─────────────────────────────────────────────┘
```

### Components

#### StatusIcon (restyled)

Drives per-row indicator:

| Status | Glyph / component | Color |
|---|---|---|
| `installed` | `✓` | `--accent` |
| `installing` / `checking` | `<BrailleSpinner size="sm" />` | theme-cycling (component-driven) |
| `failed` | `✗` | theme-independent red (kept) |
| `skipped` | `—` | `text-fg-faint` |
| `waiting` | `○` | `text-fg-faint` |

The BrailleSpinner already exists and already pulls theme colors dynamically. No changes to that component.

#### Prerequisite pill

```tsx
<li
  className={[
    "flex items-center gap-3 rounded-full px-4 py-2.5 border transition-colors",
    active ? "bg-inset border-edge" : "bg-panel border-edge-dim",
  ].join(" ")}
>
  <StatusIcon status={p.status} />
  <span className="text-sm text-fg">{p.displayName}</span>
  <span className="ml-auto text-xs text-fg-muted">{statusLabel(p.status, p.version)}</span>
</li>
```

`active` = `p.status === 'installing' || p.status === 'checking'`.

Rounded-full (pill) matches the app's session-pill visual language. Rows stack with `space-y-2`.

#### ProgressBar (inline %)

```tsx
<div className="w-full flex items-center gap-3">
  <div className="flex-1 h-1.5 rounded-full bg-inset overflow-hidden">
    <div
      className="h-full rounded-full bg-accent transition-all duration-500"
      style={{ width: `${percent}%` }}
    />
  </div>
  <span className="text-xs text-fg-muted tabular-nums w-10 text-right">{percent}%</span>
</div>
```

Thinner (1.5 → feels lighter), accent-tinted, percent inline instead of stacked.

#### What's-happening line

A single sentence above the checklist that updates as the user moves through setup. Not a banner, not a separate panel — just a line of `text-sm text-fg-dim`. Copy is driven by a pure function `describeStep(state)`:

| State | Copy |
|---|---|
| Checking existing prerequisites | "Checking what's already installed on this machine." |
| Installing Node.js | "Installing Node.js — this runs the AI engine under the hood." |
| Installing Git | "Installing Git — used to keep DestinCode and your skills up to date." |
| Installing Claude Code | "Installing Claude Code — the AI that powers DestinCode." |
| Installing toolkit | "Installing the DestinClaude toolkit — skills, themes, and sync." |
| `AUTHENTICATE` | "Sign in with your Claude account to finish setup." |
| `ENABLE_DEVELOPER_MODE` | "One Windows setting to enable, then we're done." |
| `LAUNCH_WIZARD` / `COMPLETE` | "All set. Opening DestinCode…" |
| error present | "Something went wrong. You can retry the last step or skip for now." |

The active prerequisite is determined by the first entry with `status === 'installing'` or `status === 'checking'`, falling back to the step-level message if none.

#### Auth card

Replaces the current flat button column with a single rounded card (`bg-panel border border-edge rounded-2xl p-6`) containing:
- A one-line intro: "Sign in with your Claude Pro or Max plan. No API key or credit card needed."
- Primary button: `bg-accent text-on-accent rounded-full px-6 py-3` — "Log in with Claude"
- Secondary link (quieter): "I have an API key instead"
- When API-key mode is expanded, the input uses `bg-well border border-edge` to match app inputs, and the explainer text remains.

#### Dev-mode card

Same card shell. Existing copy preserved (it's already clear) but restyled with theme tokens and a `bg-accent text-on-accent` primary button.

#### Completion card

New. When `state.currentStep === 'LAUNCH_WIZARD'` or `'COMPLETE'`, swap the checklist area for a small card:

```
You're all set.

Here's what to try first:
  •  Pick a theme — Settings → Appearance
  •  Install a skill — the marketplace is one click away
  •  Sync across devices — optional, but handy

Opening DestinCode now…
```

Uses `text-fg` for heading, `text-fg-dim` for bullets, small `<BrailleSpinner>` next to the "Opening…" line. Auto-advances via the existing 1.5s `setTimeout` to `onComplete`.

#### Error state

Unchanged structure (red text + retry button), but restyled: error text in theme-independent red (kept), retry button as `bg-well border border-edge` secondary style.

### Skip link

Kept in place (bottom, tiny `text-fg-faint`). Copy unchanged.

## Non-goals

- No changes to the first-run state machine, IPC surface, or `first-run.ts` logic.
- No changes to `BrailleSpinner`.
- No changes to the shell installer scripts (`bootstrap/install.sh`, `install-app.sh`) — out of scope.
- No changes to the global `ThemeProvider`.

## Implementation notes

- Set `data-theme="creme"` via `useEffect` on mount, clear on unmount.
- Extract a pure `describeStep(state): string` function for the "what's happening" copy — makes it unit-testable and keeps the component tidy.
- Keep the existing `StatusIcon`/`statusLabel`/`ProgressBar` function signatures; restyle their internals only.
- No new dependencies.

## Testing

- Manual: walk through install on a clean VM for all three platforms (Win/Mac/Linux). Verify Creme palette renders, BrailleSpinner animates, step copy updates, completion card appears before app loads, skip button still works.
- Unit: add a small test for `describeStep()` covering each step/status permutation.
