import { useState, type ReactNode } from 'react';

// Local to the dashboard ON PURPOSE. The app has no shared disclosure: existing
// code uses a native <details> in SyncPanel and BugReportPopup, and a bespoke
// CollapsibleBlock in ToolBody. Promoting one to components/ui/ is a decision for
// more than one call site, so this stays here until there is a second.
export function Disclosure({ summary, children }: { summary: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="min-w-0">
      <button
        type="button"
        className="text-3xs text-fg-muted underline decoration-dotted underline-offset-2 hover:text-fg-2"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? 'Hide details' : summary}
      </button>
      {open && (
        <pre className="mt-2 max-h-72 overflow-auto rounded-sm border border-edge-dim bg-well p-2 text-3xs leading-relaxed text-fg-2">
          {children}
        </pre>
      )}
    </div>
  );
}
