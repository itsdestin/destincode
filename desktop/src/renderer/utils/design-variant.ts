// src/renderer/utils/design-variant.ts
//
// TEMPORARY, and deliberately tiny. Lets one surface render two or three
// candidate designs so they can be compared side by side in the UI Workbench
// before one is picked. Read from the query string once at module load:
//
//   ?dv_organize=tabs
//
// The workbench toolbar writes these (see WorkbenchToolbar.tsx) and
// WorkbenchFrame forwards every `dv_*` param into the app iframe. In the real
// app there is no query string, so every call returns its fallback — the
// shipping design — and the alternatives are unreachable.
//
// WHY THIS LIVES IN PRODUCTION CODE, not under dev/workbench: the surfaces
// being compared ARE production components, and a static import from
// dev/workbench would pull the whole mock shim into the app bundle. Fifteen
// lines here is the cheaper trade.
//
// WHY NOT variants.ts AS THE SPEC DESCRIBED IT (whole-component siblings,
// ResumeBrowser.v2.tsx): that shape assumes the thing being varied is a whole
// surface. The first real comparison turned out to be a ~40-line region inside
// an 1100-line component, and forking the file three ways to vary that region
// would have made drift certain in the 1060 lines nobody is comparing — the
// exact failure the spec's "never fork the shipping component" rule exists to
// prevent. Keep that design in mind for whole-surface alternatives; this is the
// in-place variant.
//
// FINALIZING: when a winner is picked, delete the losing branches at the call
// site, then delete this file and its toolbar control. A `dv_` param surviving
// into a release means an alternative was never resolved.

const params = typeof location !== 'undefined'
  ? new URLSearchParams(location.search)
  : new URLSearchParams();

export function designVariant<T extends string>(key: string, fallback: T, allowed: readonly T[]): T {
  const raw = params.get(`dv_${key}`);
  // Unknown values fall back rather than rendering nothing — a typo'd param in
  // a shared workbench URL should show the default design, not a blank card.
  return (allowed as readonly string[]).includes(raw ?? '') ? (raw as T) : fallback;
}
