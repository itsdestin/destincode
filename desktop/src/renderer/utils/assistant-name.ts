import type { SessionProvider } from '../../shared/types';

/**
 * User-facing name for the assistant, by session provider.
 *
 * Claude sessions say "Claude"; native (local/cloud model) sessions say
 * "your assistant" — the app must not call a Llama/GPT/other model "Claude".
 * Use `capitalized` for a standalone label ("Your Assistant") vs the default
 * inline/mid-sentence form ("…start a conversation with your assistant").
 *
 * NOTE: this is for generic "the assistant" references only. Product-name
 * references that are genuinely about Claude the service (e.g. "Sign in with
 * your Claude plan", "Claude Pro/Max") must stay "Claude" and should NOT use
 * this helper.
 */
export function assistantName(
  provider: SessionProvider | undefined,
  opts?: { capitalized?: boolean },
): string {
  if (provider === 'native') return opts?.capitalized ? 'Your Assistant' : 'your assistant';
  // 'shell' deliberately falls through. A shell session has no assistant at
  // all, but it also never renders chat copy — App forces it to the terminal
  // view and draws no composer — so there is no sentence for a third answer to
  // appear in. A branch here would be unreachable code pretending otherwise.
  return 'Claude';
}
