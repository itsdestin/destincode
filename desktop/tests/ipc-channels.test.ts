import { describe, test, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// This test verifies that IPC channel constants in preload.ts match shared/types.ts.
// Preload can't import from shared/types due to Electron sandbox restrictions,
// so channel names are duplicated. This test catches drift.

describe('IPC channel consistency', () => {
  test('preload channel names match shared/types.ts', () => {
    const preloadSource = fs.readFileSync(
      path.join(__dirname, '../src/main/preload.ts'), 'utf8'
    );
    const typesSource = fs.readFileSync(
      path.join(__dirname, '../src/shared/types.ts'), 'utf8'
    );

    // Extract channel strings from preload (pattern: 'channel-name' in ipcRenderer calls)
    const preloadChannels = new Set<string>();
    const ipcPattern = /ipcRenderer\.\w+\('([^']+)'/g;
    let match;
    while ((match = ipcPattern.exec(preloadSource)) !== null) {
      preloadChannels.add(match[1]);
    }

    // Also extract channels from the preload IPC constant object.
    // Anchor the capture to the block's `} as const;` terminator at line start —
    // the old `[^}]+` pattern stopped at the FIRST `}`, which occurs inside a
    // mid-block comment ("Caller passes a {x,y} offset"), silently truncating
    // the extracted block to ~1/3 of its keys and skipping the parity check
    // for everything after it.
    const preloadIpcBlock = preloadSource.match(/const IPC\s*=\s*\{([\s\S]*?)\n\} as const;/);
    if (preloadIpcBlock) {
      const constPattern = /:\s*'([^']+)'/g;
      while ((match = constPattern.exec(preloadIpcBlock[1])) !== null) {
        preloadChannels.add(match[1]);
      }
    }

    // Extract channel strings from types.ts IPC object. Same terminator-anchored
    // pattern as the preload extraction above — the types block has no stray `}`
    // today, but a future comment containing one would silently truncate it too.
    const typesChannels = new Set<string>();
    const typesIpcBlock = typesSource.match(/export const IPC\s*=\s*\{([\s\S]*?)\n\} as const;/);
    if (typesIpcBlock) {
      const typesPattern = /:\s*'([^']+)'/g;
      while ((match = typesPattern.exec(typesIpcBlock[1])) !== null) {
        typesChannels.add(match[1]);
      }
    }

    // Every preload channel should exist in types (or be a dynamic/ad-hoc channel)
    const missing = [...preloadChannels].filter(ch =>
      !typesChannels.has(ch) && !ch.includes(':output:')
    );

    // This is informational — log drift rather than hard-fail, since preload
    // may legitimately have channels not in the IPC enum (dynamic channels, etc.)
    if (missing.length > 0) {
      console.warn('Channels in preload.ts but not in shared/types.ts:', missing);
    }

    // Both files should define the same core IPC constant object keys
    const preloadIpcKeys = new Set<string>();
    if (preloadIpcBlock) {
      const keyPattern = /(\w+)\s*:/g;
      while ((match = keyPattern.exec(preloadIpcBlock[1])) !== null) {
        preloadIpcKeys.add(match[1]);
      }
    }

    const typesIpcKeys = new Set<string>();
    if (typesIpcBlock) {
      const keyPattern = /(\w+)\s*:/g;
      while ((match = keyPattern.exec(typesIpcBlock[1])) !== null) {
        typesIpcKeys.add(match[1]);
      }
    }

    // Channels defined in preload's IPC object should all exist in types' IPC object
    const missingKeys = [...preloadIpcKeys].filter(k => !typesIpcKeys.has(k));
    if (missingKeys.length > 0) {
      console.warn('IPC keys in preload but not in types:', missingKeys);
    }

    // Verify that the channel values match for shared keys
    for (const key of preloadIpcKeys) {
      if (!typesIpcKeys.has(key)) continue;

      const preloadVal = preloadIpcBlock?.[1].match(new RegExp(`${key}\\s*:\\s*'([^']+)'`));
      const typesVal = typesIpcBlock?.[1].match(new RegExp(`${key}\\s*:\\s*'([^']+)'`));

      if (preloadVal && typesVal) {
        expect(preloadVal[1]).toBe(typesVal[1]);
      }
    }
  });
});

// Regression net for the dev:* IPC channels introduced by the
// Settings → Development feature. All three platforms must carry identical
// type strings.
describe('dev:* channel parity', () => {
  const NEW_TYPES = [
    'dev:log-tail',
    'dev:diagnostics',
    'dev:summarize-issue',
    'dev:submit-issue',
    'dev:install-workspace',
    'dev:install-progress',
    'dev:open-session-in',
  ];

  it('all dev:* types are declared in preload.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.ts'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });

  it('all dev:* types are referenced in remote-shim.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'remote-shim.ts'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });

  it('all dev:* types are handled by SessionService.kt (Android)', () => {
    const ktPath = path.join(
      __dirname, '..', '..', 'app', 'src', 'main', 'kotlin',
      'com', 'youcoded', 'app', 'runtime', 'SessionService.kt',
    );
    const src = fs.readFileSync(ktPath, 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`"${t}"`);
  });
});

