// Docked footer strip that lists in-flight skill/theme installs. Visible iff
// installingIds.size > 0. Uses theme tokens (.layer-surface + accent accent)
// so no hardcoded colors. Respects safe-area-inset-bottom for Android.
import React from 'react';
import { useMarketplace } from '../../state/marketplace-context';

function labelForKey(
  key: string,
  skillEntries: { id: string; displayName?: string }[],
  themeEntries: { slug: string; name?: string }[],
): string {
  if (key.startsWith('skill:')) {
    const id = key.slice('skill:'.length);
    return skillEntries.find(s => s.id === id)?.displayName ?? id;
  }
  if (key.startsWith('theme:')) {
    const slug = key.slice('theme:'.length);
    return themeEntries.find(t => t.slug === slug)?.name ?? slug;
  }
  return key;
}

export default function InstallingFooterStrip() {
  const mp = useMarketplace();
  const keys = Array.from(mp.installingIds);
  const errorKeys = Array.from(mp.installError.keys()).filter(k => !mp.installingIds.has(k));
  if (keys.length === 0 && errorKeys.length === 0) return null;

  const inflightLabels = keys.map(k => labelForKey(k, mp.skillEntries, mp.themeEntries));

  return (
    <div
      className="layer-surface fixed left-0 right-0 bottom-0 border-t border-edge-dim px-4 py-2 flex flex-col gap-1 text-sm"
      style={{ zIndex: 60, paddingBottom: 'max(env(safe-area-inset-bottom), 0.5rem)' }}
      role="status"
      aria-live="polite"
    >
      {keys.length > 0 && (
        <div className="flex items-center gap-2 text-fg-2">
          <span className="inline-block w-3 h-3 border-2 border-accent border-t-transparent rounded-full animate-spin" />
          <span>
            Installing {keys.length > 1 ? `${keys.length}: ` : ''}
            {inflightLabels.join(', ')}
          </span>
        </div>
      )}
      {errorKeys.map(k => {
        const err = mp.installError.get(k)!;
        const label = labelForKey(k, mp.skillEntries, mp.themeEntries);
        return (
          <div key={k} className="text-xs text-red-500 border border-red-500/40 bg-red-500/10 rounded px-2 py-1">
            Failed to install {label}: {err.message}
          </div>
        );
      })}
    </div>
  );
}
