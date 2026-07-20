// Shared lucide-style glyphs for the Project View surfaces (stroke currentColor,
// consistent with detail-tool-icons.tsx which holds the detail-overlay action
// icons). These were previously re-declared per file — ProjectView, ProjectHero,
// ProjectSwitcher, the tabs, and the context popups each carried their own copy
// of the same paths. One module keeps the glyph language in lockstep.
import React from 'react';

interface IconProps { size?: number; strokeWidth?: number }

function base(size: number, strokeWidth: number) {
  return {
    width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
    stroke: 'currentColor', strokeWidth,
    strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const,
    'aria-hidden': true as const,
  };
}

export function SearchIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <circle cx="11" cy="11" r="8" /><path d="m21 21-4.3-4.3" />
    </svg>
  );
}

export function GitBranchIcon({ size = 13, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
      <path d="M6 9v6" />
      <path d="M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
      <path d="M18 6a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z" />
      <path d="M18 9a9 9 0 0 1-9 9" />
    </svg>
  );
}

export function InfoIcon({ size = 14, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <circle cx="12" cy="12" r="10" /><line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

export function ChatIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function DocIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6" />
    </svg>
  );
}

// Folder shape shared by the All-files segment icon (strokeWidth 2) and the
// large folder-card glyph in FilesTab (strokeWidth 1.5 at 40px).
export function FolderIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.93a2 2 0 0 1-1.66-.9l-.82-1.2A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13c0 1.1.9 2 2 2Z" />
    </svg>
  );
}

// Type glyphs for the folder-card filename list (image / spreadsheet / code;
// documents use DocIcon above). One per fileTypeGroup.
export function ImageIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="9" cy="9" r="2" />
      <path d="m21 15-3.086-3.086a2 2 0 0 0-2.828 0L6 21" />
    </svg>
  );
}

export function SheetIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M3 9h18" /><path d="M3 15h18" /><path d="M12 3v18" />
    </svg>
  );
}

export function CodeGlyphIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="m16 18 6-6-6-6" /><path d="m8 6-6 6 6 6" />
    </svg>
  );
}

export function CheckIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function PlusIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <path d="M5 12h14" /><path d="M12 5v14" />
    </svg>
  );
}

/** Gear — the project hero's action menu trigger. */
export function CogIcon({ size = 15, strokeWidth = 2 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  );
}

export function CloseIcon({ size = 14, strokeWidth = 2 }: IconProps) {
  return (
    <svg {...base(size, strokeWidth)}>
      <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
