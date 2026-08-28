// Inline 16px icons for the marketplace's type switch and trust badges,
// sized and stroked like the SegmentedTabs icons (16px, 2px stroke) so a
// seven-segment pill reads as one control. Kept together so the vocabulary
// (Plugins · Skills · Specialists · Tools · Prompts · Themes) has one home.
import React from 'react';
import type { CatalogItemType, CapabilityKind, OriginTier } from '../../../shared/catalog-types';
import { PluginIcon, PaletteIcon } from '../ui';

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export function SkillIcon({ size = 16 }: { size?: number }) {
  // Open book — a skill is instructions the assistant reads.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z" />
      <path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z" />
    </svg>
  );
}

export function SpecialistIcon({ size = 16 }: { size?: number }) {
  // Person with a small badge — a named helper with its own instructions.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <circle cx="10" cy="8" r="4" />
      <path d="M3 21a7 7 0 0 1 14 0" />
      <path d="M17 3l1.2 2.4L21 6l-2 1.9.5 2.6L17 9.2l-2.5 1.3.5-2.6L13 6l2.8-.6z" />
    </svg>
  );
}

export function ToolIcon({ size = 16 }: { size?: number }) {
  // Plug — a tool connects the assistant to something outside.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <path d="M9 2v6M15 2v6" />
      <path d="M5 8h14v3a7 7 0 0 1-14 0z" />
      <path d="M12 18v4" />
    </svg>
  );
}

export function PromptIcon({ size = 16 }: { size?: number }) {
  // Text lines with a quote mark — instructions you paste in.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
      <path d="M4 6h16M4 12h10M4 18h13" />
    </svg>
  );
}

export function typeIcon(type: CatalogItemType | 'theme'): React.ReactNode {
  switch (type) {
    case 'plugin': return <PluginIcon />;
    case 'skill': return <SkillIcon />;
    case 'specialist': return <SpecialistIcon />;
    case 'tool': return <ToolIcon />;
    case 'prompt': return <PromptIcon />;
    case 'theme': return <PaletteIcon />;
  }
}

// ── Origin ──────────────────────────────────────────────────────────────────

export function OriginIcon({ tier, size = 12 }: { tier: OriginTier; size?: number }) {
  const s = { ...stroke, strokeWidth: 2.2 };
  if (tier === 'youcoded') {
    return <PluginIcon />;
  }
  if (tier === 'verified') {
    // Shield with a check — the publisher proved they own the name.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" {...s}>
        <path d="M12 2l8 3v6c0 5-3.5 9.5-8 11-4.5-1.5-8-6-8-11V5z" />
        <path d="M8.5 12l2.5 2.5 4.5-5" />
      </svg>
    );
  }
  // Community — two people.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...s}>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-5-6.3" />
    </svg>
  );
}

// ── Capabilities ─────────────────────────────────────────────────────────────

export function CapabilityIcon({ kind, size = 14 }: { kind: CapabilityKind; size?: number }) {
  switch (kind) {
    case 'shell':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
          <path d="M4 17l6-5-6-5" />
          <path d="M12 19h8" />
        </svg>
      );
    case 'network':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
          <circle cx="12" cy="12" r="9" />
          <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
        </svg>
      );
    case 'secret':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
          <circle cx="8" cy="14" r="4" />
          <path d="M11 11l9-9M16 6l3 3M13 9l3 3" />
        </svg>
      );
    case 'files':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
          <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
      );
    case 'auto':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
          <path d="M13 2L4 14h7l-1 8 9-12h-7z" />
        </svg>
      );
    case 'adds':
      return (
        <svg width={size} height={size} viewBox="0 0 24 24" {...stroke}>
          <rect x="4" y="4" width="16" height="16" rx="3" />
          <path d="M12 8v8M8 12h8" />
        </svg>
      );
  }
}
