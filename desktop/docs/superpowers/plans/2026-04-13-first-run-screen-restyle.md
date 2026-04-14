# First-Run Screen Restyle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle `FirstRunView.tsx` to match DestinCode's visual language (Creme theme, BrailleSpinner, pill rows, per-step explainer, completion next-steps card) while preserving all existing first-run state/IPC behavior.

**Architecture:** All changes are contained to `FirstRunView.tsx` plus one new pure helper (`describe-step.ts`) with unit tests. The screen locks the page to `data-theme="creme"` while mounted so it can use the app's theme tokens (`bg-canvas`, `bg-panel`, etc.) without depending on any user preference that doesn't exist yet.

**Tech Stack:** React 18, Vitest, TailwindCSS with theme CSS variables, existing `BrailleSpinner` component.

**Spec:** `desktop/docs/superpowers/specs/2026-04-13-first-run-screen-restyle-design.md`

---

## File map

- Create: `desktop/src/renderer/components/first-run/describe-step.ts` — pure function mapping `FirstRunState` to a single-sentence "what's happening" string.
- Create: `desktop/tests/describe-step.test.ts` — unit tests for the mapping.
- Modify: `desktop/src/renderer/components/FirstRunView.tsx` — full restyle (StatusIcon, ProgressBar, list, AuthScreen, DevModeScreen, root container, new CompletionCard, theme lock effect, explainer line).

---

## Task 1: Add `describeStep()` pure helper with tests

**Files:**
- Create: `desktop/src/renderer/components/first-run/describe-step.ts`
- Test: `desktop/tests/describe-step.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `desktop/tests/describe-step.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { describeStep } from '../src/renderer/components/first-run/describe-step';
import type { FirstRunState } from '../src/shared/first-run-types';

function state(overrides: Partial<FirstRunState> = {}): FirstRunState {
  return {
    currentStep: 'DETECT_PREREQUISITES',
    prerequisites: [
      { name: 'node', displayName: 'Node.js', status: 'waiting' },
      { name: 'git', displayName: 'Git', status: 'waiting' },
      { name: 'claude', displayName: 'Claude Code', status: 'waiting' },
      { name: 'toolkit', displayName: 'DestinClaude Toolkit', status: 'waiting' },
      { name: 'auth', displayName: 'Sign in', status: 'waiting' },
    ],
    overallProgress: 0,
    statusMessage: '',
    authMode: 'none',
    authComplete: false,
    needsDevMode: false,
    ...overrides,
  };
}

