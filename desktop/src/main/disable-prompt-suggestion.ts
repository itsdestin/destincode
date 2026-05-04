import fs from 'fs';
import path from 'path';
import os from 'os';

// Force `promptSuggestionEnabled: false` in the user's ~/.claude/settings.json
// at every app launch. Claude Code 2.1.x ships an opt-out next-prompt
// suggestion (system prompt: "[SUGGESTION MODE: Suggest what the user might
// naturally type next into Claude Code.]") that pre-fills ghost text into the
// input bar. The interaction is buggy in YouCoded — our chat→PTY write path
// streams body bytes + `\r` directly without clearing CC's input buffer, so
// suggestion ghost text gets concatenated with the user's chat send and
// submitted as one combined user prompt. Re-enable here only if/when the
// underlying interaction is fixed.

function settingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

interface Settings {
  promptSuggestionEnabled?: boolean;
  [k: string]: unknown;
}

export interface EnforcePromptSuggestionResult {
  /** True iff settings.json was rewritten because the value didn't match. */
  changed: boolean;
  /** The value before this call. `undefined` when the key was absent (CC's
   *  default is `enabled`, so absent === enabled from CC's perspective). */
  prior: boolean | undefined;
}

function readSettings(): Settings {
  try {
    if (!fs.existsSync(settingsPath())) return {};
    return JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) as Settings;
  } catch {
    // Treat unreadable / unparseable settings as empty — same convention as
    // hook-reconciler. We'll write a fresh, well-formed file with our key set.
    return {};
  }
}

function writeSettingsAtomic(settings: Settings): void {
  const dir = path.dirname(settingsPath());
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${settingsPath()}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), 'utf8');
  fs.renameSync(tmp, settingsPath());
}

export function enforcePromptSuggestionDisabled(): EnforcePromptSuggestionResult {
  const settings = readSettings();
  const prior = settings.promptSuggestionEnabled;

  if (prior === false) {
    return { changed: false, prior };
  }

  settings.promptSuggestionEnabled = false;
  writeSettingsAtomic(settings);
  return { changed: true, prior };
}
