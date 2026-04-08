/** Format an epoch-ms timestamp as a short time string for chat bubbles (e.g. "2:34 PM"). */
export function formatBubbleTime(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