// Regression net for the account:* IPC channels introduced by the
// Accounts Phase 1 (client account surface) plan. All four surfaces must
// carry identical type strings — drift would silently break sign-in / profile
// on one platform. Also guards against any leftover marketplace:auth:* strings
// (the pre-rename prefix) in the three desktop TS sources.
describe('account:* channel parity', () => {
  const NEW_TYPES = [
    'account:start', 'account:poll', 'account:signed-in', 'account:user',
    'account:refresh', 'account:sign-out', 'account:update-profile', 'account:set-handle', 'account:delete',
    // Accounts Phase 2 — data export lives in the account group across all four surfaces.
    'account:export',
  ];
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  it('all account:* types are declared in preload.ts', () => {
    const src = read('src', 'main', 'preload.ts');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });
  it('all account:* types are referenced in remote-shim.ts', () => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });
  it('all account:* types are handled in marketplace-api-handlers.ts', () => {
    const src = read('src', 'main', 'marketplace-api-handlers.ts');
    for (const t of NEW_TYPES) expect(src).toContain(`"${t}"`);
  });
  it('all account:* types are handled by SessionService.kt (Android)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`"${t}"`);
  });
  it('no marketplace:auth:* strings remain anywhere', () => {
    for (const p of [['src','main','preload.ts'],['src','renderer','remote-shim.ts'],['src','main','marketplace-api-handlers.ts']] as const) {
      expect(read(...p)).not.toContain('marketplace:auth:');
    }
  });
});

// Regression net for the social:* IPC channels introduced by the Accounts
// Phase 2 (client social graph) plan — friends, requests, blocks. All four
// surfaces must carry identical type strings; drift would silently break the
// friends UI on one platform. The channel strings are asserted in preload.ts +
// remote-shim.ts (single-quoted) and social-handlers.ts + SessionService.kt
// (double-quoted). account:export is NOT here — it rides the account:* describe.
describe('social:* channel parity', () => {
  const NEW_TYPES = [
    'social:lookup-handle', 'social:send-request', 'social:list-requests',
    'social:accept-request', 'social:decline-request', 'social:cancel-request',
    'social:list-friends', 'social:unfriend', 'social:block', 'social:unblock',
    'social:list-blocks',
    // Presence socket (Task 6). The three invoke channels + the one push channel.
    // social:presence-event's desktop-main surface is social-handlers.ts (the
    // broadcaster), so the standard four-file assertion holds for all four.
    'social:presence-connect', 'social:presence-disconnect', 'social:presence-send',
    'social:presence-event',
  ];
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  it('all social:* types are declared in preload.ts', () => {
    const src = read('src', 'main', 'preload.ts');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });
  it('all social:* types are referenced in remote-shim.ts', () => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });
  it('all social:* types are handled in social-handlers.ts', () => {
    const src = read('src', 'main', 'social-handlers.ts');
    for (const t of NEW_TYPES) expect(src).toContain(`"${t}"`);
  });
  it('all social:* types are handled by SessionService.kt (Android)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`"${t}"`);
  });
});

// Regression net for terminal:get-screen-text, introduced by the
// android-terminal-data-parity plan (Task 7/9/10). All four surfaces
// (preload.ts, remote-shim.ts, ipc-handlers.ts, SessionService.kt) must
// carry identical type strings — drift would silently break the PTY
// buffer classifier on one platform.
describe('terminal:get-screen-text channel parity', () => {
  const CHANNEL = 'terminal:get-screen-text';

  it('terminal:get-screen-text is declared in preload.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.ts'), 'utf8');
    expect(src).toContain(`'${CHANNEL}'`);
  });

  it('terminal:get-screen-text is referenced in remote-shim.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'remote-shim.ts'), 'utf8');
    expect(src).toContain(`'${CHANNEL}'`);
  });

  it('terminal:get-screen-text is referenced in ipc-handlers.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc-handlers.ts'), 'utf8');
    expect(src).toContain(`'${CHANNEL}'`);
  });

  it('terminal:get-screen-text is handled by SessionService.kt (Android)', () => {
    const ktPath = path.join(
      __dirname, '..', '..', 'app', 'src', 'main', 'kotlin',
      'com', 'youcoded', 'app', 'runtime', 'SessionService.kt',
    );
    const src = fs.readFileSync(ktPath, 'utf8');
    expect(src).toContain(`"${CHANNEL}"`);
  });
});

