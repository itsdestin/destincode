/**
 * Sanitizes a theme-provided rig SVG before it is inlined into the buddy DOM.
 *
 * SECURITY BOUNDARY: themes are third-party content, and inline SVG executes
 * in our renderer with access to window.claude. Everything that can run
 * script or reach the network is stripped; only static drawing content,
 * same-document references (#id) and embedded data:image/* rasters survive.
 * Registry-side CI validation is a follow-up — THIS function is the guarantee.
 *
 * Pure (DOMParser is available in the renderer and jsdom tests). Returns the
 * serialized sanitized SVG, or null when the input isn't a parseable SVG.
 */
const BLOCKED_TAGS = ['script', 'foreignObject', 'iframe', 'object', 'embed', 'link', 'meta', 'style', 'animate', 'animateTransform', 'animateMotion', 'set'];

export function sanitizeRigSvg(svgText: string): string | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  } catch {
    return null;
  }
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) return null;

  for (const tag of BLOCKED_TAGS) {
    // SVG is case-sensitive but sloppy authors aren't — match both spellings.
    doc.querySelectorAll(`${tag}, ${tag.toLowerCase()}`).forEach((el) => el.remove());
  }

  const scrub = (el: Element): void => {
    // Array.from, not spread — the repo tsconfig lacks DOM.Iterable.
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
      } else if (name === 'href' || name === 'xlink:href') {
        if (!(value.startsWith('#') || value.toLowerCase().startsWith('data:image/'))) {
          el.removeAttribute(attr.name);
        }
      } else if (name === 'style' && /url\s*\(\s*['"]?\s*(?!#|data:image\/)/i.test(value)) {
        // fill:url(https://…) can exfiltrate via fetch — allow only #refs/data images.
        el.removeAttribute(attr.name);
      }
    }
    for (const child of Array.from(el.children)) scrub(child);
  };
  scrub(root);

  return new XMLSerializer().serializeToString(root);
}
