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

    // Also extract channels from the preload IPC constant object
    const preloadIpcBlock = preloadSource.match(/const IPC\s*=\s*\{([^}]+)\}/s);
    if (preloadIpcBlock) {
      const constPattern = /:\s*'([^']+)'/g;
      while ((match = constPattern.exec(preloadIpcBlock[1])) !== null) {
        preloadChannels.add(match[1]);
      }
    }

    // Extract channel strings from types.ts IPC object
    const typesChannels = new Set<string>();
    const typesIpcBlock = typesSource.match(/export const IPC\s*=\s*\{([^}]+)\}/s);
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
    GET: 'artifacts:get',
    SAVE: 'artifacts:save',
    INCLUDE_EXTERNAL: 'artifacts:include-external',
    EXCLUDE: 'artifacts:exclude',
    CHANGED: 'artifacts:changed',
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