// Regression net for pty:raw-bytes. Tier 1 introduced the Android broadcaster;
// Tier 2 (xterm-in-WebView) added the desktop-side consumer surfaces. Three
// surfaces must carry identical type strings — drift would silently break the
// xterm-on-Android renderer. ipc-handlers.ts is intentionally NOT in this list:
// pty:raw-bytes is a push event from Android via WebSocket, not a request-
// response handler, and there is no desktop sender (Electron PTY emits
// pty:output strings instead).
describe('pty:raw-bytes channel parity', () => {
  const CHANNEL = 'pty:raw-bytes';

  it('pty:raw-bytes is declared in preload.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.ts'), 'utf8');
    expect(src).toContain(`'${CHANNEL}'`);
  });

  it('pty:raw-bytes is referenced in remote-shim.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'remote-shim.ts'), 'utf8');
    expect(src).toContain(`'${CHANNEL}'`);
  });

  it('pty:raw-bytes is broadcast by SessionService.kt (Android)', () => {
    const ktPath = path.join(
      __dirname, '..', '..', 'app', 'src', 'main', 'kotlin',
      'com', 'youcoded', 'app', 'runtime', 'SessionService.kt',
    );
    const src = fs.readFileSync(ktPath, 'utf8');
    expect(src).toContain(`"${CHANNEL}"`);
  });
});

// Regression net for the update:changelog IPC channel introduced by the
// UpdatePanel popup feature. All three platforms must carry identical
// type strings — drift would silently break changelog fetch on one side.
describe('update:changelog channel parity', () => {
  const NEW_TYPES = [
    'update:changelog',
  ];

  it('update:changelog type is declared in preload.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.ts'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });

  it('update:changelog type is referenced in remote-shim.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'remote-shim.ts'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });

  it('update:changelog type is handled by SessionService.kt (Android)', () => {
    const ktPath = path.join(
      __dirname, '..', '..', 'app', 'src', 'main', 'kotlin',
      'com', 'youcoded', 'app', 'runtime', 'SessionService.kt',
    );
    const src = fs.readFileSync(ktPath, 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`"${t}"`);
  });
});

// Regression net for the analytics:* IPC channels introduced by the
// privacy-analytics plan (anonymous install + DAU/MAU telemetry opt-out).
// All three platforms must carry identical type strings. The Android
// assertion is intentionally expected to fail until Phase 7 (SessionService.kt
// analytics:* handlers) lands. Not a regression — the desktop IPC landing
// ahead of Android is the planned integration order.
describe('analytics:* channel parity', () => {
  const NEW_TYPES = [
    'analytics:get-opt-in',
    'analytics:set-opt-in',
  ];

  it('both analytics:* types are declared in preload.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.ts'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });

  it('both analytics:* types are referenced in remote-shim.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'remote-shim.ts'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });

  // WHY: This assertion is intentionally failing until Phase 7 adds the
  // SessionService.kt analytics:* handlers. It acts as the regression net —
  // when Phase 7 lands, this turns green and confirms Android parity is
  // complete.
  it('both analytics:* types are handled by SessionService.kt (Android)', () => {
    const ktPath = path.join(
      __dirname, '..', '..', 'app', 'src', 'main', 'kotlin',
      'com', 'youcoded', 'app', 'runtime', 'SessionService.kt',
    );
    const src = fs.readFileSync(ktPath, 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`"${t}"`);
  });
});

// Regression net for system:back and system:notify-stack-state introduced by the
// android-back-button implementation. system:notify-stack-state flows React → Android
// (via SessionService.handleBridgeMessage). system:back flows Android → React
// (broadcast by MainActivity, subscribed in remote-shim). Both channel names must
// appear literally in their respective files — drift would silently break back-button
// support on one platform.
describe('system:back and system:notify-stack-state parity', () => {
  test('system:notify-stack-state appears in preload.ts, types.ts, remote-shim.ts, SessionService.kt', () => {
    const stackStateSites = {
      'preload.ts': fs.readFileSync(path.join(__dirname, '../src/main/preload.ts'), 'utf8'),
      'types.ts': fs.readFileSync(path.join(__dirname, '../src/shared/types.ts'), 'utf8'),
      'remote-shim.ts': fs.readFileSync(path.join(__dirname, '../src/renderer/remote-shim.ts'), 'utf8'),
      'SessionService.kt': fs.readFileSync(
        path.join(__dirname, '../../app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt'),
        'utf8',
      ),
    };

    const channel = 'system:notify-stack-state';
    for (const [siteName, source] of Object.entries(stackStateSites)) {
      expect(source, `expected '${channel}' to appear in ${siteName}`).toContain(channel);
    }
  });

  test('system:back appears in preload.ts, types.ts, remote-shim.ts, MainActivity.kt', () => {
    const backSites = {
      'preload.ts': fs.readFileSync(path.join(__dirname, '../src/main/preload.ts'), 'utf8'),
      'types.ts': fs.readFileSync(path.join(__dirname, '../src/shared/types.ts'), 'utf8'),
      'remote-shim.ts': fs.readFileSync(path.join(__dirname, '../src/renderer/remote-shim.ts'), 'utf8'),
      'MainActivity.kt': fs.readFileSync(
        path.join(__dirname, '../../app/src/main/kotlin/com/youcoded/app/MainActivity.kt'),
        'utf8',
      ),
    };

    const channel = 'system:back';
    for (const [siteName, source] of Object.entries(backSites)) {
      expect(source, `expected '${channel}' to appear in ${siteName}`).toContain(channel);
    }
  });
});

