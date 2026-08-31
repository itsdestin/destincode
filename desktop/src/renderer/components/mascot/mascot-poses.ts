/**
 * Pose + physics data for rigged mascots (spec §3.3, §5 — youcoded-dev
 * docs/active/specs/2026-07-10-buddy-floater-upgrades-design.md).
 *
 * Poses are DATA acting on named rig parts — themes author parts once, the
 * app defines behaviors centrally. New poses/animations ship in app updates
 * and apply to every existing rig with no re-authoring. Reference behavior:
 * youcoded-dev docs/active/prototypes/2026-07-16-buddy-rig-workbench.html.
 */

export const LIMB_IDS = ['rig-arm-left', 'rig-arm-right', 'rig-leg-left', 'rig-leg-right'] as const;
export type LimbId = (typeof LIMB_IDS)[number];
// The tail springs like a limb (drag target = left-leg lean × 0.8) but has no
// pose entries of its own today, so it stays out of LIMB_IDS.
export type RigPartId = LimbId | 'rig-tail' | 'rig-body';
export type FaceName = 'idle' | 'welcome' | 'curious' | 'shocked' | 'dizzy';
export type PoseName = 'idle' | 'pressed' | 'welcome' | 'curious' | 'shocked' | 'dizzy' | 'flap' | 'peek' | 'peek-right' | 'peek-left';

export interface PartPose { rotate?: number; tx?: number; ty?: number; hidden?: boolean; }
export interface PoseDef { parts: Partial<Record<RigPartId, PartPose>>; face: FaceName; wave?: boolean; }

// Rotation values assume limbs drawn HANGING DOWN from their pivot (the
// rig-contract convention, wecoded-themes/mascots/README.md).
// SIGN CONVENTION (2026-07-16 workbench, verified visually): positive =
// clockwise, so raising the RIGHT arm OUTWARD is NEGATIVE and the LEFT arm
// outward is POSITIVE. +160 on the right arm waves ACROSS THE FACE — an
// earlier sketch had it backwards; the unit tests pin the corrected signs.
export const POSES: Record<PoseName, PoseDef> = {
  // Resting default (Destin 2026-07-16): idle POSTURE with the OPEN-EYED
  // welcome face — the rig-authored 'idle' face (chevron/closed eyes on some
  // skins) is reserved for the pressed state below. Arms hang a touch lower
  // than the authored rest for a more relaxed read.
  idle:    { parts: { 'rig-arm-left': { ty: 0.5 }, 'rig-arm-right': { ty: 0.5 } }, face: 'welcome' },
  // Push-down/grab state: the authored 'idle' face (chevron eyes). Same arm
  // drop as idle so grabbing doesn't pop the shoulders.
  pressed: { parts: { 'rig-arm-left': { ty: 0.5 }, 'rig-arm-right': { ty: 0.5 } }, face: 'idle' },
  welcome: { parts: { 'rig-arm-right': { rotate: -160 } }, face: 'welcome', wave: true },
  curious: { parts: {}, face: 'curious' },
  shocked: { parts: { 'rig-arm-left': { rotate: 130 }, 'rig-arm-right': { rotate: -130 } }, face: 'shocked' },
  dizzy:   { parts: { 'rig-arm-left': { rotate: -14 }, 'rig-arm-right': { rotate: 14 } }, face: 'dizzy' },
  // Wing-beat (Flappy, spec §5.1): both arms thrown UP and OUT, higher than
  // 'shocked' (±130) so the two never read as the same gesture. The game flips
  // to this on a flap and straight back to 'idle', and the arms' underdamped
  // springs turn that flip into a real beat — the snap up, the overshoot, the
  // settle back down — WITHOUT any animation code in the game.
  //
  // It lives here, in the shared table, rather than in the game: poses are the
  // rig's extension point, so every theme that ships a mascot — including
  // themes published after this app version — gets a flying mascot for free,
  // with nothing for the theme author to do.
  flap:    { parts: { 'rig-arm-left': { rotate: 150 }, 'rig-arm-right': { rotate: -150 } }, face: 'welcome' },
  // Bottom/top peek: arms curled INWARD = little hands gripping the screen
  // edge while the body sinks past it (BuddyMascot applies the sink transform).
  peek:    { parts: { 'rig-arm-left': { rotate: -160 }, 'rig-arm-right': { rotate: 160 } }, face: 'welcome' },
  // Side peek: the edge-pinned grip mittens (rig-hand-peek-*, cloned to the
  // screen edge by BuddyMascot) ARE the hands here, so the rig's OWN arms are
  // HIDDEN — otherwise the 75°-leaning body shows a stray third arm poking out
  // past it, alongside the two mittens (Destin 2026-07-17). One leg cocks out,
  // curious face. (Top/bottom 'peek' above keeps its arms — there the curled
  // arms themselves are the grip, no mittens.)
  'peek-right': { parts: { 'rig-arm-left': { hidden: true }, 'rig-arm-right': { hidden: true }, 'rig-leg-left': { rotate: -10 } }, face: 'curious' },
  'peek-left':  { parts: { 'rig-arm-left': { hidden: true }, 'rig-arm-right': { hidden: true }, 'rig-leg-right': { rotate: 10 } }, face: 'curious' },
};

/** Parse a data-pivot="x y" attribute (viewBox coordinates). */
export function parsePivot(attr: string | null): { x: number; y: number } | null {
  if (!attr) return null;
  const parts = attr.trim().split(/[\s,]+/).map(Number);
  if (parts.length !== 2 || parts.some(Number.isNaN)) return null;
  return { x: parts[0], y: parts[1] };
}

