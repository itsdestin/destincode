import React, { useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Info tooltip for the "Skip Permissions" toggle. Rendered to document.body via
// portal so it escapes the popup's overflow container. Hover/focus shows a
// plain-language explanation of Claude Code's native permission system and the
// tradeoffs of turning prompts off for a whole session.
export function SkipPermissionsInfoTooltip() {
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const ref = useRef<HTMLSpanElement>(null);

  const show = () => {
    if (ref.current) {
      const rect = ref.current.getBoundingClientRect();
      setPos({ x: rect.left + rect.width / 2, y: rect.top });
    }
    setVisible(true);
  };

  return (
    <span
      ref={ref}
      className="inline-flex items-center ml-1 cursor-default"
      onMouseEnter={show}
      onMouseLeave={() => setVisible(false)}
      onFocus={show}
      onBlur={() => setVisible(false)}
      onClick={(e) => e.stopPropagation()}
      tabIndex={0}
      aria-label="About skip permissions"
    >
      <svg
        className="w-3 h-3 opacity-40 hover:opacity-75 transition-opacity shrink-0"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
        aria-hidden
      >
        <circle cx="12" cy="12" r="9" />
        <path strokeLinecap="round" strokeLinejoin="round" d="M12 11v5" />
        <circle cx="12" cy="8" r="0.5" fill="currentColor" />
      </svg>

      {visible && createPortal(
        <div
          style={{ left: pos.x, top: pos.y - 10, transform: 'translate(-50%, -100%)' }}
          className="fixed z-[9999] w-80 pointer-events-none"
        >
          <div className="bg-panel border border-edge rounded-lg shadow-lg p-3 text-left">
            <p className="text-xs font-semibold text-fg mb-1.5">Normally, Claude asks first</p>
            <p className="text-[11px] text-fg-2 leading-snug mb-2">
              Before Claude does anything that could change your computer — like editing a file, running a command, or going online — a little box pops up asking you to approve it. Reading files in your project is safe and doesn't need approval.
            </p>

            <p className="text-xs font-semibold text-fg mt-2.5 mb-1.5">What this toggle does</p>
            <p className="text-[11px] text-fg-2 leading-snug mb-2">
              Flipping it on tells Claude to stop asking. It will edit files, run commands, and use the internet on its own, without checking with you first.
            </p>

            <p className="text-xs font-semibold text-fg mt-2.5 mb-1.5">A few things stay protected</p>
            <p className="text-[11px] text-fg-2 leading-snug mb-2">
              Even with the toggle on, Claude will still stop and ask before doing the really risky stuff — things that could scramble your project's save history, change how your computer's terminal starts up, or rewrite Claude's own settings. You'll still see a prompt for those.
            </p>
            <p className="text-[11px] text-fg-2 leading-snug mb-2">
              If you want to turn those extra protections off too, you can do it under <span className="text-fg">Settings → Defaults → Skip Permissions → Advanced</span>. They're left on by default because they're the last line of defense against a serious mistake.
            </p>

            <p className="text-xs font-semibold text-[#DD4444] mt-2.5 mb-1.5">What could go wrong</p>
            <div className="space-y-1">
              <div className="flex items-start gap-1.5 text-[11px] text-fg-2 leading-snug">
                <span className="shrink-0 mt-px">·</span>
                <span>Claude can make mistakes, just like anyone. Normally the approval box gives you a chance to catch one. Without it, a wrong command could delete or overwrite your work before you see it happen.</span>
              </div>
              <div className="flex items-start gap-1.5 text-[11px] text-fg-2 leading-snug">
                <span className="shrink-0 mt-px">·</span>
                <span>Claude reads a lot of outside stuff — websites, documents, the output of commands. Sometimes that content contains sneaky instructions trying to trick Claude into doing something you didn't ask for. The approval box is what normally stops that.</span>
              </div>
              <div className="flex items-start gap-1.5 text-[11px] text-fg-2 leading-snug">
                <span className="shrink-0 mt-px">·</span>
                <span>Safest to use this only in a test folder or a project you wouldn't mind redoing — somewhere a mistake can't hurt anything important.</span>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </span>
  );
}
