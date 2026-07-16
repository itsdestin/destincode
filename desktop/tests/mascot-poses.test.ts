import { describe, it, expect } from 'vitest';
import {
  parsePivot, defaultPivot, POSES, stepSpring, isSettled, dragTargets,
  LIMB_IDS,
} from '../src/renderer/components/mascot/mascot-poses';

describe('parsePivot', () => {
  it('parses "x y" and "x,y"', () => {
    expect(parsePivot('18 38')).toEqual({ x: 18, y: 38 });
    expect(parsePivot('18,38')).toEqual({ x: 18, y: 38 });
    expect(parsePivot(' 18.5  38 ')).toEqual({ x: 18.5, y: 38 });
  });
  it('rejects malformed input', () => {
    expect(parsePivot(null)).toBeNull();
    expect(parsePivot('')).toBeNull();
    expect(parsePivot('18')).toBeNull();
    expect(parsePivot('a b')).toBeNull();
  });
});

describe('defaultPivot', () => {
  const bbox = { x: 10, y: 20, width: 8, height: 20 };
  it('limbs pivot at top-center (shoulder/hip — limbs hang down)', () => {
    expect(defaultPivot('rig-arm-left', bbox)).toEqual({ x: 14, y: 20 });
    expect(defaultPivot('rig-leg-right', bbox)).toEqual({ x: 14, y: 20 });
  });
});

describe('POSES', () => {
  it('every pose names only known part ids and a valid face', () => {
    for (const pose of Object.values(POSES)) {
      expect(['idle', 'welcome', 'curious', 'shocked', 'dizzy']).toContain(pose.face);
      for (const id of Object.keys(pose.parts)) {
        expect([...LIMB_IDS, 'rig-tail', 'rig-body']).toContain(id);
      }
    }
  });
  // SIGN-CONVENTION PINS (2026-07-16 workbench): limbs hang down from their
  // pivot, positive = clockwise. These caught a real bug — the original plan
  // sketch had the wave crossing the face.
  it('welcome raises the right arm OUTWARD (negative rotation)', () => {
    expect(POSES.welcome.parts['rig-arm-right']!.rotate!).toBeLessThan(0);
  });
  it('shocked flails both arms OUTWARD (left positive, right negative)', () => {
    expect(POSES.shocked.parts['rig-arm-left']!.rotate!).toBeGreaterThan(0);
    expect(POSES.shocked.parts['rig-arm-right']!.rotate!).toBeLessThan(0);
  });
  it('bottom-peek curls both arms INWARD to grip the edge', () => {
    expect(POSES.peek.parts['rig-arm-left']!.rotate!).toBeLessThan(0);
    expect(POSES.peek.parts['rig-arm-right']!.rotate!).toBeGreaterThan(0);
  });
});

describe('stepSpring', () => {
  it('converges to the target and settles', () => {
    let s = { value: 0, velocity: 0 };
    for (let i = 0; i < 300; i++) s = stepSpring(s, 20, 16);
    expect(s.value).toBeCloseTo(20, 0);
    expect(isSettled(s, 20)).toBe(true);
  });
  it('overshoots on the way (underdamped wobble)', () => {
    let s = { value: 0, velocity: 0 };
    let maxV = 0;
    for (let i = 0; i < 300; i++) { s = stepSpring(s, 20, 16); maxV = Math.max(maxV, s.value); }
    expect(maxV).toBeGreaterThan(20); // the wobble is the feature
  });
  it('clamps huge dt so a paused rAF cannot explode the spring', () => {
    let s = { value: 0, velocity: 0 };
    s = stepSpring(s, 20, 5000);
    expect(Number.isFinite(s.value)).toBe(true);
    expect(Math.abs(s.value)).toBeLessThan(100);
  });
});

describe('dragTargets', () => {
  it('limbs trail opposite the direction of horizontal motion', () => {
    const t = dragTargets(10, 0); // moving right → limbs lag left (negative rotation)
    expect(t['rig-arm-left']).toBeLessThan(0);
    expect(t['rig-leg-left']).toBeLessThan(0);
  });
  it('is clamped', () => {
    const t = dragTargets(10000, 10000);
    for (const v of Object.values(t)) expect(Math.abs(v)).toBeLessThanOrEqual(45);
  });
  it('zero velocity → zero targets', () => {
    const t = dragTargets(0, 0);
    for (const v of Object.values(t)) expect(v).toBe(0);
  });
});
