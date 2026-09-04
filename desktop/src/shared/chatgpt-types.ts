// Sign in with ChatGPT — the account state the renderer shows and the channels
// it calls. Shared between main and renderer; keep free of Node/Electron imports.
//
// Design: docs/active/design/2026-09-04-chatgpt-signin/ (workspace repo) and
// docs/active/investigations/2026-09-04-chatgpt-subscription-paths.md.
//
// WHY a state machine rather than a boolean: the sign-in is a browser round-trip
// the app does not control, so "waiting" is a real, visible state the user sits
// in for a while — the Settings row and the first-run screen both draw it.

/** One rolling usage window of the ChatGPT plan, as OpenAI reports it. Same
 *  shape as the Claude subscription windows (`SubscriptionUsage` in
 *  usage-snapshot.ts) on purpose, so the /usage card and the status-bar chips
 *  draw either plan with one recipe. */
export interface ChatGptUsageWindow { utilization: number; resets_at: string }

export interface ChatGptUsage {
  five_hour?: ChatGptUsageWindow;
  seven_day?: ChatGptUsageWindow;
}

export type ChatGptAccountStatus =
  | { state: 'signed-out' }
  /** The browser tab is open; we are waiting for OpenAI's callback. */
  | { state: 'waiting' }
  | {
      state: 'signed-in';
      email: string;
      /** OpenAI's plan name as reported at sign-in ('plus', 'pro', 'team', 'free', …).
       *  Free-form on purpose — OpenAI renames plans; the UI title-cases it. */
      plan: string;
      usage?: ChatGptUsage | null;
    }
  /** Signed in, but requests are refused — the specific reason OpenAI gave
   *  (a workspace admin disabled it, the plan has no Codex access, …). Per
   *  docs/error-message-standards.md the text is OpenAI's own, never a guess. */
  | { state: 'blocked'; email: string; reason: string };

/** The one sentence the provider layer emits when a plan window is exhausted.
 *  OpenAI answers with a specific `usage_limit_reached` code and a reset time,
 *  so this is specific-and-accurate per docs/error-message-standards.md — and
 *  the renderer's plan-limit card keys on it (isChatGptLimitMessage), the same
 *  way the provider-config bubble keys on "Settings → Providers". */
export function chatGptLimitMessage(windowLabel: '5-hour' | 'weekly', resetsAt: string): string {
  const t = Date.parse(resetsAt);
  const when = Number.isFinite(t)
    ? new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : 'later';
  return `Your ChatGPT plan's ${windowLabel} limit is used up. It resets at ${when}.`;
}

export function isChatGptLimitMessage(message: string | null | undefined): boolean {
  return !!message && /ChatGPT plan's .* limit is used up/.test(message);
}

/** Human plan label: 'plus' → 'ChatGPT Plus'. Unknown strings pass through
 *  title-cased so a renamed plan still reads as a name, not as a code. */
export function chatGptPlanLabel(plan: string): string {
  const p = plan.trim();
  if (!p) return 'ChatGPT';
  return `ChatGPT ${p.charAt(0).toUpperCase()}${p.slice(1)}`;
}
