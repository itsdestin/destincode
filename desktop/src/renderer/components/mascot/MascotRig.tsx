import React, { useEffect, useRef, useState } from 'react';
import { sanitizeRigSvg } from './sanitize-rig-svg';
import { DEFAULT_BUDDY_RIG } from './default-buddy-rig';
import {
  POSES, LIMB_IDS, BLINK_CFG, IDLE_LOOP_CLASS, parsePivot, defaultPivot,
  stepSpring, isSettled, dragTargets, idleSway, waveSway,
  type PoseName, type FaceName, type SpringState, type RigPartId, type MotionStyle,
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
  /** Disables blink + springs + idle loops (reduced-effects mode). Pose changes remain. */
  reducedEffects: boolean;
  /** Motion personality (spec §5). Selection UI is an open question — default 'chill'. */
  motionStyle?: MotionStyle;
  /** 0.5–2× multiplier on idle amplitude, sway, and twitches. */
  intensity?: number;
}

interface Parts {
  root: SVGGElement | null;
  byId: Map<RigPartId, SVGGElement>;
  // The six expression groups + blink, indexed by face name; absent groups
  // simply don't swap (graceful degradation per spec §3.2).
  faces: Partial<Record<FaceName | 'blink', SVGGElement>>;
  pupils: SVGGElement[];
}

// Parts the springs act on: the four limbs plus the tail, which trails
// off the left-leg target (Kuromi's tail wags when carried).
const SPRING_IDS = [...LIMB_IDS, 'rig-tail'] as const;
type SpringId = (typeof SPRING_IDS)[number];

const ALL_LOOP_CLASSES = ['rig-breathing', 'rig-bounce-loop', 'rig-float-loop', 'rig-sleep-loop', 'rig-fast-breath', 'rig-dizzy-sway'];

/**
 * Renders a rigged mascot SVG and animates it (spec §3 + §5).
 * - Fetches + sanitizes the theme rig (or uses the bundled default).
 * - UNIFIED SPRINGS (workbench-approved model): one spring per part whose
 *   target = pose base + (drag trail while dragging, else motion-style idle
 *   sway + welcome wave). Pose changes ride the physics instead of a CSS
 *   transition, so everything composes and settles with overshoot.
 * - Motion styles: idle body loop on #rig-root (CSS keyframes in mascot.css,
 *   amplitude via --amp = intensity), per-style blink cadence, hyper
 *   spring-velocity twitches.
 * - Curious-face pupils track the cursor.
 */