describe('performance:* and app:restart parity', () => {
  const channels = ['performance:get-config', 'performance:set-config', 'app:restart'];

  it('all three types are declared in preload.ts', () => {
    const preload = fs.readFileSync(
      path.join(__dirname, '../src/main/preload.ts'), 'utf8'
    );
    for (const ch of channels) {
      expect(preload, `${ch} missing from preload.ts`).toContain(`'${ch}'`);
    }
  });

  it('all three types are referenced in remote-shim.ts', () => {
    const shim = fs.readFileSync(
      path.join(__dirname, '../src/renderer/remote-shim.ts'), 'utf8'
    );
    for (const ch of channels) {
      expect(shim, `${ch} missing from remote-shim.ts`).toContain(`'${ch}'`);
    }
  });

  it('all three types are handled by SessionService.kt (Android)', () => {
    const kt = fs.readFileSync(
      path.join(__dirname, '../../app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt'),
      'utf8'
    );
    for (const ch of channels) {
      expect(kt, `${ch} missing from SessionService.kt`).toContain(`"${ch}"`);
    }
  });
});

// Regression net for artifact:* IPC channels introduced by the artifact-viewer
// subsystem (Phase 2). All four surfaces (preload.ts, remote-shim.ts,
// ipc-handlers.ts, SessionService.kt) must carry identical type strings for
// request-response channels. The push event 'artifacts:changed' does NOT need
// an ipcMain.handle — it broadcasts from main to renderer only. Phase 8 will
// add SessionService.kt handlers; until then, those assertions are expected to
// fail as a tracker for when Android parity lands.
describe('artifact IPC parity', () => {
  // Dynamically read the ipc-channels.ts file and extract the channel values
  const ipcChannelsSource = fs.readFileSync(
    path.join(__dirname, '../src/main/artifacts/ipc-channels.ts'), 'utf8'
  );
  // Extract all string values from ARTIFACT_IPC object (pattern: : 'channel-name')
  const channelMatches = [...ipcChannelsSource.matchAll(/'([^']+)'/g)];
  const channels = channelMatches
    .map(m => m[1])
    .filter((v, i, a) => a.indexOf(v) === i); // deduplicate

  // Build a reverse lookup mapping channel string → constant name
  // for recognizing constant references (e.g., ARTIFACT_IPC.LIST_SESSION) in ipc-handlers.ts
  const CHANNEL_TO_CONST = Object.entries({
    LIST_SESSION: 'artifacts:list-session',
    LIST_PROJECT: 'artifacts:list-project',
    LIST_ALL_FILES: 'artifacts:list-all-files',
    LIST_PROJECTS_INDEX: 'artifacts:list-projects-index',
    GET: 'artifacts:get',
    READ_BINARY: 'artifacts:read-binary',
    SAVE: 'artifacts:save',
    // Fix: data-flow gap — new channel that wires renderer Tracker → central index
    APPEND_VERSION: 'artifacts:append-version',
    INCLUDE_EXTERNAL: 'artifacts:include-external',
    EXCLUDE: 'artifacts:exclude',
    CHANGED: 'artifacts:changed',
    // Task 7.3: project deletion
    DELETE_PROJECT: 'artifacts:delete-project',
    // Existence check folds "file not on disk" into the deleted UI state.
    CHECK_EXISTENCE: 'artifacts:check-existence',
    // Rename a file on disk + update the sidecar record.
    RENAME: 'artifacts:rename',
  }).reduce<Record<string, string>>((acc, [name, value]) => {
    acc[value] = `ARTIFACT_IPC.${name}`;
    return acc;
  }, {});

  // Resolve paths relative to the desktop directory (where vitest is invoked from)
  const preload = fs.readFileSync('src/main/preload.ts', 'utf8');
  const shim = fs.readFileSync('src/renderer/remote-shim.ts', 'utf8');
  const handlers = fs.readFileSync('src/main/ipc-handlers.ts', 'utf8');

  // Kotlin file lives in the sibling app/ directory of the youcoded sub-repo
  const kotlinPath = path.join(__dirname, '../../app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt');
  const kotlinExists = fs.existsSync(kotlinPath);
  const kotlin = kotlinExists ? fs.readFileSync(kotlinPath, 'utf8') : '';

  for (const channel of channels) {
    it(`channel ${channel} is referenced in preload.ts`, () => {
      expect(preload, `${channel} missing from preload.ts`).toContain(channel);
    });

    it(`channel ${channel} is referenced in remote-shim.ts`, () => {
      expect(shim, `${channel} missing from remote-shim.ts`).toContain(channel);
    });

    if (channel !== 'artifacts:changed') {
      // Push events don't need an ipcMain.handle — only request/response channels do
      it(`channel ${channel} is registered in ipc-handlers.ts`, () => {
        // ipc-handlers.ts may use the channel as a literal string OR as a constant reference
        // (e.g., ARTIFACT_IPC.LIST_SESSION), so accept either form
        const literalForm = handlers.includes(channel);
        const constForm = handlers.includes(CHANNEL_TO_CONST[channel]);
        expect(literalForm || constForm, `${channel} missing from ipc-handlers.ts`).toBe(true);
      });
    }

    // Phase 8: Expected to fail until Android handlers land; left in place as a tracker
    it(`channel ${channel} is registered in SessionService.kt`, () => {
      if (kotlinExists) {
        expect(kotlin, `${channel} missing from SessionService.kt`).toContain(channel);
      } else {
        // App directory not present in this worktree yet (Phase 8 pending)
        console.warn(`SessionService.kt not found at ${kotlinPath} — skipping Android parity check`);
      }
    });
  }
});

