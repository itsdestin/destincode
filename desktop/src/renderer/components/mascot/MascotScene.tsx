import React, { useEffect, useState } from 'react';
import { sanitizeRigSvg } from './sanitize-rig-svg';
import type { MascotCompanion } from '../../themes/theme-types';

interface MascotSceneProps {
  /** Companions with asset already resolved to theme-asset:// URLs. */
  companions: MascotCompanion[];
  reducedEffects: boolean;
  /** The mascot itself — the scene wraps it and positions satellites around it. */
  children: React.ReactNode;
}

/**
 * Static mascot scene: renders a theme's companions (spec §5 — sun, motes,
 * sparkles, bars) around a mascot on big-canvas surfaces like the welcome
 * screen. Positions are pure CSS percentages of the mascot box, so the
 * fraction-of-mascot-size manifest geometry needs no pixel math.
 *
 * This is the STATIC tier: companions sit at their preferred offsets with a
 * CSS idle bob (JS-free). The spring-follow physics tier is buddy-floater
 * work, pending the buddy window-padding redesign (an 80×80 window clips
 * satellites). Ghost companions are skipped here — they only materialize
 * with lag distance, and nothing lags behind a still mascot.
 *
 * Companion SVGs are third-party theme content: each goes through
 * sanitize-rig-svg before inlining (inlined, not <img>, so the app-owned
 * animation classes in mascot.css can run).
 */
export function MascotScene({ companions, reducedEffects, children }: MascotSceneProps) {
  const visible = companions.filter((c) => c && !c.ghost && typeof c.asset === 'string');
  const [svgs, setSvgs] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let alive = true;
    const urls = [...new Set(visible.map((c) => c.asset))];
    Promise.all(
      urls.map((url) =>
        fetch(url)
          .then((r) => r.text())
          .then((text) => [url, sanitizeRigSvg(text)] as const)
          .catch(() => [url, null] as const),
      ),
    ).then((entries) => {
      if (!alive) return;
      const map = new Map<string, string>();
      for (const [url, svg] of entries) if (svg) map.set(url, svg);
      setSvgs(map);
    });
    return () => { alive = false; };
    // Key on the joined URL list — the array identity churns with theme state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible.map((c) => c.asset).join('|')]);

  return (
    <div
      className="mascot-scene"
      data-effects-off={reducedEffects ? '1' : '0'}
      style={{ position: 'relative', overflow: 'visible' }}
    >
      {visible.map((c, i) => {
        const svg = svgs.get(c.asset);
        if (!svg) return null;
        const h = c.height ?? c.size;
        // % of the mascot box: center at (50 + dx·100, 50 + dy·100), shifted
        // back by half the companion's own extent.
        const left = 50 + c.dx * 100 - c.size * 50;
        const top = 50 + c.dy * 100 - h * 50;
        const floats = !!c.float && !reducedEffects;
        return (
          <div
            key={`${c.asset}-${i}`}
            className="mascot-comp"
            aria-hidden="true"
            data-float={floats ? '1' : '0'}
            style={{
              position: 'absolute',
              left: `${left}%`,
              top: `${top}%`,
              width: `${c.size * 100}%`,
              height: `${h * 100}%`,
              pointerEvents: 'none',
              // Bob amplitude relative to the companion's own height; stagger
              // siblings so the scene doesn't pulse in lockstep.
              ['--bob-pct' as string]: c.float ? `${(c.float / h) * 100}%` : '0%',
              ['--bob-ms' as string]: `${c.floatMs ?? 2000}ms`,
              ['--bob-delay' as string]: `${i * 700}ms`,
            }}
            // Sanitized above — sanitize-rig-svg is the security boundary.
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        );
      })}
      {children}
    </div>
  );
}
