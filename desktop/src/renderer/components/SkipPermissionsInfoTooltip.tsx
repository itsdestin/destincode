import React from 'react';
import { AnchorTip } from './ui';

// Info tooltip for the "Skip Permissions" toggle: a plain-language explanation of
// Claude Code's native permission system and the tradeoffs of turning prompts off
// for a whole session.
//
// Change 28 moved the panel onto <AnchorTip> (portaled .layer-surface at L4), so
// this file no longer hand-rolls a `fixed z-[9999]` box and Overlay.tsx stays the
// only z-index authority.
//
// It stays a NAMED COMPONENT rather than being deleted, which is where the spec's
// wording ("AnchorTip replaces … SkipPermissionsInfoTooltip") is misleading:
// InfoPopover was a generic primitive and is genuinely superseded, but this is a
// piece of COPY with two call sites (SessionStrip, ResumeBrowser). Inlining it
// would fork ~40 lines of safety guidance into two places that could drift apart.
// The wrapper is the deduplication; AnchorTip is the presentation.
//
// trigger="hover" is deliberate and matches the previous behavior — this explains
// a toggle you're hovering, not a click target. AnchorTip's hover mode keeps the
// panel pointer-events-none, so it can't swallow a click aimed at the toggle.
export function SkipPermissionsInfoTooltip() {
  return (
    <AnchorTip
      label="About skip permissions"
      trigger="hover"
      placement="top"
      widthClass="w-80"
      className="ml-1"
    >
      <p className="text-xs font-semibold text-fg mb-1.5">Normally, Claude asks first</p>
      <p>
        Before Claude does anything that could change your computer — like editing a file, running a command, or going online — a little box pops up asking you to approve it. Reading files in your project is safe and doesn't need approval.
      </p>

      <p className="text-xs font-semibold text-fg mt-2.5 mb-1.5">What this toggle does</p>
      <p>
        Flipping it on tells Claude to stop asking. It will edit files, run commands, and use the internet on its own, without checking with you first.
      </p>

      <p className="text-xs font-semibold text-fg mt-2.5 mb-1.5">A few things stay protected</p>
      <p>
        Even with the toggle on, Claude will still stop and ask before doing the really risky stuff — things that could scramble your project's save history, change how your computer's terminal starts up, or rewrite Claude's own settings. You'll still see a prompt for those.
      </p>
      <p>
        If you want to turn those extra protections off too, you can do it under <span className="text-fg">Settings → Defaults → Skip Permissions → Advanced</span>. They're left on by default because they're the last line of defense against a serious mistake.
      </p>

      {/* Was a raw text-[#DD4444] hex. Same change-17 reasoning as the
          skip-permissions warnings elsewhere: this heading is danger
          messaging, so it rides the theme's destructive token rather than
          a fixed red a community pack can't touch. */}
      <p className="text-xs font-semibold text-destructive-fg mt-2.5 mb-1.5">What could go wrong</p>
      <div className="space-y-1">
        <div className="flex items-start gap-1.5">
          <span className="shrink-0 mt-px">·</span>
          <span>Claude can make mistakes, just like anyone. Normally the approval box gives you a chance to catch one. Without it, a wrong command could delete or overwrite your work before you see it happen.</span>
        </div>
        <div className="flex items-start gap-1.5">
          <span className="shrink-0 mt-px">·</span>
          <span>Claude reads a lot of outside stuff — websites, documents, the output of commands. Sometimes that content contains sneaky instructions trying to trick Claude into doing something you didn't ask for. The approval box is what normally stops that.</span>
        </div>
        <div className="flex items-start gap-1.5">
          <span className="shrink-0 mt-px">·</span>
          <span>Safest to use this only in a test folder or a project you wouldn't mind redoing — somewhere a mistake can't hurt anything important.</span>
        </div>
      </div>
    </AnchorTip>
  );
}