// Regression net for the project:* IPC channels (Project View redesign).
// Desktop is authoritative in v1; SessionService.kt carries stub cases so the
// type strings stay in parity (handlers return not-implemented-on-mobile).
// ipc-handlers.ts references PROJECT_IPC.* constants rather than literal
// strings (same convention as ARTIFACT_IPC), so that assertion accepts either.
describe('project:* channel parity', () => {
  const CHANNEL_TO_CONST: Record<string, string> = {
    'project:list-conversations': 'PROJECT_IPC.LIST_CONVERSATIONS',
    'project:conversation-history': 'PROJECT_IPC.CONVERSATION_HISTORY',
    'project:repo-info': 'PROJECT_IPC.REPO_INFO',
    'project:list-context': 'PROJECT_IPC.LIST_CONTEXT',
    'project:read-context-file': 'PROJECT_IPC.READ_CONTEXT_FILE',
    'project:write-context-file': 'PROJECT_IPC.WRITE_CONTEXT_FILE',
  };
  const NEW_TYPES = Object.keys(CHANNEL_TO_CONST);

  it('declared in preload.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'preload.ts'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });
  it('referenced in remote-shim.ts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'remote-shim.ts'), 'utf8');
    for (const t of NEW_TYPES) expect(src).toContain(`'${t}'`);
  });
  it('registered in ipc-handlers.ts (literal or PROJECT_IPC constant)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'main', 'ipc-handlers.ts'), 'utf8');
    for (const t of NEW_TYPES) {
      const literal = src.includes(`'${t}'`);
      const constRef = src.includes(CHANNEL_TO_CONST[t]);
      expect(literal || constRef, `${t} missing from ipc-handlers.ts`).toBe(true);
    }
  });
  it('stubbed in SessionService.kt (Android)', () => {
    const kt = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    for (const t of NEW_TYPES) expect(kt).toContain(`"${t}"`);
  });
});

