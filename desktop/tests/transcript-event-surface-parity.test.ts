// App.tsx and BubbleFeed.tsx each own a transcript-event switch that feeds the
// SAME chatReducer — the buddy window is a separate BrowserWindow, so it cannot
// share the main window's ChatProvider and must subscribe independently.
//
// Nothing kept the two switches in step. PR #287 added `replay-complete` to
// App.tsx only, so the buddy feed kept rendering the spinning orphaned tool card
// that PR exists to reap (found reviewing #287, 2026-08-10).
//
// This test measures the divergence instead of assuming it. KNOWN_GAPS is an
// explicit ledger, not a waiver: each entry is a type App.tsx handles and the
// buddy deliberately (or not yet) does not. Shrinking it is good; growing it
// requires a WHY here.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RENDERER = join(__dirname, '..', 'src', 'renderer');

// Hand-maintained because TranscriptEventType is a TYPE — it has no runtime
// value to enumerate. Keep in sync with shared/types.ts TranscriptEventType.
const TRANSCRIPT_TYPES = [
  'user-message', 'user-interrupt', 'assistant-text', 'tool-use', 'tool-result',
  'replay-complete', 'turn-complete', 'assistant-thinking', 'session-error',
  'skill-invoked', 'context-clear', 'compact-summary',
] as const;

/** Case labels in a file that name a transcript event type. Intersecting with
 *  TRANSCRIPT_TYPES scopes this to transcript switches and ignores the
 *  timeline-render switch ('user', 'assistant-turn', 'prompt', ...). */
function handledTypes(file: string): Set<string> {
  const text = readFileSync(join(RENDERER, file), 'utf8');
  const found = new Set<string>();
  for (const t of TRANSCRIPT_TYPES) {
    if (text.includes(`case '${t}':`)) found.add(t);
  }
  return found;
}

// Types App.tsx handles that the buddy feed does not. Each needs a reason.
const KNOWN_GAPS: Record<string, string> = {
  // Buddy has no InputBar, so there is no ESC to interrupt from — but the MAIN
  // window's ESC still ends the turn, and the buddy would not see it. Unverified
  // whether this is a real bug; out of scope for this plan.
  'user-interrupt': 'not investigated — see PR #287 review, 2026-08-10',
  // Buddy renders no skill card today.
  'skill-invoked': 'not investigated — see PR #287 review, 2026-08-10',
  // Buddy timeline would not clear on /clear.
  'context-clear': 'not investigated — see PR #287 review, 2026-08-10',
};

describe('transcript event surface parity: App.tsx vs BubbleFeed.tsx', () => {
  it('buddy handles every transcript type App does, minus the known gaps', () => {
    const app = handledTypes('App.tsx');
    const buddy = handledTypes('components/buddy/BubbleFeed.tsx');

    const missing = [...app].filter((t) => !buddy.has(t) && !(t in KNOWN_GAPS));
    expect(missing).toEqual([]);
  });

  it('buddy reaps orphaned tool cards at end of replay', () => {
    // The specific regression. Called out separately from the parity check so a
    // failure names the bug rather than a diff of two sets.
    expect(handledTypes('components/buddy/BubbleFeed.tsx')).toContain('replay-complete');
  });

  it('KNOWN_GAPS only lists types App.tsx actually handles', () => {
    // Guards the ledger itself: a stale entry would silently excuse a type that
    // no longer exists, hiding a future divergence.
    const app = handledTypes('App.tsx');
    for (const t of Object.keys(KNOWN_GAPS)) expect(app).toContain(t);
  });
});
