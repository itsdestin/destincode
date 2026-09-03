#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(
  require('os').homedir(),
  '.claude',
  'settings.json'
);
// --- Resolve hook scripts to a STABLE location -----------------------------
//
// In packaged builds __dirname is inside app.asar; the hook scripts are
// extracted to app.asar.unpacked so Claude Code (an external process) can read
// them. But on Linux YouCoded ships as an AppImage, which mounts at a
// *different* random /tmp/.mount_XXXXXX path on EVERY launch. Baking that
// volatile path into ~/.claude/settings.json means every hook (relay,
// auto-title, statusline) silently breaks the moment the app is closed — and
// for any `claude` CLI session run outside the app.
//
// Fix: copy the bundled hook scripts into a fixed directory under ~/.claude on
// each launch, and point settings.json at that stable copy instead.
const rawHookSrcDir = path.resolve(__dirname, '..', 'hook-scripts');
const HOOK_SRC_DIR = rawHookSrcDir.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
const STABLE_HOOK_DIR = path.join(require('os').homedir(), '.claude', 'youcoded-hooks');

// Safety: refuse to run when the bundled scripts live inside a dev worktree.
// settings.json is a shared resource — staging worktree-version scripts into
// the stable dir would have the installed app run dev code. Belt-and-suspenders
// backstop for the YOUCODED_PROFILE gate in main.ts.
if (HOOK_SRC_DIR.includes(`${path.sep}.worktrees${path.sep}`)) {
  console.log(
    'install-hooks: hook source is inside a worktree (' + HOOK_SRC_DIR + ') — ' +
    'refusing to touch ~/.claude/settings.json. ' +
    'If this was unexpected, check that YOUCODED_PROFILE is set when running dev.'
  );
  process.exit(0);
}

// Copy every bundled hook script into the stable dir (overwrites, so app
// updates propagate). Returns the directory settings.json should reference:
// the stable copy, or the bundled dir as a fallback if staging failed.
function resolveHookDir() {
  try {
    fs.mkdirSync(STABLE_HOOK_DIR, { recursive: true });
    for (const file of fs.readdirSync(HOOK_SRC_DIR)) {
      // recursive:true so a future lib/ subdir (statusline.sh sources one) copies too.
      fs.cpSync(path.join(HOOK_SRC_DIR, file), path.join(STABLE_HOOK_DIR, file), { recursive: true });
      if (file.endsWith('.sh')) fs.chmodSync(path.join(STABLE_HOOK_DIR, file), 0o755);
    }
    // Legal: usage-fetch.js (read the Claude.ai OAuth token, called Anthropic's
    // usage API) is no longer bundled — Anthropic's Claude Code terms forbid
    // third-party apps from using that token. The copy loop above only adds and
    // overwrites, so remove the copy earlier app versions staged here; nothing
    // runs it any more, but no token-reading code should be left on disk.
    // Mirrors Bootstrap.kt on Android.
    try { fs.rmSync(path.join(STABLE_HOOK_DIR, 'usage-fetch.js'), { force: true }); } catch { /* best effort */ }
    // Trust the stable dir only if the critical script actually landed.
    if (fs.existsSync(path.join(STABLE_HOOK_DIR, 'relay.js'))) return STABLE_HOOK_DIR;
  } catch (e) {
    console.warn('install-hooks: failed to stage hook scripts to ' + STABLE_HOOK_DIR + ':', e.message);
  }
  // Fallback: a volatile path is still better than a missing one.
  return HOOK_SRC_DIR;
}

const HOOK_DIR = resolveHookDir();
const RELAY_PATH = path.join(HOOK_DIR, 'relay.js');
const BLOCKING_RELAY_PATH = path.join(HOOK_DIR, 'relay-blocking.js');

// Fire-and-forget events use the standard relay
const FIRE_AND_FORGET_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Stop',
  'UserPromptSubmit',
  'SessionStart',
  'SessionEnd',
  'Notification',
  'SubagentStart',
  'SubagentStop',
];