// Cross-device sync spaces (spec 2026-07-03). Desktop-only in Phase 1a — no
// Android surface yet — so parity is asserted across the four DESKTOP surfaces:
// preload.ts, remote-shim.ts, ipc-handlers.ts, and remote-server.ts. preload
// (inlined IPC object), remote-shim (invoke literal), and remote-server (switch
// case) carry the literal string; ipc-handlers registers via the IPC.* constant
// (matching the existing sync:* handlers), so its check maps to the constant
// name — same "accepts the constant form" pattern as the artifact parity test.
describe('syncspaces:* channel parity (desktop surfaces)', () => {
  const channels: Array<[string, string]> = [
    ['syncspaces:status', 'IPC.SYNC_SPACES_STATUS'],
    ['syncspaces:enable', 'IPC.SYNC_SPACES_ENABLE'],
    ['syncspaces:sync-now', 'IPC.SYNC_SPACES_SYNC_NOW'],
    ['syncspaces:create-project', 'IPC.SYNC_SPACES_CREATE_PROJECT'],
    ['syncspaces:import-project', 'IPC.SYNC_SPACES_IMPORT_PROJECT'],
    ['syncspaces:rename-project', 'IPC.SYNC_SPACES_RENAME_PROJECT'],
    ['syncspaces:stop-project', 'IPC.SYNC_SPACES_STOP_PROJECT'],
    // Plan 2b Task 11 — conversation leases + device registry. Full four-surface
    // desktop parity (preload / remote-shim / ipc-handlers constant / remote-server).
    ['syncspaces:lease-query', 'IPC.SYNC_SPACES_LEASE_QUERY'],
    ['syncspaces:lease-takeover', 'IPC.SYNC_SPACES_LEASE_TAKEOVER'],
    ['syncspaces:lease-force', 'IPC.SYNC_SPACES_LEASE_FORCE'],
    ['syncspaces:list-devices', 'IPC.SYNC_SPACES_LIST_DEVICES'],
    ['syncspaces:rename-device', 'IPC.SYNC_SPACES_RENAME_DEVICE'],
  ];
  const preload = fs.readFileSync(path.join(__dirname, '../src/main/preload.ts'), 'utf8');
  const shim = fs.readFileSync(path.join(__dirname, '../src/renderer/remote-shim.ts'), 'utf8');
  const handlers = fs.readFileSync(path.join(__dirname, '../src/main/ipc-handlers.ts'), 'utf8');
  const remoteServer = fs.readFileSync(path.join(__dirname, '../src/main/remote-server.ts'), 'utf8');
  for (const [ch, constant] of channels) {
    it(`${ch} present in preload, remote-shim, ipc-handlers, remote-server`, () => {
      expect(preload).toContain(ch);
      expect(shim).toContain(ch);
      expect(handlers).toContain(constant);
      expect(remoteServer).toContain(ch);
    });
  }
  it('syncspaces:event push channel present in preload + remote-shim', () => {
    expect(preload).toContain('syncspaces:event');
    expect(shim).toContain('syncspaces:event');
  });

  // Plan 2b Task 11 — the five lease/device REQUEST channels also have an Android
  // stub (SessionService.kt returns not-implemented-on-mobile) so a mobile invoke
  // rejects fast instead of 30s-timing-out. Assert the Kotlin stub covers all five.
  const kotlinPath = path.join(__dirname, '../../app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt');
  const leaseDeviceRequestChannels = [
    'syncspaces:lease-query',
    'syncspaces:lease-takeover',
    'syncspaces:lease-force',
    'syncspaces:list-devices',
    'syncspaces:rename-device',
  ];
  if (fs.existsSync(kotlinPath)) {
    const kotlin = fs.readFileSync(kotlinPath, 'utf8');
    for (const ch of leaseDeviceRequestChannels) {
      it(`${ch} has an Android not-implemented-on-mobile stub in SessionService.kt`, () => {
        expect(kotlin).toContain(`"${ch}"`);
      });
    }
  } else {
    it.skip('SessionService.kt not found — skipping Android lease/device stub check', () => {});
  }

  // session:moved is a PUSH event (Task 8 broadcasts it), NOT a request — so it
  // has no ipc-handlers/Kotlin request handler. Assert only the two surfaces that
  // CONSUME it: preload (ipcRenderer.on) + remote-shim (addListener push routing).
  it('session:moved push channel present in preload + remote-shim', () => {
    expect(preload).toContain('session:moved');
    expect(shim).toContain('session:moved');
  });
});

// Connect-GitHub modal (device-flow auth, 2026-07-14). The four REQUEST channels
// have full four-surface desktop parity (preload inlined literal / remote-shim
// invoke literal / ipc-handlers IPC.* constant / remote-server switch case) plus
// an Android not-implemented-on-mobile stub so a mobile invoke rejects fast. The
// github:connect-done PUSH event is asserted only where it's CONSUMED (preload +
// remote-shim) — same treatment as session:moved.
describe('github:* channel parity (desktop surfaces)', () => {
  const channels: Array<[string, string]> = [
    ['github:status', 'IPC.GITHUB_STATUS'],
    ['github:connect-start', 'IPC.GITHUB_CONNECT_START'],
    ['github:connect-cancel', 'IPC.GITHUB_CONNECT_CANCEL'],
    ['github:install-gh', 'IPC.GITHUB_INSTALL_GH'],
  ];
  const preload = fs.readFileSync(path.join(__dirname, '../src/main/preload.ts'), 'utf8');
  const shim = fs.readFileSync(path.join(__dirname, '../src/renderer/remote-shim.ts'), 'utf8');
  const handlers = fs.readFileSync(path.join(__dirname, '../src/main/ipc-handlers.ts'), 'utf8');
  const remoteServer = fs.readFileSync(path.join(__dirname, '../src/main/remote-server.ts'), 'utf8');
  for (const [ch, constant] of channels) {
    it(`${ch} present in preload, remote-shim, ipc-handlers, remote-server`, () => {
      expect(preload).toContain(ch);
      expect(shim).toContain(ch);
      expect(handlers).toContain(constant);
      expect(remoteServer).toContain(ch);
    });
  }

  // The four request channels also carry an Android stub (SessionService.kt
  // returns not-implemented-on-mobile) so a mobile invoke rejects fast.
  const kotlinPath = path.join(__dirname, '../../app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt');
  if (fs.existsSync(kotlinPath)) {
    const kotlin = fs.readFileSync(kotlinPath, 'utf8');
    for (const [ch] of channels) {
      it(`${ch} has an Android not-implemented-on-mobile stub in SessionService.kt`, () => {
        expect(kotlin).toContain(`"${ch}"`);
      });
    }
  } else {
    it.skip('SessionService.kt not found — skipping Android github stub check', () => {});
  }

  // github:connect-done is a PUSH event (main broadcasts it when the flow settles),
  // NOT a request — no Kotlin/ipc-handlers request handler. Assert only the two
  // surfaces that CONSUME it: preload (ipcRenderer.on) + remote-shim (dispatch).
  it('github:connect-done push channel present in preload + remote-shim', () => {
    expect(preload).toContain('github:connect-done');
    expect(shim).toContain('github:connect-done');
  });
});

