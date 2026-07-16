import React, { useEffect, useRef, useState } from 'react';
import { sanitizeRigSvg } from './sanitize-rig-svg';
import { DEFAULT_BUDDY_RIG } from './default-buddy-rig';
import {
  POSES, LIMB_IDS, parsePivot, defaultPivot, stepSpring, isSettled, dragTargets,
  type PoseName, type FaceName, type SpringState, type RigPartId,
} from './mascot-poses';

export interface RigMotion { vx: number; vy: number; dragging: boolean; }

interface MascotRigProps {
  /** theme-asset:// URL of the theme's rig, or null → first-party default rig. */
  svgUrl: string | null;
  pose: PoseName;
  /** Mutable drag-velocity ref written by the drag handler (BuddyMascot).
   *  A ref, not state — pointermove-rate re-renders would defeat the point.
   *  Velocity must arrive normalized to the 80px window scale (k = 80/size × 2.4). */
  motionRef: React.MutableRefObject<RigMotion>;
  /** Disables blink + limb springs (reduced-effects mode). Pose changes remain. */
  reducedEffects: boolean;
}

interface Parts {
  byId: Map<RigPartId, SVGGElement>;
  // The six expression groups + blink, indexed by face name; absent groups
  // simply don't swap (graceful degradation per spec §3.2).
  faces: Partial<Record<FaceName | 'blink', SVGGElement>>;
}

// Parts the drag springs act on: the four limbs plus the tail, which trails
// off the left-leg target (Kuromi's tail wags when carried).
const SPRING_IDS = [...LIMB_IDS, 'rig-tail'] as const;
type SpringId = (typeof SPRING_IDS)[number];

/**
 * Renders a rigged mascot SVG and animates it (spec §3).
 * - Fetches + sanitizes the theme rig (or uses the bundled default).
 * - Applies poses as transforms on named part groups (CSS-transitioned; the
 *   unified pose/sway spring loop + motion styles land with the buddy
 *   integration — see the workbench prototype in youcoded-dev
 *   docs/active/prototypes/2026-07-16-buddy-rig-workbench.html).
 * - Runs per-limb rotation springs during drag for the trailing-limbs feel.
 * - Blinks by swapping the face group every 6–12s (per-motion-style cadence
 *   arrives with the integration pass).
 */