function installHooks() {
  let settings = {};
  if (fs.existsSync(SETTINGS_PATH)) {
    settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  const expectedRelayCmd = `node ${JSON.stringify(RELAY_PATH)}`;
  const expectedBlockingCmd = `node ${JSON.stringify(BLOCKING_RELAY_PATH)}`;

  // Register fire-and-forget events with standard relay
  for (const event of FIRE_AND_FORGET_EVENTS) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [];
    }

    // Find any existing relay hook (may have a stale path from a previous install)
    const existingIdx = settings.hooks[event].findIndex((matcher) =>
      matcher.hooks?.some((h) => h.command?.includes('relay.js') && !h.command?.includes('relay-blocking.js'))
    );

    const relayEntry = {
      matcher: '',
      hooks: [{ type: 'command', command: expectedRelayCmd, timeout: 10 }],
    };

    if (existingIdx >= 0) {
      // Update in place — preserves position relative to other hooks
      settings.hooks[event][existingIdx] = relayEntry;
    } else {
      settings.hooks[event].push(relayEntry);
    }
  }

  // Register PermissionRequest with blocking relay (longer timeout for user response)
  if (!settings.hooks['PermissionRequest']) {
    settings.hooks['PermissionRequest'] = [];
  }

  // Remove any old fire-and-forget relay for PermissionRequest
  settings.hooks['PermissionRequest'] = settings.hooks['PermissionRequest'].filter((matcher) =>
    !matcher.hooks?.some((h) => h.command?.includes('relay.js') && !h.command?.includes('relay-blocking.js'))
  );

  const blockingEntry = {
    matcher: '',
    hooks: [{ type: 'command', command: expectedBlockingCmd, timeout: 300 }],
  };

  const existingBlockingIdx = settings.hooks['PermissionRequest'].findIndex((matcher) =>
    matcher.hooks?.some((h) => h.command?.includes('relay-blocking.js'))
  );

  if (existingBlockingIdx >= 0) {
    settings.hooks['PermissionRequest'][existingBlockingIdx] = blockingEntry;
  } else {
    settings.hooks['PermissionRequest'].push(blockingEntry);
  }

  // --- Auto-titling hook ---
  // Always use the app-bundled title-update script (app owns session naming),
  // resolved via the stable hook dir so it survives across AppImage launches.
  const activeTitlePath = path.join(HOOK_DIR, 'title-update.sh');

  if (!settings.hooks['PostToolUse']) {
    settings.hooks['PostToolUse'] = [];
  }

  const titleCmd = `bash ${JSON.stringify(activeTitlePath)}`;
  const titleEntry = {
    matcher: '',
    hooks: [{ type: 'command', command: titleCmd, timeout: 10 }],
  };

  const existingTitleIdx = settings.hooks['PostToolUse'].findIndex((matcher) =>
    matcher.hooks?.some((h) => h.command?.includes('title-update'))
  );

  if (existingTitleIdx >= 0) {
    settings.hooks['PostToolUse'][existingTitleIdx] = titleEntry;
  } else {
    settings.hooks['PostToolUse'].push(titleEntry);
  }

  // Deploy Auto-Title instruction to CLAUDE.md if not already present
  const claudeMdPath = path.join(require('os').homedir(), '.claude', 'CLAUDE.md');
  const autoTitleMarker = '## Auto-Title';
  const autoTitleInstruction = `
## Auto-Title

When you see an \`[Auto-Title]\` reminder, do exactly what it asks, before continuing your response. If it says the conversation has no title yet, use Bash to write a 3-5 word Title Case summary to the file path it names. If it tells you the current title and that title still describes the conversation, do nothing at all — no tool call, no comment.
`;
  try {
    if (fs.existsSync(claudeMdPath)) {
      const content = fs.readFileSync(claudeMdPath, 'utf8');
      if (!content.includes(autoTitleMarker)) {
        fs.appendFileSync(claudeMdPath, autoTitleInstruction);
      }
    } else {
      fs.mkdirSync(path.dirname(claudeMdPath), { recursive: true });
      fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n' + autoTitleInstruction);
    }
  } catch (e) {
    console.warn('Failed to deploy Auto-Title instruction:', e.message);
  }

  // --- Write-guard hook ---
  // PreToolUse on Write|Edit matchers. Blocks concurrent writes to tracked
  // files when another active Claude session last modified them. Absorbed
  // from youcoded-core as part of toolkit deprecation (2026-04).
  const rawWriteGuardPath = path.resolve(__dirname, '..', 'hook-scripts', 'write-guard.sh');
  const unpackedWriteGuardPath = rawWriteGuardPath.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  const activeWriteGuardPath = fs.existsSync(unpackedWriteGuardPath) ? unpackedWriteGuardPath : rawWriteGuardPath;

  if (!settings.hooks['PreToolUse']) {
    settings.hooks['PreToolUse'] = [];
  }

  const writeGuardCmd = `bash ${JSON.stringify(activeWriteGuardPath)}`;
  const writeGuardEntry = {
    matcher: 'Write|Edit',
    hooks: [{ type: 'command', command: writeGuardCmd, timeout: 10 }],
  };

  const existingWriteGuardIdx = settings.hooks['PreToolUse'].findIndex((matcher) =>
    matcher.hooks?.some((h) => h.command?.includes('write-guard.sh'))
  );

  if (existingWriteGuardIdx >= 0) {
    settings.hooks['PreToolUse'][existingWriteGuardIdx] = writeGuardEntry;
  } else {
    settings.hooks['PreToolUse'].push(writeGuardEntry);
  }

  // --- Remove done-sound.sh (app handles completion sounds natively) ---
  if (settings.hooks['Stop']) {
    settings.hooks['Stop'] = settings.hooks['Stop'].filter((matcher) =>
      !matcher.hooks?.some((h) => h.command?.includes('done-sound'))
    );
  }

  // --- Statusline ---
  // Always use the app-bundled statusline script (app owns context % display).
  // Only set if unset or pointing to a known youcoded-core/app path — don't overwrite
  // custom user scripts.
  const activeStatuslinePath = path.join(HOOK_DIR, 'statusline.sh');
  const currentStatuslineCmd = settings.statusLine?.command || '';
  const isOurStatusline = !currentStatuslineCmd
    || currentStatuslineCmd.includes('statusline.sh')
    || currentStatuslineCmd.includes('youcoded-core')
    || currentStatuslineCmd.includes('youcoded');

  if (isOurStatusline) {
    settings.statusLine = {
      type: 'command',
      command: `bash ${JSON.stringify(activeStatuslinePath)}`,
    };
  }

  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2));
  console.log('Hooks installed for ' + FIRE_AND_FORGET_EVENTS.length + ' fire-and-forget events + PermissionRequest (blocking) + auto-title + statusline + write-guard');
}

installHooks();