// Native runtime capability flag (platform roadmap Phase 0 seam).
// preload and remote-shim must both expose window.claude.native.supported —
// the renderer gates the runtime selector on it without platform branching.
// It is a plain boolean (no IPC round-trip), so there is no ipc-handlers or
// SessionService.kt row — this describe pins shape parity only.
describe('native runtime capability parity', () => {
  it('preload.ts exposes native.supported', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/main/preload.ts'), 'utf8');
    expect(src).toMatch(/native:\s*\{/);
    expect(src).toMatch(/supported:/);
  });
  it('remote-shim.ts exposes native.supported: false', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/renderer/remote-shim.ts'), 'utf8');
    expect(src).toMatch(/native:\s*\{/);
    expect(src).toMatch(/supported:\s*false/);
  });
});

describe('native:*/provider:* channel parity', () => {
  const NEW_TYPES = [
    'native:send', 'native:interrupt', 'native:set-binding', 'native:sessions-list',
    'provider:list', 'provider:upsert', 'provider:remove', 'provider:test', 'provider:set-key', 'provider:catalog',
  ];
  const CHANNEL_TO_CONST: Record<string, string> = {
    'native:send': 'IPC.NATIVE_SEND', 'native:interrupt': 'IPC.NATIVE_INTERRUPT',
    'native:set-binding': 'IPC.NATIVE_SET_BINDING', 'native:sessions-list': 'IPC.NATIVE_SESSIONS_LIST',
    'provider:list': 'IPC.PROVIDER_LIST', 'provider:upsert': 'IPC.PROVIDER_UPSERT',
    'provider:remove': 'IPC.PROVIDER_REMOVE', 'provider:test': 'IPC.PROVIDER_TEST',
    'provider:set-key': 'IPC.PROVIDER_SET_KEY', 'provider:catalog': 'IPC.PROVIDER_CATALOG',
  };
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  it('exposed in preload.ts', () => {
    const src = read('src', 'main', 'preload.ts');
    for (const t of NEW_TYPES) expect(src.includes(`'${t}'`) || src.includes(CHANNEL_TO_CONST[t]), `${t} missing from preload.ts`).toBe(true);
  });
  it('exposed in remote-shim.ts', () => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const t of NEW_TYPES) expect(src, `${t} missing from remote-shim.ts`).toContain(`'${t}'`);
  });
  it('registered in ipc-handlers.ts (literal or IPC constant)', () => {
    const src = read('src', 'main', 'ipc-handlers.ts');
    for (const t of NEW_TYPES) expect(src.includes(`'${t}'`) || src.includes(CHANNEL_TO_CONST[t]), `${t} missing from ipc-handlers.ts`).toBe(true);
  });
  it('stubbed in SessionService.kt (Android)', () => {
    const kt = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    for (const t of NEW_TYPES) expect(kt, `${t} missing from SessionService.kt`).toContain(`"${t}"`);
  });
});

// Custom tags + per-session notes (session-tags feature).
// The channels must exist across all three parity surfaces so the shared
// React UI works identically on desktop (preload/Electron IPC), remote
// browsers (remote-shim/WebSocket), and Android (SessionService.kt).
describe('custom tags + notes channel parity', () => {
  const read = (rel: string) => fs.readFileSync(path.join(__dirname, rel), 'utf8');
  const preload = read('../src/main/preload.ts');
  const remoteShim = read('../src/renderer/remote-shim.ts');
  const sessionService = read('../../app/src/main/kotlin/com/youcoded/app/runtime/SessionService.kt');
  const channels = [
    'session:set-tag', 'session:set-note', 'session:get-meta',
    'tags:list', 'tags:create', 'tags:update', 'tags:delete',
  ];
  for (const ch of channels) {
    test(`${ch} present in preload, remote-shim, and SessionService.kt`, () => {
      expect(preload).toContain(ch);
      expect(remoteShim).toContain(ch);
      expect(sessionService).toContain(ch);
    });
  }
});

