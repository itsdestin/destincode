// Fix: tool inputs are unknown-typed JSON from the model/provider — a field can
// arrive as an object/array/number where the UI expects a string. Interpolating
// such a value renders "[object Object]" in chat (the failure class the harness
// review battery caught for a provider 402), and passing one to a string method
// or basename() throws, crashing the whole Chat pane via its ErrorBoundary.
// Shared by ToolCard.tsx (collapsed header, PR #295) and tool-views/ToolBody.tsx
// (expanded body) so both surfaces validate identically.

/** Returns v if it is a string, else '' — treat non-strings as absent. */
export function asString(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
