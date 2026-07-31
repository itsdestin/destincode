// src/renderer/utils/design-variant.ts
//
// TEMPORARY, and deliberately tiny. Lets one surface render several candidate
// designs so they can be compared in the UI Workbench before one is picked.
// Read from the query string once at module load:
//
//   ?dv_organizepop=centered
//
// The workbench toolbar writes these (WorkbenchToolbar.tsx) and WorkbenchFrame
// forwards every `dv_*` param into the app iframe. In the real app there is no
// query string, so every call returns its fallback — the shipping design — and
// the alternatives are unreachable.
//
// SECOND LIFE: this file was added for the organize-UI comparison (popover vs
// tabs vs inline), then deleted when popover won, on the rule that a surviving
// `dv_` param means an unresolved design. It is back for the icon and
// popover-placement round. That churn is the intended lifecycle, not a mistake:
// the file exists only while a question is open, and goes again when it closes.
//
// WHY IT LIVES IN PRODUCTION CODE, not under dev/workbench: the surfaces being
// compared ARE production components, and a static import from dev/workbench
// would pull the whole mock shim into the app bundle. Fifteen lines here is the
// cheaper trade.
//
// WHY NOT variants.ts AS THE WORKBENCH SPEC §3.4 DESCRIBED IT (whole-component
// siblings, ResumeBrowser.v2.tsx): that shape assumes the thing being varied is
// a whole surface. Every comparison so far has been a small region inside an
// 1100-line component, and forking the file N ways to vary that region would
// make drift certain in the lines nobody is comparing — the exact failure the
// spec's "never fork the shipping component" rule exists to prevent. Keep that
// design in mind for whole-surface alternatives; this is the in-place variant.
//
// FINALIZING: when a winner is picked, delete the losing branches at the call
// site, then delete this file and its toolbar controls.

const params = typeof location !== 'undefined'
  ? new URLSearchParams(location.search)
  : new URLSearchParams();

export function designVariant<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  const raw = params.get(`dv_${key}`);
  // Unknown values fall back rather than rendering nothing — a typo'd param in
  // a shared workbench URL should show the default design, not a blank card.
  return (allowed as readonly string[]).includes(raw ?? '') ? (raw as T) : fallback;
}
