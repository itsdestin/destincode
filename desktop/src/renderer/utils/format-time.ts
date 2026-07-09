/** Format an epoch-ms timestamp as a short time string for chat bubbles (e.g. "2:34 PM"). */
export function formatBubbleTime(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/**
 * Compact relative-time label ("just now", "5m ago", "3h ago", "2d ago", then
 * a locale date). Accepts epoch-ms OR an ISO string — the artifact sidecar
 * stores ISO while session lists carry epoch, and this was previously
 * re-implemented five times with three different signatures.
 */
export function formatRelativeTime(when: number | string): string {
  const ms = typeof when === 'number' ? when : Date.parse(when);
  if (!when || Number.isNaN(ms)) return '';
  const diff = Date.now() - ms;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}