export function MascotRig({
  svgUrl, pose, motionRef, reducedEffects, motionStyle = 'chill', intensity = 1,
}: MascotRigProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [svgHtml, setSvgHtml] = useState<string | null>(null);
  const partsRef = useRef<Parts | null>(null);
  const springsRef = useRef<Map<SpringId, SpringState>>(new Map());
  const poseRef = useRef<PoseName>(pose);
  poseRef.current = pose;
  const styleRef = useRef<MotionStyle>(motionStyle);
  styleRef.current = motionStyle;
  const intensityRef = useRef(intensity);
  intensityRef.current = intensity;
  const [blinking, setBlinking] = useState(false);
  // Cursor-relative pupil offset (viewBox px), written by a window listener,
  // consumed by the rAF loop only while the curious face is showing.
  const pupilRef = useRef({ x: 0, y: 0 });

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
    const root = svg.querySelector<SVGGElement>('#rig-root');
    // The idle body loops rotate/scale in viewBox coordinates.
    if (root) (root.style as unknown as Record<string, string>).transformBox = 'view-box';
    partsRef.current = {
      root,
      byId,
      faces,
      pupils: Array.from(svg.querySelectorAll<SVGGElement>('.pupil')),
    };
    springsRef.current = new Map();
    applyPose(partsRef.current, poseRef.current, blinking, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [svgHtml]);

  // ── Face swap on pose/blink change (limb transforms are spring-owned) ──
  useEffect(() => {
    const parts = partsRef.current;
    if (!parts) return;
    applyFace(parts, pose, blinking);
    // Reduced effects: springs don't run — write pose transforms directly.
    if (reducedEffects) applyPose(parts, pose, blinking, true);
  }, [pose, blinking, reducedEffects, svgHtml]);

  // ── Idle body loop class on rig-root (motion style + intensity) ──
  useEffect(() => {
    const root = partsRef.current?.root;
    const host = hostRef.current;
    if (!root || !host) return;
    root.classList.remove(...ALL_LOOP_CLASSES);
    // --amp feeds the loop keyframes' amplitude (mascot.css).
    host.style.setProperty('--amp', String(intensity));
    if (reducedEffects) return;
    if (pose === 'dizzy') { root.classList.add('rig-dizzy-sway'); return; }
    if (pose.startsWith('peek')) return; // peeking bodies hold still — the grip carries the read
    root.classList.add(IDLE_LOOP_CLASS[motionStyle]);
    if (motionStyle === 'hyper') root.classList.add('rig-fast-breath');
  }, [motionStyle, intensity, reducedEffects, pose, svgHtml]);

  // ── Blink loop (per-style cadence) ──
  useEffect(() => {
    if (reducedEffects) return;
    let closeTimer: NodeJS.Timeout | null = null;
    let openTimer: NodeJS.Timeout | null = null;
    let stopped = false;
    const schedule = () => {
      if (stopped) return;
      // styleRef (not the prop) so a style switch mid-gap picks up the new
      // cadence on the next cycle without tearing the loop down.
      const [minGap, range, closedMs] = BLINK_CFG[styleRef.current];
      closeTimer = setTimeout(() => {
        // Skip blinks mid-drag and in eyes-wide states.
        const face = POSES[poseRef.current].face;
        if (!motionRef.current.dragging && face !== 'shocked' && face !== 'dizzy' && partsRef.current?.faces.blink) {
          setBlinking(true);
          openTimer = setTimeout(() => { setBlinking(false); schedule(); }, closedMs);
        } else {
          schedule();
        }
      }, minGap + Math.random() * range);
    };
    schedule();
    return () => {
      stopped = true;
      if (closeTimer) clearTimeout(closeTimer);
      if (openTimer) clearTimeout(openTimer);
      setBlinking(false);
    };
  }, [reducedEffects, motionRef]);

  // ── Pupil targets (curious face follows the cursor) ──
  useEffect(() => {
    if (reducedEffects) return;
    const onMove = (e: PointerEvent) => {
      const host = hostRef.current;
      const parts = partsRef.current;
      if (!host || !parts || !parts.pupils.length) return;
      if (POSES[poseRef.current].face !== 'curious') return;
      const r = host.getBoundingClientRect();
      if (!r.width) return;
      const nx = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / r.width));
      const ny = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / r.height));
      pupilRef.current = { x: nx * 0.55, y: ny * 0.4 };
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, [reducedEffects]);

  // ── Unified spring loop: pose base + drag trail + idle sway per part ──
  useEffect(() => {
    if (reducedEffects) return;
    let raf = 0;
    let last = performance.now();
    // Hyper twitch countdown — an impulse straight into a random spring's velocity.
    let twitchIn = 1200;
    // Force one write after a pose change even for parked springs — a pose can
    // change only tx/ty (side-peek arm parking) while the rotation target is
    // unchanged, and the parked-spring skip below would never write it.
    let lastPose: PoseName | null = null;
    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      const dt = now - last;
      last = now;
      const parts = partsRef.current;
      if (!parts) return;
      const m = motionRef.current;
      const style = styleRef.current;
      const I = intensityRef.current;
      const poseName = poseRef.current;
      const poseChanged = lastPose !== poseName;
      lastPose = poseName;
      const def = POSES[poseName];
      const drag = m.dragging ? dragTargets(m.vx, m.vy) : null;
      const sway = m.dragging ? null : idleSway(now, style, I);
      if (style === 'hyper' && !m.dragging) {
        twitchIn -= dt;
        if (twitchIn <= 0) {
          const id = SPRING_IDS[Math.floor(Math.random() * SPRING_IDS.length)];
          const s = springsRef.current.get(id);
          if (s && parts.byId.has(id)) s.velocity += (60 + Math.random() * 140) * (Math.random() < 0.5 ? -1 : 1) * I;
          twitchIn = 700 + Math.random() * 1700;
        }
      }
      for (const id of SPRING_IDS) {
        const el = parts.byId.get(id);
        if (!el) continue;
        const pp = def.parts[id] ?? {};
        const base = pp.rotate ?? 0;
        let offs = 0;
        if (drag) {
          offs = id === 'rig-tail' ? drag['rig-leg-left'] * 0.8 : (drag[id as (typeof LIMB_IDS)[number]] ?? 0);
        } else {
          offs = sway?.[id] ?? 0;
          // The welcome wave rides the right arm's spring (±8° sinusoid) —
          // published rigs have no waveInner wrapper, so the physics does it.
          if (def.wave && id === 'rig-arm-right') offs += waveSway(now);
        }
        const target = base + offs;
        let s = springsRef.current.get(id);
        if (!s) { s = { value: base, velocity: 0 }; springsRef.current.set(id, s); }
        if (!poseChanged && s.value === target && isSettled(s, target)) continue; // parked on a static target
        const next = stepSpring(s, target, dt);
        s.value = next.value;
        s.velocity = next.velocity;
        el.style.transition = 'none';
        el.style.transform = `translate(${pp.tx ?? 0}px, ${pp.ty ?? 0}px) rotate(${s.value.toFixed(2)}deg)`;
      }
      // Velocity decay while a drag pauses mid-hold, so limbs relax.
      if (m.dragging) { m.vx *= 0.85; m.vy *= 0.85; }
      // Curious pupils follow the cursor.
      if (parts.pupils.length && def.face === 'curious') {
        const p = pupilRef.current;
        for (const el of parts.pupils) {
          (el.style as unknown as Record<string, string>).transformBox = 'view-box';
          el.style.transform = `translate(${p.x.toFixed(2)}px, ${p.y.toFixed(2)}px)`;
        }
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [reducedEffects, motionRef]);

  return (
    <div
      ref={hostRef}
      style={{ width: '100%', height: '100%', pointerEvents: 'none' }}
      // Sanitized upstream — sanitizeRigSvg is the security boundary.
      dangerouslySetInnerHTML={svgHtml ? { __html: svgHtml } : undefined}
    />
  );
}

/** Direct (non-spring) pose write — initial mount and reduced-effects mode. */
function applyPose(parts: Parts, pose: PoseName, blinking: boolean, instant: boolean): void {
  const def = POSES[pose];
  for (const [id, el] of parts.byId) {
    if (id === 'rig-body') continue;
    const p = def.parts[id] ?? {};
    el.style.transition = instant ? 'none' : 'transform 180ms ease-out';
    el.style.transform = `translate(${p.tx ?? 0}px, ${p.ty ?? 0}px) rotate(${p.rotate ?? 0}deg)`;
  }
  applyFace(parts, pose, blinking);
}

function applyFace(parts: Parts, pose: PoseName, blinking: boolean): void {
  const def = POSES[pose];
  // Blink overlays whichever face is showing (except eyes-wide states).
  const want: FaceName | 'blink' =
    blinking && parts.faces.blink && def.face !== 'shocked' && def.face !== 'dizzy' ? 'blink' : def.face;
  for (const [name, el] of Object.entries(parts.faces)) {
    (el as SVGGElement).style.display = name === want ? '' : 'none';
  }
}
