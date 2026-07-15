import React from 'react';

interface SettingsRowProps {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  // Overrides the default text-fg-muted subtitle color — e.g. Android's
  // "Connect to Desktop" row turns its subtitle green while connected.
  subtitleClassName?: string;
  onClick: () => void;
  // Extra content between the subtitle and the chevron — e.g. Backup & Sync's
  // status badge.
  rightAccessory?: React.ReactNode;
}

// Shared settings-list row: icon + title + subtitle + chevron. Every row in
// the Settings panel used to copy-paste this markup (~12 times across
// SettingsPanel.tsx, AccountSection.tsx, SyncPanel.tsx, ModelProvidersPopup.tsx,
// PerformanceButton.tsx) — this is the single source of truth so future style
// changes are one edit instead of a dozen. Presentational only: callers own
// their own open/popup state and render the popup as a sibling.
// See docs/active/specs/2026-07-15-settings-panel-card-redesign-design.md.
export default function SettingsRow({ icon, title, subtitle, subtitleClassName, onClick, rightAccessory }: SettingsRowProps) {
  return (
    <button
      onClick={onClick}
      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg bg-inset/50 hover:bg-inset transition-colors text-left"
    >
      <div className="flex items-center justify-center shrink-0" style={{ width: 32, height: 20 }}>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <span className="text-xs text-fg font-medium">{title}</span>
        {subtitle && <p className={`text-[10px] truncate ${subtitleClassName ?? 'text-fg-muted'}`}>{subtitle}</p>}
      </div>
      {rightAccessory}
      <svg className="w-3.5 h-3.5 text-fg-muted shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
    </button>
  );
}
