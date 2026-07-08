// Pure helpers for the sync-spaces subsystem. NO fs/os imports — keeps this
// unit-testable without mocks (same rule as local-theme-synthesizer).

// Why: a name created on macOS/Linux must not break a Windows device later.
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const INVALID_CHARS = /[<>:"|?*\x00-\x1f/\\]/;

/** Returns an error message, or null when the name is safe on every platform. */
export function validateSyncName(name: string): string | null {
  if (!name || name === '.' || name === '..') return 'Name is empty or invalid';
  if (WINDOWS_RESERVED.test(name)) return `"${name}" is a reserved name on Windows`;
  if (INVALID_CHARS.test(name)) return 'Name contains a character not allowed on all platforms (< > : " | ? * / \\)';
  if (/[. ]$/.test(name)) return 'Name cannot end with a dot or space (Windows restriction)';
  if (name.length > 100) return 'Name is too long (max 100 characters)';
  return null;
}

// Spec §8 default ignore set: build junk + secrets. gitignore syntax — written
// into each hidden repo's info/exclude (never into the user's tree).
export const DEFAULT_IGNORES: string[] = [
  'node_modules/', '.git/', '.youcoded/', 'dist/', 'build/', 'out/', 'target/',
  '.venv/', 'venv/', '__pycache__/', '.pytest_cache/', '.gradle/',
  '.DS_Store', 'Thumbs.db', 'desktop.ini',
  '.env', '.env.*', '*.pem', '*.key', 'id_rsa*', 'id_ed25519*', '*.credentials.json',
];

/** Spec §7: files over this cap don't live-sync (daily backup covers them). */
export const MAX_SYNC_FILE_BYTES = 50 * 1024 * 1024;

/** Spec §8: "notes (from Laptop, 2026-07-03).md" — the visible conflict copy. */
export function conflictCopyName(relPath: string, deviceName: string, when: Date): string {
  const date = when.toISOString().slice(0, 10);
  const dot = relPath.lastIndexOf('.');
  const slash = Math.max(relPath.lastIndexOf('/'), relPath.lastIndexOf('\\'));
  const suffix = ` (from ${deviceName}, ${date})`;
  if (dot > slash + 1) return `${relPath.slice(0, dot)}${suffix}${relPath.slice(dot)}`;
  return `${relPath}${suffix}`;
}

/** Case-insensitive collision groups — these break macOS/Windows checkouts. */
export function findCaseCollisions(paths: string[]): string[][] {
  const byLower = new Map<string, string[]>();
  for (const p of paths) {
    const k = p.toLowerCase();
    byLower.set(k, [...(byLower.get(k) ?? []), p]);
  }
  return [...byLower.values()].filter(g => g.length > 1);
}
