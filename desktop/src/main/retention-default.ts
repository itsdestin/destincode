import fs from 'fs';
import path from 'path';
import os from 'os';

// Seed `cleanupPeriodDays` into ~/.claude/settings.json when the key is
// ABSENT. Claude Code deletes transcript JSONLs whose age exceeds
// cleanupPeriodDays, and its built-in default is 30 days — which silently
// destroys YouCoded's Resume Browser history (2026-06-12 investigation: 221
// named conversations deleted locally). YouCoded is a chat app; users expect
// history to persist, so we seed a year.
//
// Unlike disable-prompt-suggestion.ts (force-overwrites every launch), this
// only writes when the key is missing: an explicit user value — even a
// deliberately short one — is respected.
//
// CC-coupled: `cleanupPeriodDays` is a Claude Code settings contract. See
// youcoded/docs/cc-dependencies.md → "Transcript retention (cleanupPeriodDays)".

export const DEFAULT_CLEANUP_PERIOD_DAYS = 365;

export interface SeedRetentionResult {
  /** True iff settings.json was rewritten (key was absent). */
  changed: boolean;
  /** The value now in effect, or undefined if settings were unreadable. */
  effective: number | undefined;
}

function settingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

export function seedCleanupPeriodDefault(): SeedRetentionResult {
  const p = settingsPath();
  let settings: Record<string, unknown> = {};
  if (fs.existsSync(p)) {
    try {
      settings = JSON.parse(fs.readFileSync(p, 'utf8'));
    } catch {
      // Do NOT rewrite on parse failure — settings.json carries hooks and
      // enabledPlugins; replacing a corrupt file with just our key would wipe
      // them. (disable-prompt-suggestion.ts writes fresh in this case; that
      // convention is wrong for a low-stakes seeding like this one.)
      return { changed: false, effective: undefined };
    }
  }

  if (typeof settings.cleanupPeriodDays === 'number') {
    return { changed: false, effective: settings.cleanupPeriodDays as number };
  }

  settings.cleanupPeriodDays = DEFAULT_CLEANUP_PERIOD_DAYS;
  fs.mkdirSync(path.dirname(p), { recursive: true });
  // Atomic write (tmp + rename) — same convention as disable-prompt-suggestion.
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, p);
  return { changed: true, effective: DEFAULT_CLEANUP_PERIOD_DAYS };
}
