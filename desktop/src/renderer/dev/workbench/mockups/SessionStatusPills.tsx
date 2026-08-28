// src/renderer/dev/workbench/mockups/SessionStatusPills.tsx
//
// The five states the All Sessions menu's status pill can show, with what each
// one means, so the WORDS can be judged without waiting for a session to reach
// each state. Renders the SHIPPING pill (StatusPill, exported from
// SessionStrip) — this page cannot drift from the menu.
//
// Destin named four of the five in the P-8 review (2026-08-28): Working,
// Inactive, Response Ready, Needs Input. Amber has no name in that list, so it
// carries the plainest reading of the colour it already had.
//
// Reached at ?mode=workbench&child=1&view=session-pills (routing in index.tsx).
// Dev-only, like the rest of dev/.

import React from 'react';
import { StatusPill } from '../../../components/SessionStrip';
import type { SessionStatusColor } from '../../../components/StatusDot';

const STATES: { color: SessionStatusColor; when: string }[] = [
  { color: 'green', when: 'The assistant is thinking, or a tool is running.' },
  { color: 'red', when: 'It is asking permission, or the turn ended in a way you have to answer.' },
  { color: 'amber', when: 'The turn may have stalled — the app is not sure it is still moving.' },
  { color: 'blue', when: 'It finished while you were somewhere else and you have not read it yet.' },
  { color: 'gray', when: 'Nothing is happening in this session.' },
];

// ?pills=four folds the amber state into the red one's word, so the menu only
// ever says the four things Destin named. ?pills=five (the default) gives amber
// its own word. The A/B the review deck asks about.
function labelFor(color: SessionStatusColor, four: boolean): string | undefined {
  return four && color === 'amber' ? 'Needs Input' : undefined;
}

export function SessionStatusPillsMockup() {
  const four = new URLSearchParams(window.location.search).get('pills') === 'four';
  return (
    <div className="min-h-screen bg-canvas text-fg p-8">
      <h1 className="text-sm font-semibold mb-1">Session status pill{four ? ' — four words' : ' — five words'}</h1>
      <p className="text-2xs text-fg-dim mb-6">
        Shown at the right of every row in the All Sessions menu, in place of the bare dot.
      </p>
      <div className="flex flex-col gap-3 max-w-xl">
        {STATES.map(({ color, when }) => (
          <div key={color} className="flex items-start gap-3" data-status={color}>
            <span className="w-32 shrink-0 flex justify-end pt-[1px]">
              <StatusPill color={color} isActive label={labelFor(color, four)} />
            </span>
            <span className="text-2xs text-fg-dim">{when}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
