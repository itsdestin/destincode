/**
 * First-party default buddy (spec §3.6) — the capsule character in the
 * approved 2.5D-soft skin, ported from wecoded-themes/mascots/skins/
 * 2-5d-soft.svg. Ships as a rig so every user gets the full experience
 * (trailing limbs, six faces, peek hands) out of the box, and doubles as
 * the rig contract's reference implementation.
 *
 * Tinting: body/limbs use var(--rig-accent), face/sockets var(--rig-on-accent)
 * (the buddy renderer maps these from the theme's accent/on-accent tokens,
 * whose contrast rules guarantee ≥4.5:1). The skin's amber-derived highlight/
 * shade colors are replaced with white/black overlays at matching opacities so
 * the lighting works on ANY accent color, not just amber. Fallbacks keep the
 * demo palette so the SVG previews standalone.
 * NOT currentColor — that renders black through the legacy <img> path.
 *
 * Limbs are drawn HANGING DOWN from their data-pivot (the pose-data
 * convention) and painted before the body so they sit behind it.
 */
export const DEFAULT_BUDDY_RIG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-3 -5 30 30">
  <defs>
    <radialGradient id="g-hi" cx="33%" cy="20%" r="80%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.42"/>
      <stop offset="55%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="g-lo" x1="0" y1="0" x2="0.22" y2="1">
      <stop offset="52%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.34"/>
    </linearGradient>
    <linearGradient id="g-limb-shade" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#000000" stop-opacity="0"/>
      <stop offset="100%" stop-color="#000000" stop-opacity="0.32"/>
    </linearGradient>
    <radialGradient id="g-spec" cx="30%" cy="16%" r="26%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </radialGradient>
    <filter id="f-soft" x="-60%" y="-60%" width="220%" height="220%">
      <feGaussianBlur stdDeviation="0.45"/>
    </filter>
  </defs>
  <g id="rig-root">
    <g id="rig-arm-left" data-pivot="2.5 9">
      <path d="M1.8 9 L3.2 9 A0.8 0.8 0 0 1 4 9.8 L4 12.2 A0.8 0.8 0 0 1 3.2 13 L1.8 13 A0.8 0.8 0 0 1 1 12.2 L1 9.8 A0.8 0.8 0 0 1 1.8 9 Z" fill="var(--rig-accent, #f0a828)"/>
      <path d="M1.8 9 L3.2 9 A0.8 0.8 0 0 1 4 9.8 L4 12.2 A0.8 0.8 0 0 1 3.2 13 L1.8 13 A0.8 0.8 0 0 1 1 12.2 L1 9.8 A0.8 0.8 0 0 1 1.8 9 Z" fill="url(#g-limb-shade)"/>
    </g>
    <g id="rig-arm-right" data-pivot="21.5 9">
      <path d="M20.8 9 L22.2 9 A0.8 0.8 0 0 1 23 9.8 L23 12.2 A0.8 0.8 0 0 1 22.2 13 L20.8 13 A0.8 0.8 0 0 1 20 12.2 L20 9.8 A0.8 0.8 0 0 1 20.8 9 Z" fill="var(--rig-accent, #f0a828)"/>
      <path d="M20.8 9 L22.2 9 A0.8 0.8 0 0 1 23 9.8 L23 12.2 A0.8 0.8 0 0 1 22.2 13 L20.8 13 A0.8 0.8 0 0 1 20 12.2 L20 9.8 A0.8 0.8 0 0 1 20.8 9 Z" fill="url(#g-limb-shade)"/>
      <g id="slot-item"/>
    </g>
    <g id="rig-leg-left" data-pivot="8.95 17">
      <rect x="7.2" y="17" width="3.5" height="4" rx="1.2" fill="var(--rig-accent, #f0a828)"/>
      <rect x="7.2" y="17" width="3.5" height="4" rx="1.2" fill="url(#g-limb-shade)"/>
    </g>
    <g id="rig-leg-right" data-pivot="15.05 17">
      <rect x="13.3" y="17" width="3.5" height="4" rx="1.2" fill="var(--rig-accent, #f0a828)"/>
      <rect x="13.3" y="17" width="3.5" height="4" rx="1.2" fill="url(#g-limb-shade)"/>
    </g>
    <g id="rig-body">
      <path d="M9 4 L15 4 A4 4 0 0 1 19 8 L19 12 A4 4 0 0 1 15 16 L9 16 A4 4 0 0 1 5 12 L5 8 A4 4 0 0 1 9 4 Z" fill="var(--rig-accent, #f0a828)"/>
      <path d="M9 4 L15 4 A4 4 0 0 1 19 8 L19 12 A4 4 0 0 1 15 16 L9 16 A4 4 0 0 1 5 12 L5 8 A4 4 0 0 1 9 4 Z" fill="url(#g-lo)"/>
      <path d="M9 4 L15 4 A4 4 0 0 1 19 8 L19 12 A4 4 0 0 1 15 16 L9 16 A4 4 0 0 1 5 12 L5 8 A4 4 0 0 1 9 4 Z" fill="url(#g-hi)"/>
      <ellipse cx="9.6" cy="6.4" rx="3.4" ry="1.9" fill="url(#g-spec)" transform="rotate(-14 9.6 6.4)"/>
      <path d="M5 10.5 L5 8 A4 4 0 0 1 9 4 L11 4" fill="none" stroke="#ffffff" stroke-opacity="0.55" stroke-width="0.32" filter="url(#f-soft)"/>
      <g id="rig-face-idle">
        <path fill="var(--rig-on-accent, #2a1004)" d="M8.5 8 L10.5 10 L8.5 12 L9.5 12 L11.5 10 L9.5 8 Z"/>
        <path fill="var(--rig-on-accent, #2a1004)" d="M15.5 8 L13.5 10 L15.5 12 L14.5 12 L12.5 10 L14.5 8 Z"/>
      </g>
      <g id="rig-face-welcome" style="display:none">
        <ellipse cx="9.3" cy="9.55" rx="1.6" ry="2.2" fill="var(--rig-on-accent, #2a1004)"/>
        <ellipse cx="14.7" cy="9.25" rx="1.6" ry="2.2" fill="var(--rig-on-accent, #2a1004)"/>
        <circle cx="10" cy="10.25" r="0.28" fill="var(--rig-accent, #ffc030)"/><circle cx="9.35" cy="10.85" r="0.2" fill="var(--rig-accent, #ffe090)" fill-opacity="0.8"/><circle cx="10.3" cy="10.85" r="0.14" fill="var(--rig-accent, #ffd060)" fill-opacity="0.65"/>
        <circle cx="15.4" cy="9.95" r="0.28" fill="var(--rig-accent, #ffc030)"/><circle cx="14.75" cy="10.55" r="0.2" fill="var(--rig-accent, #ffe090)" fill-opacity="0.8"/><circle cx="15.65" cy="10.55" r="0.14" fill="var(--rig-accent, #ffd060)" fill-opacity="0.65"/>
        <g transform="rotate(-2 12 13.3)"><path d="M10.8 13.3 Q10.8 13 12 13 Q13.2 13 13.2 13.3 A1.1 1 0 0 1 10.8 13.3 Z" fill="var(--rig-on-accent, #2a1004)"/></g>
      </g>
      <g id="rig-face-curious" style="display:none">
        <ellipse cx="9.3" cy="9.55" rx="1.7" ry="2.3" fill="var(--rig-on-accent, #2a1004)"/>
        <ellipse cx="14.7" cy="9.25" rx="1.7" ry="2.3" fill="var(--rig-on-accent, #2a1004)"/>
        <g class="pupil"><circle cx="9.75" cy="9.2" r="0.42" fill="var(--rig-accent, #ffc030)"/><circle cx="9" cy="10.3" r="0.22" fill="var(--rig-accent, #ffe090)" fill-opacity="0.8"/><circle cx="9.95" cy="10.15" r="0.14" fill="var(--rig-accent, #ffd060)" fill-opacity="0.65"/></g>
        <g class="pupil"><circle cx="15.15" cy="8.9" r="0.42" fill="var(--rig-accent, #ffc030)"/><circle cx="14.4" cy="10" r="0.22" fill="var(--rig-accent, #ffe090)" fill-opacity="0.8"/><circle cx="15.35" cy="9.85" r="0.14" fill="var(--rig-accent, #ffd060)" fill-opacity="0.65"/></g>
        <path d="M13.5 6.1 Q14.7 5.55 15.9 6.1" fill="none" stroke="var(--rig-on-accent, #2a1004)" stroke-width="0.45" stroke-linecap="round"/>
        <ellipse cx="12.1" cy="13.1" rx="0.55" ry="0.65" fill="var(--rig-on-accent, #2a1004)"/>
      </g>
      <g id="rig-face-shocked" style="display:none">
        <circle cx="9.3" cy="9.8" r="2.1" fill="var(--rig-on-accent, #2a1004)"/>
        <circle cx="14.7" cy="9.8" r="2.1" fill="var(--rig-on-accent, #2a1004)"/>
        <circle cx="9.9" cy="9.2" r="0.5" fill="var(--rig-accent, #ffe090)"/><circle cx="15.3" cy="9.2" r="0.5" fill="var(--rig-accent, #ffe090)"/>
        <ellipse cx="12" cy="13.6" rx="1" ry="1.25" fill="var(--rig-on-accent, #2a1004)"/>
      </g>
      <g id="rig-face-dizzy" style="display:none">
        <g stroke="var(--rig-on-accent, #2a1004)" stroke-width="1" stroke-linecap="round">
          <line x1="8" y1="8.6" x2="10.6" y2="11.4"/><line x1="10.6" y1="8.6" x2="8" y2="11.4"/>
          <line x1="13.4" y1="8.6" x2="16" y2="11.4"/><line x1="16" y1="8.6" x2="13.4" y2="11.4"/>
        </g>
        <path d="M10.4 13.6 L11.2 13 L12 13.6 L12.8 13 L13.6 13.6" fill="none" stroke="var(--rig-on-accent, #2a1004)" stroke-width="0.8" stroke-linecap="round" stroke-linejoin="round"/>
        <path d="M5.4 3.6 Q6.4 2.6 7.4 3.6 Q6.4 4.6 5.4 3.6" fill="none" stroke="var(--rig-accent, #ffc030)" stroke-width="0.5" stroke-linecap="round"/>
        <path d="M16.6 3.6 Q17.6 2.6 18.6 3.6 Q17.6 4.6 16.6 3.6" fill="none" stroke="var(--rig-accent, #ffc030)" stroke-width="0.5" stroke-linecap="round"/>
      </g>
      <g id="rig-face-blink" style="display:none">
        <path d="M8 10 Q9.3 11 10.6 10" fill="none" stroke="var(--rig-on-accent, #2a1004)" stroke-width="0.9" stroke-linecap="round"/>
        <path d="M13.4 10 Q14.7 11 16 10" fill="none" stroke="var(--rig-on-accent, #2a1004)" stroke-width="0.9" stroke-linecap="round"/>
      </g>
      <g id="slot-eyewear"/>
    </g>
    <g id="slot-hat"/>
    <g id="rig-hand-peek-right" style="display:none">
      <rect x="20.7" y="8.3" width="2.6" height="3.4" rx="1.17" fill="var(--rig-accent, #f0a828)" stroke="#000000" stroke-opacity="0.4" stroke-width="0.34"/>
    </g>
    <g id="rig-hand-peek-left" style="display:none">
      <rect x="0.7" y="8.3" width="2.6" height="3.4" rx="1.17" fill="var(--rig-accent, #f0a828)" stroke="#000000" stroke-opacity="0.4" stroke-width="0.34"/>
    </g>
  </g>
</svg>`;