export function MascotRig({ svgUrl, pose, motionRef, reducedEffects }: MascotRigProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  const partsRef = useRef<Parts | null>(null);
  const springsRef = useRef<Map<SpringId, SpringState>>(new Map());
  const poseRef = useRef<PoseName>(pose);
  poseRef.current = pose;
  const [blinking, setBlinking] = useState(false);

  // ── Load + sanitize ──
  useEffect(() => {
    let alive = true;
    if (!svgUrl) {
      setSvgHtml(sanitizeRigSvg(DEFAULT_BUDDY_RIG));
      return;
    }
    // theme-asset:// is registered with supportFetchAPI:true (main.ts), so
    // fetch works. Sanitization is the security boundary — see sanitize-rig-svg.
    fetch(svgUrl)
      .then((r) => r.text())
      .then((text) => { if (alive) setSvgHtml(sanitizeRigSvg(text) ?? sanitizeRigSvg(DEFAULT_BUDDY_RIG)); })
      .catch(() => { if (alive) setSvgHtml(sanitizeRigSvg(DEFAULT_BUDDY_RIG)); });
    return () => { alive = false; };
  }, [svgUrl]);

  // ── Index parts + set pivots after the SVG lands in the DOM ──
  useEffect(() => {
    if (!svgHtml || !hostRef.current) { partsRef.current = null; return; }
    const svg = hostRef.current.querySelector('svg');
    if (!svg) { partsRef.current = null; return; }
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', '100%');
    const byId = new Map<RigPartId, SVGGElement>();
    const allIds: RigPartId[] = [...LIMB_IDS, 'rig-tail', 'rig-body'];
    for (const id of allIds) {
      const el = svg.querySelector<SVGGElement>(`#${id}`);
      if (!el) continue;
      byId.set(id, el);
      if (id === 'rig-body') continue;
      const pivot = parsePivot(el.getAttribute('data-pivot'))
        ?? (() => { try { return defaultPivot(id, el.getBBox()); } catch { return null; } })();
      if (pivot) {
        // transform-box:view-box makes transform-origin viewBox-relative,
        // matching the data-pivot coordinate space.
        (el.style as unknown as Record<string, string>).transformBox = 'view-box';
        el.style.transformOrigin = `${pivot.x}px ${pivot.y}px`;
      }
    }
    const faces: Parts['faces'] = {};
    for (const name of ['idle', 'welcome', 'curious', 'shocked', 'dizzy', 'blink'] as const) {
      const el = svg.querySelector<SVGGElement>(`#rig-face-${name}`);
      if (el) faces[name] = el;
    }
    partsRef.current = { byId, faces };
    springsRef.current = new Map();
    applyPose(partsRef.current, poseRef.current, blinking, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svgHtml]);

  // ── Pose + face application ──
  useEffect(() => {
    if (partsRef.current) applyPose(partsRef.current, pose, blinking, false);
  }, [pose, blinking]);

  // ── Blink loop ──
  useEffect(() => {
    if (reducedEffects) return;
    let closeTimer: NodeJS.Timeout | null = null;
    let openTimer: NodeJS.Timeout | null = null;
    let stopped = false;
    const schedule = () => {
      if (stopped) return;
      closeTimer = setTimeout(() => {
        // Skip blinks mid-drag and while shocked — eyes-wide states.
        if (!motionRef.current.dragging && poseRef.current !== 'shocked' && partsRef.current?.faces.blink) {
          setBlinking(true);
          openTimer = setTimeout(() => { setBlinking(false); schedule(); }, 120);
        } else {
          schedule();
        }
      }, 6000 + Math.random() * 6000);
    };
    schedule();
    return () => {
      stopped = true;
      if (closeTimer) clearTimeout(closeTimer);
      if (openTimer) clearTimeout(openTimer);
      setBlinking(false);
    };
  }, [reducedEffects, motionRef]);

  // ── Limb springs (drag trailing) ──
  useEffect(() => {
    if (reducedEffects) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = now - last;
      last = now;
      const parts = partsRef.current;
      if (!parts) return;
      const m = motionRef.current;
      const limbTargets = m.dragging ? dragTargets(m.vx, m.vy) : ZERO_TARGETS;
      // The tail trails off the left-leg lean, softened — a wag, not a flail.
      const targetFor = (id: SpringId) =>
        id === 'rig-tail' ? limbTargets['rig-leg-left'] * 0.8 : limbTargets[id];
      let anyActive = m.dragging;
      for (const id of SPRING_IDS) {
        const el = parts.byId.get(id);
        if (!el) continue;
        let s = springsRef.current.get(id) ?? { value: 0, velocity: 0 };
        if (!m.dragging && isSettled(s, 0) && s.value === 0) continue;
        s = stepSpring(s, targetFor(id), dt);
        if (!m.dragging && isSettled(s, 0)) s = { value: 0, velocity: 0 };
        else anyActive = true;
        springsRef.current.set(id, s);
        const base = POSES[poseRef.current].parts[id]?.rotate ?? 0;
        // Direct per-frame write — disable the pose transition while springing.
        el.style.transition = 'none';
        el.style.transform = `rotate(${base + s.value}deg)`;
      }
      if (!anyActive) {
        // Springs settled — restore transition-driven pose transforms.
        for (const id of SPRING_IDS) {
          const el = parts.byId.get(id);
          if (el) el.style.transition = '';
        }
        applyPose(parts, poseRef.current, blinking, false);
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reducedEffects]);

  return (
    <div
      ref={hostRef}
      style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
      // Sanitized upstream — sanitizeRigSvg is the security boundary.
      dangerouslySetInnerHTML={svgHtml ? { __html: svgHtml } : undefined}
    />
  );
}

const ZERO_TARGETS: Record<(typeof LIMB_IDS)[number], number> = {
  'rig-arm-left': 0, 'rig-arm-right': 0, 'rig-leg-left': 0, 'rig-leg-right': 0,
};

function applyPose(parts: Parts, pose: PoseName, blinking: boolean, instant: boolean): void {
  const def = POSES[pose];
  for (const [id, el] of parts.byId) {
    if (id === 'rig-body') continue;
    const p = def.parts[id] ?? {};
    el.style.transition = instant ? 'none' : 'transform 180ms ease-out';
    el.style.transform = `translate(${p.tx ?? 0}px, ${p.ty ?? 0}px) rotate(${p.rotate ?? 0}deg)`;
  }
  // Blink overlays whichever face is showing (except eyes-wide shocked).
  const want: FaceName | 'blink' =
    blinking && parts.faces.blink && def.face !== 'shocked' ? 'blink' : def.face;
  for (const [name, el] of Object.entries(parts.faces)) {
    (el as SVGGElement).style.display = name === want ? '' : 'none';
  }
}
