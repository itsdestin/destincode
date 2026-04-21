import React from 'react';

export default function InstallingPill({ label = 'Installing…' }: { label?: string }) {
  return (
    <span
      className="text-[10px] px-2 py-0.5 rounded-full border border-accent/50 text-accent bg-accent/10 animate-pulse"
      role="status"
      aria-live="polite"
    >
      {label}
    </span>
  );
}
