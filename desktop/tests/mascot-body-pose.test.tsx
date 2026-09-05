// @vitest-environment jsdom
//
// The BODY actually moves.
//
// WHAT THIS IS GUARDING, in plain terms: the buddy is one box with a face on
// it, four little limbs, and — until 2026-09-04 — no way for a pose to move the
// box. `rig-body` was allowed by the type and accepted in a pose, and then
// silently thrown away: `applyPose` skipped it by name and the spring loop only
// ever drove limbs. Every way of falling asleep starts with the body settling,
// so without this the buddy could only ever fall asleep from the elbows down.
//
// The sibling test in mascot-poses.test.ts checks the pose TABLE says the right
// thing. This one checks something reads it — a table nobody applies is exactly
// the kind of test that passes while the feature does nothing.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/react';
import { MascotRig, type RigMotion } from '../src/renderer/components/mascot/MascotRig';
import { POSES } from '../src/renderer/components/mascot/mascot-poses';

afterEach(cleanup);

function mount(pose: Parameters<typeof MascotRig>[0]['pose']) {
  const motionRef = { current: { vx: 0, vy: 0, dragging: false } as RigMotion };
  // reducedEffects: springs and idle loops off, so the only thing writing a
  // transform is the pose itself — which is the thing under test.
  const r = render(
    <MascotRig svgUrl={null} pose={pose} motionRef={motionRef} reducedEffects />,
  );
  return r.container;
}

const bodyOf = (c: HTMLElement) => c.querySelector<SVGGElement>('#rig-body');
const rootOf = (c: HTMLElement) => c.querySelector<SVGGElement>('#rig-root');

describe('a pose that moves the body', () => {
  it('writes the body transform the pose asks for', async () => {
    const c = mount('sleep-loaf');
    await waitFor(() => expect(bodyOf(c)).toBeTruthy());
    const want = POSES['sleep-loaf'].parts['rig-body']!;
    await waitFor(() => {
      const t = bodyOf(c)!.style.transform;
      expect(t).toContain(`translate(0px, ${want.ty}px)`);
      expect(t).toContain(`scale(${want.scale})`);
    });
  });

  it('leaves the body alone for a pose that does not ask', async () => {
    // Every pose that shipped before this existed must be byte-for-byte
    // unchanged: no rotation, no shift, no shrink, full brightness.
    const c = mount('idle');
    await waitFor(() => expect(bodyOf(c)).toBeTruthy());
    await waitFor(() => {
      expect(bodyOf(c)!.style.transform).toBe('translate(0px, 0px) rotate(0deg) scale(1)');
    });
    expect(rootOf(c)!.style.opacity).toBe('1');
  });

  it('dims the WHOLE rig, not the body on its own', async () => {
    // The limbs are SIBLINGS of the body, not children of it — fading the body
    // alone would leave four bright stubs around a faded box.
    const c = mount('sleep-deflate');
    await waitFor(() => expect(rootOf(c)).toBeTruthy());
    await waitFor(() => {
      expect(rootOf(c)!.style.opacity).toBe(String(POSES['sleep-deflate'].dim));
    });
  });

  it('holds the eyes shut for the whole sleep, not for a blink', async () => {
    const c = mount('sleep-slump');
    await waitFor(() => expect(c.querySelector('#rig-face-blink')).toBeTruthy());
    await waitFor(() => {
      expect(c.querySelector<SVGGElement>('#rig-face-blink')!.style.display).toBe('');
      expect(c.querySelector<SVGGElement>('#rig-face-welcome')!.style.display).toBe('none');
    });
  });
});