// Local llama.cpp engine (Plan B, Task 9). The engine:* IPC surface must carry
// identical channel strings across all four parity files. ipc-handlers.ts
// references the IPC.ENGINE_* CONSTANTS (not literal strings), so its assertion
// checks the constant identifiers. The two push channels are broadcast-only —
// no Kotlin handler, so SessionService.kt only stubs the request-response ones.
describe('engine:* channel parity (Plan B)', () => {
  const channels = ['engine:status', 'engine:install', 'engine:restart'];
  const pushChannels = ['engine:install-progress', 'engine:status-changed'];
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

  it('preload exposes every engine channel (request + push)', () => {
    const src = read('src', 'main', 'preload.ts');
    for (const ch of [...channels, ...pushChannels]) expect(src).toContain(`'${ch}'`);
  });
  it('remote-shim exposes every engine channel (request + push)', () => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const ch of [...channels, ...pushChannels]) expect(src).toContain(`'${ch}'`);
  });
  it('ipc-handlers registers every request-response engine channel', () => {
    const src = read('src', 'main', 'ipc-handlers.ts');
    for (const c of ['ENGINE_STATUS', 'ENGINE_INSTALL', 'ENGINE_RESTART']) expect(src).toContain(`IPC.${c}`);
  });
  it('SessionService.kt stubs every request-response engine channel', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    for (const ch of channels) expect(src).toContain(`"${ch}"`);
  });
});

// Self-contained like the engine:* describe (Amendment 2026-07-14 I): each test
// reads its own source. ipc-handlers uses the IPC.* CONSTANTS, so its check
// asserts the constant identifier — NOT the literal 'models:*' string, which
// never appears there and would always fail. Task 9 EXTENDS this `channels`
// array with ['engine:set-context','ENGINE_SET_CONTEXT'] when it wires the knob.
describe('models:* + engine:set-* channel parity (Plan C)', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const channels: Array<[string, string]> = [
    ['engine:set-backend', 'ENGINE_SET_BACKEND'],
    ['engine:set-context', 'ENGINE_SET_CONTEXT'],
    ['models:curated', 'MODELS_CURATED'],
    ['models:search', 'MODELS_SEARCH'],
    ['models:quants', 'MODELS_QUANTS'],
    ['models:download', 'MODELS_DOWNLOAD'],
    ['models:download-cancel', 'MODELS_DOWNLOAD_CANCEL'],
    ['models:delete', 'MODELS_DELETE'],
    ['models:installed', 'MODELS_INSTALLED'],
    ['endpoints:detect', 'ENDPOINTS_DETECT'],
  ];
  const pushChannels = ['models:download-progress'];

  it('preload exposes every channel (request + push)', () => {
    const src = read('src', 'main', 'preload.ts');
    for (const [ch] of channels) expect(src).toContain(`'${ch}'`);
    for (const ch of pushChannels) expect(src).toContain(`'${ch}'`);
  });
  it('remote-shim exposes every channel (request + push)', () => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const [ch] of channels) expect(src).toContain(`'${ch}'`);
    for (const ch of pushChannels) expect(src).toContain(`'${ch}'`);
  });
  it('ipc-handlers registers every request-response channel via its IPC.* constant', () => {
    const src = read('src', 'main', 'ipc-handlers.ts');
    for (const [, konst] of channels) expect(src).toContain(`IPC.${konst}`);
  });
  it('SessionService.kt stubs every request-response channel', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    for (const [ch] of channels) expect(src).toContain(`"${ch}"`);
  });
});

// Model memory lifecycle (2026-07-14): per-model residency push + memory guard
// + [Reload Model]. Same self-contained parity shape as the Plan B/C describes.
describe('model memory lifecycle channel parity (2026-07-14)', () => {
  const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const invokeChannels: Array<[string, string]> = [
    ['engine:models', 'ENGINE_MODELS'],
    ['models:memory-check', 'MODELS_MEMORY_CHECK'],
    ['models:load', 'MODELS_LOAD'],
  ];
  const pushChannels = ['engine:models-changed', 'native:model-state'];

  it('preload exposes every channel (request + push)', () => {
    const src = read('src', 'main', 'preload.ts');
    for (const [ch] of invokeChannels) expect(src).toContain(`'${ch}'`);
    for (const ch of pushChannels) expect(src).toContain(`'${ch}'`);
  });
  it('remote-shim exposes every channel (request + push)', () => {
    const src = read('src', 'renderer', 'remote-shim.ts');
    for (const [ch] of invokeChannels) expect(src).toContain(`'${ch}'`);
    for (const ch of pushChannels) expect(src).toContain(`'${ch}'`);
  });
  it('ipc-handlers registers every request-response channel via its IPC.* constant', () => {
    const src = read('src', 'main', 'ipc-handlers.ts');
    for (const [, konst] of invokeChannels) expect(src).toContain(`IPC.${konst}`);
  });
  it('SessionService.kt stubs every request-response channel', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'src', 'main', 'kotlin', 'com', 'youcoded', 'app', 'runtime', 'SessionService.kt'), 'utf8');
    for (const [ch] of invokeChannels) expect(src).toContain(`"${ch}"`);
  });
});