/** Fallback pivot when a part declares no data-pivot: limbs hinge at
 *  top-center (shoulder/hip) — they hang down from it. Canonical capsule
 *  rigs declare explicit pivots: arms (2.5 9)/(21.5 9), legs (8.95 17)/
 *  (15.05 17), tail (19 14). */
export function defaultPivot(
  partId: RigPartId,
  bbox: { x: number; y: number; width: number; height: number },
): { x: number; y: number } {
  void partId; // reserved — future part kinds may hinge elsewhere
  return { x: bbox.x + bbox.width / 2, y: bbox.y };
}

// ── Spring physics (limb trailing during drag) ──
export interface SpringState { value: number; velocity: number; }

// Underdamped on purpose: the release overshoot IS the "carried soft toy"
// wobble. dt clamped so a backgrounded rAF resuming with a huge delta can't
// explode the integration.
export function stepSpring(s: SpringState, target: number, dtMs: number, stiffness = 170, damping = 16): SpringState {
  const dt = Math.min(dtMs, 64) / 1000;
  const accel = stiffness * (target - s.value) - damping * s.velocity;
  const velocity = s.velocity + accel * dt;
  return { value: s.value + velocity * dt, velocity };
}

export function isSettled(s: SpringState, target: number): boolean {
  return Math.abs(s.value - target) < 0.15 && Math.abs(s.velocity) < 0.15;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

// ── Motion styles (spec §5) ──
// Five personalities. Each defines an idle body loop (CSS class on rig-root —
// keyframes in styles/mascot.css, amplitude via --amp), per-limb idle sway fed
// through the SAME springs as drag trailing, and a blink cadence. How a style
// gets picked is still an open UI question (spec §5) — the engine ships all
// five; callers default to 'chill'.
export type MotionStyle = 'chill' | 'bouncy' | 'floaty' | 'hyper' | 'sleepy';

/** Blink cadence per style: [min gap ms, random range ms, closed duration ms]. */
export const BLINK_CFG: Record<MotionStyle, [number, number, number]> = {
  chill: [6000, 6000, 120],
  bouncy: [5000, 4000, 100],
  floaty: [7000, 7000, 160],
  hyper: [2200, 2800, 80],
  sleepy: [3000, 3000, 430],
};

/** Idle body-loop CSS class applied to #rig-root (keyframes in mascot.css).
 *  Hyper reuses the breathe loop at 1.8s via the extra fastBreath class. */
export const IDLE_LOOP_CLASS: Record<MotionStyle, string> = {
  chill: 'rig-breathing',
  bouncy: 'rig-bounce-loop',
  floaty: 'rig-float-loop',
  hyper: 'rig-breathing',
  sleepy: 'rig-sleep-loop',
};

export type SwayTargets = Partial<Record<LimbId | 'rig-tail', number>>;
const SWAY_ZERO: SwayTargets = {};

/** Per-style idle limb sway (degrees added to the pose base). Values are the
 *  workbench-approved ones — the sway rides the springs, so style switches
 *  and pose changes settle with the same overshoot physics as everything else. */
export function idleSway(t: number, style: MotionStyle, intensity: number): SwayTargets {
  const I = intensity;
  if (style === 'bouncy') {
    const a = Math.sin(t / 165) * 2.4 * I;
    return { 'rig-arm-left': -a, 'rig-arm-right': a, 'rig-leg-left': a * 0.5, 'rig-leg-right': -a * 0.5, 'rig-tail': a * 2.2 };
  }
  if (style === 'floaty') {
    const a = Math.sin(t / 1250) * 7 * I;
    const b = Math.sin(t / 1250 + 2.1) * 4 * I;
    return { 'rig-arm-left': -8 * I + a, 'rig-arm-right': 8 * I - a, 'rig-leg-left': b, 'rig-leg-right': -b, 'rig-tail': a };
  }
  if (style === 'sleepy') {
    const a = Math.sin(t / 1700) * 1.6 * I;
    return { 'rig-arm-left': -7 * I + a, 'rig-arm-right': 7 * I - a, 'rig-tail': a };
  }
  if (style === 'hyper') {
    const a = Math.sin(t / 300) * 1.2 * I;
    return { 'rig-arm-left': a, 'rig-arm-right': -a, 'rig-tail': Math.sin(t / 220) * 5 * I };
  }
  return SWAY_ZERO;
}

/** Welcome-pose wave: a sinusoid on the waving arm's spring target (±8°,
 *  ~700ms period — the workbench waveWiggle, but through the physics since
 *  published rigs don't carry a waveInner wrapper group). */
export function waveSway(t: number): number {
  return Math.sin((t / 700) * Math.PI * 2) * 8;
}

/** Per-limb rotation targets (degrees) from smoothed drag velocity.
 *  Velocity must be normalized to the 80px buddy-window scale by the caller
 *  (k = 80/renderSize × 2.4) so trailing feels identical at any size.
 *  Limbs trail BEHIND the motion: dragging right swings hanging limbs
 *  clockwise (POSITIVE — tips lag back-left of their pivots). The original
 *  sign was inverted and the ±28 lean clamp saturated at slow drags —
 *  corrected + widened per Destin's 2026-07-16 dev-test feedback so faster
 *  drags visibly trail further. */
export function dragTargets(vx: number, vy: number): Record<LimbId, number> {
  const lean = clamp(vx * 2.2, -40, 40);
  const lift = clamp(vy * 0.8, -10, 10);
  return {
    'rig-arm-left': clamp(lean * 1.4 + lift, -65, 65),
    'rig-arm-right': clamp(lean * 1.4 - lift, -65, 65),
    'rig-leg-left': clamp(lean * 1.1, -55, 55),
    'rig-leg-right': clamp(lean * 1.1, -55, 55),
  };
}