describe('describeStep', () => {
  it('describes the detect phase when nothing is installing yet', () => {
    expect(describeStep(state({ currentStep: 'DETECT_PREREQUISITES' })))
      .toBe("Checking what's already installed on this machine.");
  });

  it('names the currently-installing prerequisite (Node.js)', () => {
    const s = state({
      currentStep: 'INSTALL_PREREQUISITES',
      prerequisites: [
        { name: 'node', displayName: 'Node.js', status: 'installing' },
        { name: 'git', displayName: 'Git', status: 'waiting' },
        { name: 'claude', displayName: 'Claude Code', status: 'waiting' },
        { name: 'toolkit', displayName: 'DestinClaude Toolkit', status: 'waiting' },
        { name: 'auth', displayName: 'Sign in', status: 'waiting' },
      ],
    });
    expect(describeStep(s)).toBe(
      'Installing Node.js — this runs the AI engine under the hood.',
    );
  });

  it('names Git when Git is installing', () => {
    const s = state({
      currentStep: 'INSTALL_PREREQUISITES',
      prerequisites: [
        { name: 'node', displayName: 'Node.js', status: 'installed', version: 'v20.11.0' },
        { name: 'git', displayName: 'Git', status: 'installing' },
        { name: 'claude', displayName: 'Claude Code', status: 'waiting' },
        { name: 'toolkit', displayName: 'DestinClaude Toolkit', status: 'waiting' },
        { name: 'auth', displayName: 'Sign in', status: 'waiting' },
      ],
    });
    expect(describeStep(s)).toBe(
      'Installing Git — used to keep DestinCode and your skills up to date.',
    );
  });

  it('names Claude Code when Claude is installing', () => {
    const s = state({
      currentStep: 'INSTALL_PREREQUISITES',
      prerequisites: [
        { name: 'node', displayName: 'Node.js', status: 'installed' },
        { name: 'git', displayName: 'Git', status: 'installed' },
        { name: 'claude', displayName: 'Claude Code', status: 'installing' },
        { name: 'toolkit', displayName: 'DestinClaude Toolkit', status: 'waiting' },
        { name: 'auth', displayName: 'Sign in', status: 'waiting' },
      ],
    });
    expect(describeStep(s)).toBe(
      'Installing Claude Code — the AI that powers DestinCode.',
    );
  });

  it('names the toolkit when toolkit is installing', () => {
    const s = state({
      currentStep: 'CLONE_TOOLKIT',
      prerequisites: [
        { name: 'node', displayName: 'Node.js', status: 'installed' },
        { name: 'git', displayName: 'Git', status: 'installed' },
        { name: 'claude', displayName: 'Claude Code', status: 'installed' },
        { name: 'toolkit', displayName: 'DestinClaude Toolkit', status: 'installing' },
        { name: 'auth', displayName: 'Sign in', status: 'waiting' },
      ],
    });
    expect(describeStep(s)).toBe(
      'Installing the DestinClaude toolkit — skills, themes, and sync.',
    );
  });

  it('describes the auth step', () => {
    expect(describeStep(state({ currentStep: 'AUTHENTICATE' })))
      .toBe('Sign in with your Claude account to finish setup.');
  });

  it('describes the developer-mode step', () => {
    expect(describeStep(state({ currentStep: 'ENABLE_DEVELOPER_MODE' })))
      .toBe("One Windows setting to enable, then we're done.");
  });

  it('describes the completion step', () => {
    expect(describeStep(state({ currentStep: 'LAUNCH_WIZARD' })))
      .toBe('All set. Opening DestinCode…');
    expect(describeStep(state({ currentStep: 'COMPLETE' })))
      .toBe('All set. Opening DestinCode…');
  });

  it('describes an error state when lastError is set', () => {
    const s = state({
      currentStep: 'INSTALL_PREREQUISITES',
      lastError: 'Could not download Node.js',
    });
    expect(describeStep(s)).toBe(
      'Something went wrong. You can retry the last step or skip for now.',
    );
  });

  it('falls back to the generic install message when nothing specific is installing', () => {
    expect(describeStep(state({ currentStep: 'INSTALL_PREREQUISITES' })))
      .toBe('Getting the next piece ready…');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd destincode/desktop && npx vitest run tests/describe-step.test.ts`
Expected: FAIL with "Cannot find module '../src/renderer/components/first-run/describe-step'"

- [ ] **Step 3: Implement the function**

Create `desktop/src/renderer/components/first-run/describe-step.ts`:

```ts
import type { FirstRunState, PrerequisiteState } from '../../../shared/first-run-types';

// Per-prerequisite copy. Keys match PrerequisiteState.name.
const PREREQ_COPY: Record<string, string> = {
  node: 'Installing Node.js — this runs the AI engine under the hood.',
  git: 'Installing Git — used to keep DestinCode and your skills up to date.',
  claude: 'Installing Claude Code — the AI that powers DestinCode.',
  toolkit: 'Installing the DestinClaude toolkit — skills, themes, and sync.',
};

function activePrerequisite(prereqs: PrerequisiteState[]): PrerequisiteState | undefined {
  return prereqs.find(
    (p) => p.status === 'installing' || p.status === 'checking',
  );
}

/**
 * Single-sentence explainer for the first-run screen. Tells the user
 * what's happening right now and why, scoped to the current state.
 */
export function describeStep(state: FirstRunState): string {
  if (state.lastError) {
    return 'Something went wrong. You can retry the last step or skip for now.';
  }

  switch (state.currentStep) {
    case 'DETECT_PREREQUISITES':
      return "Checking what's already installed on this machine.";

    case 'INSTALL_PREREQUISITES':
    case 'CLONE_TOOLKIT': {
      const active = activePrerequisite(state.prerequisites);
      if (active && PREREQ_COPY[active.name]) {
        return PREREQ_COPY[active.name];
      }
      return 'Getting the next piece ready…';
    }

    case 'AUTHENTICATE':
      return 'Sign in with your Claude account to finish setup.';

    case 'ENABLE_DEVELOPER_MODE':
      return "One Windows setting to enable, then we're done.";

    case 'LAUNCH_WIZARD':
    case 'COMPLETE':
      return 'All set. Opening DestinCode…';
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd destincode/desktop && npx vitest run tests/describe-step.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
cd destincode && git add desktop/src/renderer/components/first-run/describe-step.ts desktop/tests/describe-step.test.ts
git commit -m "feat(first-run): add describeStep() helper for per-step explainer copy"
```

---

## Task 2: Lock page to Creme theme while FirstRunView is mounted

**Files:**
- Modify: `desktop/src/renderer/components/FirstRunView.tsx`

- [ ] **Step 1: Add theme-lock effect inside the `FirstRunView` component**

Add this effect near the top of the `FirstRunView` component body, before the existing `useEffect` that fetches initial state:

```tsx
// First launch has no user theme — lock the screen to Creme so the app's
// theme tokens resolve to a designed onboarding palette. ThemeProvider
// overrides this once the main app mounts after completion.
useEffect(() => {
  const root = document.documentElement;
  const prev = root.getAttribute('data-theme');
  root.setAttribute('data-theme', 'creme');
  return () => {
    if (prev) root.setAttribute('data-theme', prev);
    else root.removeAttribute('data-theme');
  };
}, []);
```

- [ ] **Step 2: Commit**

```bash
cd destincode && git add desktop/src/renderer/components/FirstRunView.tsx
git commit -m "feat(first-run): lock onboarding screen to Creme theme"
```

---

## Task 3: Restyle `StatusIcon` to use `BrailleSpinner` + theme tokens

**Files:**
- Modify: `desktop/src/renderer/components/FirstRunView.tsx`

- [ ] **Step 1: Import `BrailleSpinner`**

At the top of `FirstRunView.tsx`, add:

```tsx
import BrailleSpinner from './BrailleSpinner';
```

- [ ] **Step 2: Replace the `StatusIcon` implementation**

Replace the existing `StatusIcon` function (lines 8-23) with:

```tsx
function StatusIcon({ status }: { status: PrerequisiteState['status'] }) {
  switch (status) {
    case 'installed':
      return <span className="text-accent">&#10003;</span>;
    case 'installing':
    case 'checking':
      return <BrailleSpinner size="sm" />;
    case 'failed':
      // Status colors stay theme-independent per CLAUDE.md.
      return <span className="text-red-500">&#10007;</span>;
    case 'skipped':
      return <span className="text-fg-faint">&#8212;</span>;
    case 'waiting':
    default:
      return <span className="text-fg-faint">&#9675;</span>;
  }
}
```

Notes:
- `text-accent`, `text-fg-faint`, etc. are mapped to CSS variables via the `@theme { }` block in `globals.css`. All `bg-*`, `text-*`, and `border-*` token utilities used throughout this plan resolve to the live theme variables.

- [ ] **Step 3: Manual verification (run dev app)**

Run: `bash scripts/run-dev.sh` from workspace root.
Expected: On a machine with an existing install, you'll need to temporarily trigger the first-run view by renaming `~/.claude/destincode-first-run.json` (or equivalent flag) — but this manual step can be skipped if the reviewer already has a clean-state VM. Key check: the rotating Braille glyph appears for any `installing`/`checking` row instead of the old `⦖`.

- [ ] **Step 4: Commit**

```bash
cd destincode && git add desktop/src/renderer/components/FirstRunView.tsx
git commit -m "feat(first-run): use BrailleSpinner + theme tokens in StatusIcon"
```

---

## Task 4: Restyle prerequisite list as rounded pills

**Files:**
- Modify: `desktop/src/renderer/components/FirstRunView.tsx`

- [ ] **Step 1: Replace the `<ul>` block**

In `FirstRunView`, replace the current prerequisite list block (the `state && (<ul>...)` section inside the main render) with:

```tsx
{/* Prerequisite checklist — rounded pills */}
{state && (
  <ul className="w-full space-y-2">
    {state.prerequisites.map((p) => {
      const active = p.status === 'installing' || p.status === 'checking';
      return (
        <li
          key={p.name}
          className={[
            'flex items-center gap-3 rounded-full px-4 py-2.5 border transition-colors',
            active
              ? 'bg-inset border-edge'
              : 'bg-panel border-edge-dim',
          ].join(' ')}
        >
          <StatusIcon status={p.status} />
          <span className="text-sm text-fg">{p.displayName}</span>
          <span className="ml-auto text-xs text-fg-muted">
            {statusLabel(p.status, p.version)}
          </span>
        </li>
      );
    })}
  </ul>
)}
```

- [ ] **Step 2: Commit**

```bash
cd destincode && git add desktop/src/renderer/components/FirstRunView.tsx
git commit -m "feat(first-run): restyle prerequisite list as rounded pills"
```

---

## Task 5: Restyle `ProgressBar` (thinner, accent-tinted, inline %)

**Files:**
- Modify: `desktop/src/renderer/components/FirstRunView.tsx`

- [ ] **Step 1: Replace the `ProgressBar` implementation**

Replace the existing `ProgressBar` function (lines 50-59) with:

```tsx
function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="w-full flex items-center gap-3">
      <div className="flex-1 h-1.5 rounded-full bg-inset overflow-hidden">
        <div
          className="h-full rounded-full bg-accent transition-all duration-500"
          style={{ width: `${clamped}%` }}
        />
      </div>
      <span className="text-xs text-fg-muted tabular-nums w-10 text-right">
        {Math.round(clamped)}%
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Collapse the bar + % wrapper in the render**

In `FirstRunView`, find the block:

```tsx
{/* Progress bar */}
{state && (
  <div className="w-full flex flex-col items-center gap-1.5">
    <ProgressBar percent={state.overallProgress} />
    <span className="text-xs text-gray-500">{state.overallProgress}%</span>
  </div>
)}
```

Replace with:

```tsx
{/* Progress bar (percent rendered inline) */}
{state && <ProgressBar percent={state.overallProgress} />}
```

- [ ] **Step 3: Commit**

```bash
cd destincode && git add desktop/src/renderer/components/FirstRunView.tsx
git commit -m "feat(first-run): thinner accent-tinted progress bar with inline percent"
```

---

## Task 6: Add the "what's happening" explainer line

**Files:**
- Modify: `desktop/src/renderer/components/FirstRunView.tsx`

- [ ] **Step 1: Import `describeStep`**

At the top of `FirstRunView.tsx`, add:

```tsx
import { describeStep } from './first-run/describe-step';
```

- [ ] **Step 2: Replace the existing "usually takes 2-3 minutes" copy**

Find:

```tsx
<p className="text-sm text-gray-400">This usually takes 2-3 minutes</p>
```

Replace with:

```tsx
{state && (
  <p className="text-sm text-fg-dim text-center max-w-md leading-relaxed">
    {describeStep(state)}
  </p>
)}
```

- [ ] **Step 3: Remove the now-redundant `statusMessage` paragraph**

Find:

```tsx
{/* Status message */}
{state?.statusMessage && (
  <p className="text-xs text-gray-400 text-center">{state.statusMessage}</p>
)}
```

Delete this entire block — `describeStep()` supersedes it. (The raw `statusMessage` from the IPC layer is internal noise; the user-facing sentence comes from `describeStep()`.)

- [ ] **Step 4: Commit**

```bash
cd destincode && git add desktop/src/renderer/components/FirstRunView.tsx
git commit -m "feat(first-run): per-step explainer sentence above checklist"
```

---

## Task 7: Restyle `AuthScreen` (card shell + accent primary button)

**Files:**
- Modify: `desktop/src/renderer/components/FirstRunView.tsx`

- [ ] **Step 1: Replace the `AuthScreen` component body**

Replace the entire `AuthScreen` function (currently lines ~65-129) with:

```tsx
function AuthScreen({
  authMode,
  onOAuth,
  onApiKey,
}: {
  authMode: FirstRunState['authMode'];
  onOAuth: () => void;
  onApiKey: (key: string) => void;
}) {
  const [showApiKey, setShowApiKey] = useState(false);
  const [apiKey, setApiKey] = useState('');

  if (authMode === 'oauth') {
    return (
      <div className="mt-6 text-center flex items-center justify-center gap-2 text-sm text-fg-dim">
        <BrailleSpinner size="sm" />
        <span>A browser window should have opened. Complete sign-in there…</span>
      </div>
    );
  }

  return (
    <div className="mt-6 w-full max-w-md rounded-2xl bg-panel border border-edge p-6 flex flex-col items-center gap-4">
      <p className="text-sm text-fg-dim text-center leading-relaxed">
        Sign in with your Claude Pro or Max plan — no API key or credit card needed.
      </p>

      <button
        onClick={onOAuth}
        className="px-6 py-3 rounded-full bg-accent text-on-accent font-semibold text-base hover:opacity-90 transition-opacity"
      >
        Log in with Claude
      </button>

      {!showApiKey ? (
        <button
          onClick={() => setShowApiKey(true)}
          className="text-xs text-fg-muted hover:text-fg-dim underline transition-colors"
        >
          I have an API key instead
        </button>
      ) : (
        <div className="flex flex-col items-center gap-3 w-full">
          <input
            type="password"
            placeholder="sk-ant-..."
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            className="w-full px-3 py-2 rounded-md bg-well border border-edge text-fg text-sm placeholder:text-fg-faint focus:outline-none focus:border-accent"
          />
          <p className="text-xs text-fg-muted text-center leading-relaxed">
            Your key is passed directly to Claude Code and stored in its secure config.
            DestinCode never stores, logs, or backs up your key.
          </p>
          <button
            onClick={() => onApiKey(apiKey)}
            disabled={!apiKey.trim()}
            className="px-4 py-2 rounded-full bg-accent text-on-accent text-sm font-medium hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed transition-opacity"
          >
            Verify &amp; Continue
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd destincode && git add desktop/src/renderer/components/FirstRunView.tsx
git commit -m "feat(first-run): restyle auth screen as card + accent primary button"
```

---

## Task 8: Restyle `DevModeScreen` to match card shell

**Files:**
- Modify: `desktop/src/renderer/components/FirstRunView.tsx`

- [ ] **Step 1: Replace the `DevModeScreen` component body**

Replace the entire `DevModeScreen` function with:

```tsx
function DevModeScreen({ onEnable }: { onEnable: () => void }) {
  return (
    <div className="mt-6 w-full max-w-md rounded-2xl bg-panel border border-edge p-6 flex flex-col items-center gap-4 text-center">
      <p className="text-sm text-fg leading-relaxed">
        Windows Developer Mode allows DestinCode to create symbolic links, which
        the toolkit uses for configuration files. This is a one-time system setting.
      </p>
      <button
        onClick={onEnable}
        className="px-5 py-2.5 rounded-full bg-accent text-on-accent font-medium hover:opacity-90 transition-opacity"
      >
        Enable Developer Mode
      </button>
      <p className="text-xs text-fg-muted leading-relaxed">
        If the button doesn't work, open{' '}
        <span className="font-mono text-fg-dim">
          Settings &gt; Update &amp; Security &gt; For Developers
        </span>{' '}
        and enable Developer Mode manually, then click retry.
      </p>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
cd destincode && git add desktop/src/renderer/components/FirstRunView.tsx
git commit -m "feat(first-run): restyle dev-mode screen to match card shell"
```

---

## Task 9: Add `CompletionCard` with "what to try next"

**Files:**
- Modify: `desktop/src/renderer/components/FirstRunView.tsx`

- [ ] **Step 1: Add the `CompletionCard` component**

Insert this component above the `FirstRunView` default export:

```tsx
function CompletionCard() {
  return (
    <div className="w-full max-w-md rounded-2xl bg-panel border border-edge p-6 flex flex-col gap-4">
      <h2 className="text-lg font-semibold text-fg text-center">You're all set.</h2>
      <p className="text-sm text-fg-dim text-center">Here's what to try first:</p>
      <ul className="flex flex-col gap-2 text-sm text-fg-dim">
        <li className="flex gap-2">
          <span className="text-accent">•</span>
          <span><span className="text-fg">Pick a theme</span> — Settings &rarr; Appearance</span>
        </li>
        <li className="flex gap-2">
          <span className="text-accent">•</span>
          <span><span className="text-fg">Install a skill</span> — the marketplace is one click away</span>
        </li>
        <li className="flex gap-2">
          <span className="text-accent">•</span>
          <span><span className="text-fg">Sync across devices</span> — optional, but handy</span>
        </li>
      </ul>
      <div className="flex items-center justify-center gap-2 text-xs text-fg-muted pt-1">
        <BrailleSpinner size="sm" />
        <span>Opening DestinCode…</span>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Replace the existing `launching` branch**

Find the block in `FirstRunView`'s render:

```tsx
{launching ? (
  <p className="text-sm text-gray-400 animate-pulse">Starting your setup...</p>
) : (
  <div className="flex flex-col items-center gap-5 w-full max-w-md px-4">
```

Change the `launching` branch to render the card instead:

```tsx
{launching ? (
  <CompletionCard />
) : (
  <div className="flex flex-col items-center gap-5 w-full max-w-md px-4">
```

- [ ] **Step 3: Commit**

```bash
cd destincode && git add desktop/src/renderer/components/FirstRunView.tsx
git commit -m "feat(first-run): add 'what to try next' completion card"
```

---

## Task 10: Restyle root container, error state, and skip link

**Files:**
- Modify: `desktop/src/renderer/components/FirstRunView.tsx`

- [ ] **Step 1: Swap the root container background + title**

Find:

```tsx
<div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-950 text-gray-100">
  <h1 className="text-4xl font-bold mb-6">DestinCode</h1>
```

Replace with:

```tsx
<div className="absolute inset-0 flex flex-col items-center justify-center bg-canvas text-fg">
  <h1 className="text-4xl font-semibold tracking-tight mb-6 text-fg">DestinCode</h1>
```

- [ ] **Step 2: Restyle the error block**

Find:

```tsx
{state?.lastError && (
  <div className="flex flex-col items-center gap-2 mt-2">
    <p className="text-xs text-red-400 text-center">{state.lastError}</p>
    <button
      onClick={handleRetry}
      className="px-3 py-1.5 rounded-md bg-gray-800 hover:bg-gray-700 text-gray-200 text-xs font-medium transition-colors"
    >
      Try Again
    </button>
  </div>
)}
```

Replace with:

```tsx
{state?.lastError && (
  <div className="flex flex-col items-center gap-2 mt-2">
    {/* Status colors stay theme-independent per CLAUDE.md. */}
    <p className="text-xs text-red-500 text-center max-w-md">
      {state.lastError}
    </p>
    <button
      onClick={handleRetry}
      className="px-3 py-1.5 rounded-full bg-well border border-edge hover:bg-inset text-fg text-xs font-medium transition-colors"
    >
      Try Again
    </button>
  </div>
)}
```

- [ ] **Step 3: Restyle the skip button**

Find:

```tsx
<button
  onClick={handleSkip}
  className="mt-10 text-xs text-gray-700 hover:text-gray-500 transition-colors"
>
  Skip setup (I installed via terminal)
</button>
```

Replace with:

```tsx
<button
  onClick={handleSkip}
  className="mt-10 text-xs text-fg-faint hover:text-fg-muted transition-colors"
>
  Skip setup (I installed via terminal)
</button>
```

- [ ] **Step 4: Run the typecheck + tests**

Run: `cd destincode/desktop && npm test`
Expected: all tests pass, including the new `describe-step.test.ts` (10 tests).

Run: `cd destincode/desktop && npm run build`
Expected: build succeeds with no TypeScript errors.

- [ ] **Step 5: Commit**

```bash
cd destincode && git add desktop/src/renderer/components/FirstRunView.tsx
git commit -m "feat(first-run): retheme root container, error block, and skip link"
```

---

## Task 11: Manual verification on a clean first-run state

**Files:** none (verification only)

- [ ] **Step 1: Force the app into first-run mode**

The app detects first-run by checking for a completion flag in `~/.claude/`. To re-trigger the view on a dev machine that's already set up:

```bash
# Back up current state first
mv ~/.claude/destincode-first-run.json ~/.claude/destincode-first-run.json.bak 2>/dev/null || true
```

(If the flag file doesn't exist on your machine, the first-run view may already be accessible via a dev harness — check `desktop/src/main/first-run.ts` for the exact flag path and update this step with the correct filename.)

- [ ] **Step 2: Launch the dev app**

Run: `bash scripts/run-dev.sh` from workspace root.

- [ ] **Step 3: Visually verify**

Check each:
- Background is cream (`#F0E6D6`), text is dark brown
- "DestinCode" wordmark renders centered in dark brown
- Explainer sentence updates as each prereq progresses
- Each prereq row is a rounded pill with a thin border; active row has a slightly darker tan fill (`bg-inset`)
- Active row's indicator is the rotating Braille glyph (`⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏`)
- Completed rows show a brown checkmark
- Progress bar is a thin cream track with a dark brown fill, percent to its right
- Auth screen renders as a card with a pill-shaped "Log in with Claude" button in dark brown
- Completion card lists three next steps and shows "Opening DestinCode…" with a spinner before the main app loads

- [ ] **Step 4: Restore original first-run state**

```bash
mv ~/.claude/destincode-first-run.json.bak ~/.claude/destincode-first-run.json 2>/dev/null || true
```

- [ ] **Step 5: Commit verification notes if anything needs follow-up**

If any visual item didn't render as expected, capture a screenshot and file a note in `desktop/docs/knowledge-debt.md` rather than trying to fix it in this PR.

---

## Done-ness criteria

- `npx vitest run tests/describe-step.test.ts` — 10 tests pass
- `npm run build` in `destincode/desktop` — succeeds with no TS errors
- `FirstRunView.tsx` contains zero `bg-gray-*`, `text-gray-*`, `bg-blue-*`, `bg-orange-*`, `text-red-400`, `animate-spin` usages (verify with grep)
- Manual first-run walkthrough matches the visual checklist in Task 11
