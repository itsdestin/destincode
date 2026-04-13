# Drag Session to Detach Window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user drag a session pill out of the SessionStrip to spawn a new peer window owning that session, and drag it back into another window's strip to re-dock. Add a "Launch in New Window" toggle at session creation/resume as a non-drag entry point.

**Architecture:** Peer window model. Main process maintains a `WindowRegistry` (`sessionId → windowId`, `leaderWindowId`). Per-session IPC emits are routed via `routeToOwner(sessionId, channel, payload)`. Renderer state stays per-window; detach hydrates the new window by replaying transcript JSONL from disk. Cross-window cursor tracking uses `screen.getCursorScreenPoint()` at ~30Hz during an active drag.

**Tech Stack:** Electron (main), React + Vite (renderer), Vitest (tests), existing `SessionManager` / `TranscriptWatcher` / `HookRelay` / `SessionStrip`.

**Spec:** `desktop/docs/superpowers/specs/2026-04-12-drag-session-detach-window-design.md`

**Working directory for all commands:** `destincode/desktop/` unless otherwise noted.

---

## File Structure

**New files (main):**
- `src/main/window-registry.ts` — ownership map, leader tracking, directory broadcasts, routing helper

**New files (renderer):**
- `src/renderer/hooks/useCrossWindowDrag.ts` — pointer capture + cross-window cursor handling

**New files (tests):**
- `src/main/window-registry.test.ts`
- `src/renderer/state/chat-reducer.ownership.test.ts`

**Modified files (main):**
- `src/main/main.ts` — window creation via registry, IPC handlers for detach/drag/focus
- `src/main/ipc-handlers.ts` — wrap session-scoped emits with `routeToOwner(...)`
- `src/main/hook-relay.ts` — route `permission:request` via ownership registry
- `src/main/preload.ts` — new IPC channel constants
- `src/main/transcript-watcher.ts` — verify/extend `getHistory(sessionId)` replay

**Modified files (renderer):**
- `src/renderer/App.tsx` — ownership actions, window directory state, leader state
- `src/renderer/state/chat-reducer.ts` — `SESSION_OWNERSHIP_ACQUIRED` / `SESSION_OWNERSHIP_LOST`
- `src/renderer/components/SessionStrip.tsx` — drag out, drop target, two-group switcher
- `src/renderer/hooks/usePartyLobby.ts` — gate on `isLeader`
- `src/renderer/remote-shim.ts` — no-op stubs for detach IPC on Android
- `src/renderer/components/NewSessionDialog.tsx` (or wherever creation lives) — "Launch in new window" toggle
- `src/renderer/components/ResumeBrowser.tsx` — same toggle

**Shared:**
- `src/shared/types.ts` — `WindowInfo`, `WindowDirectoryEntry`, detach payload types

---

## Phase 1 — Core Ownership Model

### Task 1.1: Add shared types for window registry

**Files:**
- Modify: `src/shared/types.ts` (append)

- [ ] **Step 1: Add types**

Append to `src/shared/types.ts`:

```typescript
// --- Window registry / detach types ---

export interface WindowInfo {
  id: number;           // BrowserWindow webContentsId
  label: string;        // e.g. "window 2" (creation order)
  createdAt: number;
}

export interface WindowDirectoryEntry {
  window: WindowInfo;
  sessionIds: string[];
}

export interface WindowDirectory {
  leaderWindowId: number;
  windows: WindowDirectoryEntry[];
}

export interface SessionOwnershipAcquired {
  sessionId: string;
  sessionInfo: SessionInfo;
  /** True when the window was just created for this session (skip replay delay UI). */
  freshWindow: boolean;
}

export interface SessionOwnershipLost {
  sessionId: string;
}

export interface DetachStartPayload {
  sessionId: string;
  screenX: number;
  screenY: number;
}

export interface DragDroppedPayload {
  sessionId: string;
  targetWindowId: number;
  insertIndex: number;
}

export interface CrossWindowCursor {
  screenX: number;
  screenY: number;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/shared/types.ts
git commit -m "feat(types): add window registry and detach payloads"
```

---

### Task 1.2: Create WindowRegistry (main)

**Files:**
- Create: `src/main/window-registry.ts`
- Create: `src/main/window-registry.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/main/window-registry.test.ts`:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { WindowRegistry } from './window-registry';

describe('WindowRegistry', () => {
  let reg: WindowRegistry;
  beforeEach(() => { reg = new WindowRegistry(); });

  it('registers windows in creation order with ascending labels', () => {
    reg.registerWindow(100, Date.now());
    reg.registerWindow(101, Date.now() + 1);
    const dir = reg.getDirectory();
    expect(dir.windows.map(w => w.window.label)).toEqual(['window 1', 'window 2']);
  });

  it('first registered window is the leader', () => {
    reg.registerWindow(100, Date.now());
    reg.registerWindow(101, Date.now() + 1);
    expect(reg.getLeaderId()).toBe(100);
  });

  it('promotes next-oldest to leader when leader unregisters', () => {
    reg.registerWindow(100, 1);
    reg.registerWindow(101, 2);
    reg.registerWindow(102, 3);
    reg.unregisterWindow(100);
    expect(reg.getLeaderId()).toBe(101);
  });

  it('assignSession sets ownership and moves on reassign', () => {
    reg.registerWindow(100, 1);
    reg.registerWindow(101, 2);
    reg.assignSession('s1', 100);
    expect(reg.getOwner('s1')).toBe(100);
    reg.assignSession('s1', 101);
    expect(reg.getOwner('s1')).toBe(101);
  });

  it('releaseSession clears ownership', () => {
    reg.registerWindow(100, 1);
    reg.assignSession('s1', 100);
    reg.releaseSession('s1');
    expect(reg.getOwner('s1')).toBeUndefined();
  });

  it('unregisterWindow releases its sessions', () => {
    reg.registerWindow(100, 1);
    reg.registerWindow(101, 2);
    reg.assignSession('s1', 100);
    reg.assignSession('s2', 100);
    reg.unregisterWindow(100);
    expect(reg.getOwner('s1')).toBeUndefined();
    expect(reg.getOwner('s2')).toBeUndefined();
  });

  it('emits change event on every mutation', () => {
    const events: string[] = [];
    reg.on('changed', () => events.push('x'));
    reg.registerWindow(100, 1);
    reg.assignSession('s1', 100);
    reg.releaseSession('s1');
    reg.unregisterWindow(100);
    expect(events.length).toBe(4);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/main/window-registry.test.ts`
Expected: FAIL (module not found)

- [ ] **Step 3: Implement**

Create `src/main/window-registry.ts`:

```typescript
import { EventEmitter } from 'events';
import type { WindowInfo, WindowDirectory, WindowDirectoryEntry } from '../shared/types';

interface Entry {
  id: number;
  createdAt: number;
  label: string;
}

export class WindowRegistry extends EventEmitter {
  private windows = new Map<number, Entry>();
  private ownership = new Map<string, number>(); // sessionId -> windowId
  private nextLabelN = 1;

  registerWindow(id: number, createdAt: number): void {
    if (this.windows.has(id)) return;
    const label = `window ${this.nextLabelN++}`;
    this.windows.set(id, { id, createdAt, label });
    this.emit('changed');
  }

  unregisterWindow(id: number): void {
    if (!this.windows.has(id)) return;
    // Release any sessions this window owned.
    for (const [sid, wid] of this.ownership) {
      if (wid === id) this.ownership.delete(sid);
    }
    this.windows.delete(id);
    this.emit('changed');
  }

  assignSession(sessionId: string, windowId: number): void {
    if (!this.windows.has(windowId)) {
      throw new Error(`WindowRegistry.assignSession: unknown window ${windowId}`);
    }
    this.ownership.set(sessionId, windowId);
    this.emit('changed');
  }

  releaseSession(sessionId: string): void {
    if (!this.ownership.has(sessionId)) return;
    this.ownership.delete(sessionId);
    this.emit('changed');
  }

  getOwner(sessionId: string): number | undefined {
    return this.ownership.get(sessionId);
  }

  getLeaderId(): number | undefined {
    // Oldest createdAt wins.
    let oldest: Entry | undefined;
    for (const e of this.windows.values()) {
      if (!oldest || e.createdAt < oldest.createdAt) oldest = e;
    }
    return oldest?.id;
  }

  getWindowIds(): number[] {
    return Array.from(this.windows.keys());
  }

  sessionsForWindow(windowId: number): string[] {
    const out: string[] = [];
    for (const [sid, wid] of this.ownership) {
      if (wid === windowId) out.push(sid);
    }
    return out;
  }

  getDirectory(): WindowDirectory {
    const entries: WindowDirectoryEntry[] = [];
    // Sort by createdAt so labels stay stable/ordered.
    const sorted = Array.from(this.windows.values()).sort((a, b) => a.createdAt - b.createdAt);
    for (const e of sorted) {
      const info: WindowInfo = { id: e.id, label: e.label, createdAt: e.createdAt };
      entries.push({ window: info, sessionIds: this.sessionsForWindow(e.id) });
    }
    return {
      leaderWindowId: this.getLeaderId() ?? -1,
      windows: entries,
    };
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `npx vitest run src/main/window-registry.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/window-registry.ts src/main/window-registry.test.ts
git commit -m "feat(main): add WindowRegistry for session ownership and leader tracking"
```

---

### Task 1.3: Wire WindowRegistry into main and create second-window spawner

**Files:**
- Modify: `src/main/main.ts`
- Modify: `src/main/preload.ts`

- [ ] **Step 1: Add IPC channel constants**

In `src/main/preload.ts`, find the IPC channel constants block and add:

```typescript
// Window detach / registry
const IPC_WINDOW_DIRECTORY_UPDATED = 'window:directory-updated';
const IPC_WINDOW_LEADER_CHANGED = 'window:leader-changed';
const IPC_SESSION_OWNERSHIP_ACQUIRED = 'session:ownership-acquired';
const IPC_SESSION_OWNERSHIP_LOST = 'session:ownership-lost';
const IPC_SESSION_DETACH_START = 'session:detach-start';
const IPC_SESSION_DRAG_STARTED = 'session:drag-started';
const IPC_SESSION_DRAG_DROPPED = 'session:drag-dropped';
const IPC_SESSION_DRAG_ENDED = 'session:drag-ended';
const IPC_CROSS_WINDOW_CURSOR = 'session:cross-window-cursor';
const IPC_WINDOW_FOCUS_AND_SWITCH = 'window:focus-and-switch';
const IPC_TRANSCRIPT_REPLAY = 'transcript:replay-from-start';
const IPC_TRANSCRIPT_REPLAY_DONE = 'transcript:replay-done';
const IPC_WINDOW_OPEN_DETACHED = 'window:open-detached';
```

Expose these via `contextBridge.exposeInMainWorld` under `window.claude.detach`:

```typescript
contextBridge.exposeInMainWorld('claude', {
  // ... existing APIs ...
  detach: {
    onDirectoryUpdated: (cb: (dir: any) => void) => {
      ipcRenderer.on(IPC_WINDOW_DIRECTORY_UPDATED, (_, dir) => cb(dir));
    },
    onLeaderChanged: (cb: (leaderId: number) => void) => {
      ipcRenderer.on(IPC_WINDOW_LEADER_CHANGED, (_, id) => cb(id));
    },
    onOwnershipAcquired: (cb: (p: any) => void) => {
      ipcRenderer.on(IPC_SESSION_OWNERSHIP_ACQUIRED, (_, p) => cb(p));
    },
    onOwnershipLost: (cb: (p: any) => void) => {
      ipcRenderer.on(IPC_SESSION_OWNERSHIP_LOST, (_, p) => cb(p));
    },
    onCrossWindowCursor: (cb: (p: any) => void) => {
      ipcRenderer.on(IPC_CROSS_WINDOW_CURSOR, (_, p) => cb(p));
    },
    detachStart: (payload: any) => ipcRenderer.send(IPC_SESSION_DETACH_START, payload),
    dragStarted: (payload: any) => ipcRenderer.send(IPC_SESSION_DRAG_STARTED, payload),
    dragEnded: () => ipcRenderer.send(IPC_SESSION_DRAG_ENDED),
    dragDropped: (payload: any) => ipcRenderer.send(IPC_SESSION_DRAG_DROPPED, payload),
    focusAndSwitch: (payload: any) => ipcRenderer.send(IPC_WINDOW_FOCUS_AND_SWITCH, payload),
    openDetached: (payload: { sessionId: string }) => ipcRenderer.send(IPC_WINDOW_OPEN_DETACHED, payload),
    requestTranscriptReplay: (sessionId: string) => ipcRenderer.send(IPC_TRANSCRIPT_REPLAY, { sessionId }),
    ackTranscriptReplay: (sessionId: string) => ipcRenderer.send(IPC_TRANSCRIPT_REPLAY_DONE, { sessionId }),
  },
});
```

- [ ] **Step 2: Create second-window spawner in main.ts**

In `src/main/main.ts`, add near the existing window creation code:

```typescript
import { WindowRegistry } from './window-registry';
import type { DetachStartPayload, DragDroppedPayload } from '../shared/types';

const windowRegistry = new WindowRegistry();
export function getWindowRegistry() { return windowRegistry; }

function broadcastDirectory() {
  const dir = windowRegistry.getDirectory();
  for (const id of windowRegistry.getWindowIds()) {
    const win = BrowserWindow.fromId(id);
    win?.webContents.send('window:directory-updated', dir);
  }
}

let currentLeaderId = -1;
function recomputeLeader() {
  const newLeader = windowRegistry.getLeaderId();
  if (newLeader != null && newLeader !== currentLeaderId) {
    currentLeaderId = newLeader;
    for (const id of windowRegistry.getWindowIds()) {
      const win = BrowserWindow.fromId(id);
      win?.webContents.send('window:leader-changed', currentLeaderId);
    }
  }
}

windowRegistry.on('changed', () => {
  broadcastDirectory();
  recomputeLeader();
});

export function createAppWindow(opts?: { x?: number; y?: number; width?: number; height?: number }): BrowserWindow {
  const win = new BrowserWindow({
    width: opts?.width ?? 1200,
    height: opts?.height ?? 800,
    x: opts?.x,
    y: opts?.y,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
    // ... mirror existing BrowserWindow options (frame, titleBarStyle, etc.) ...
  });
  const id = win.webContents.id;
  windowRegistry.registerWindow(id, Date.now());
  win.on('closed', () => {
    windowRegistry.unregisterWindow(id);
  });
  // Load renderer (match existing load path used for the first window)
  if (app.isPackaged) {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  } else {
    win.loadURL('http://localhost:5173');
  }
  return win;
}
```

Replace the existing first-window creation call with `const mainWin = createAppWindow();`.

- [ ] **Step 3: Add detach IPC handlers**

Still in `src/main/main.ts`:

```typescript
ipcMain.on('window:open-detached', (evt, { sessionId }: { sessionId: string }) => {
  const { x, y } = screen.getCursorScreenPoint();
  const newWin = createAppWindow({ x: x - 60, y: y - 40, width: 900, height: 700 });
  const srcId = evt.sender.id;
  const targetId = newWin.webContents.id;
  handleOwnershipTransfer(sessionId, srcId, targetId, /*freshWindow*/ true);
});

ipcMain.on('session:detach-start', (evt, payload: DetachStartPayload) => {
  const newWin = createAppWindow({ x: payload.screenX - 60, y: payload.screenY - 40, width: 900, height: 700 });
  const srcId = evt.sender.id;
  const targetId = newWin.webContents.id;
  handleOwnershipTransfer(payload.sessionId, srcId, targetId, /*freshWindow*/ true);
});

ipcMain.on('session:drag-dropped', (evt, payload: DragDroppedPayload) => {
  const srcId = evt.sender.id;
  handleOwnershipTransfer(payload.sessionId, srcId, payload.targetWindowId, /*freshWindow*/ false);
  // If source window is now empty AND another window exists, close it.
  maybeAutoCloseEmptyWindow(srcId);
});

ipcMain.on('window:focus-and-switch', (_, { windowId, sessionId }: { windowId: number; sessionId: string }) => {
  const win = BrowserWindow.fromId(windowId);
  if (!win) return;
  win.focus();
  win.webContents.send('session:ownership-acquired', {
    sessionId,
    sessionInfo: sessionManager.getSession(sessionId),
    freshWindow: false,
    // This is a re-focus, not a real acquisition; we reuse the event because
    // the renderer's switch-active-session behavior is the same.
    refocusOnly: true,
  });
});

function handleOwnershipTransfer(sessionId: string, srcWindowId: number, targetWindowId: number, freshWindow: boolean) {
  const info = sessionManager.getSession(sessionId);
  if (!info) return;
  const currentOwner = windowRegistry.getOwner(sessionId);
  if (currentOwner !== srcWindowId) {
    // Race: session already moved. Ignore.
    return;
  }
  windowRegistry.assignSession(sessionId, targetWindowId);
  const src = BrowserWindow.fromId(srcWindowId);
  const tgt = BrowserWindow.fromId(targetWindowId);
  src?.webContents.send('session:ownership-lost', { sessionId });
  tgt?.webContents.send('session:ownership-acquired', { sessionId, sessionInfo: info, freshWindow });
}

function maybeAutoCloseEmptyWindow(windowId: number) {
  const remainingSessions = windowRegistry.sessionsForWindow(windowId);
  if (remainingSessions.length > 0) return;
  if (windowRegistry.getWindowIds().length <= 1) return;
  BrowserWindow.fromId(windowId)?.close();
}
```

- [ ] **Step 4: Assign initial session ownership on create**

Find `SessionManager.createSession` call site. After a session is created, look up which window made the request (`evt.sender.id`) and call `windowRegistry.assignSession(info.id, evt.sender.id)`.

If session creation is a request/response IPC (`ipcMain.handle`), the handler already has `evt`. Update it:

```typescript
ipcMain.handle('session:create', (evt, opts) => {
  const info = sessionManager.createSession(opts);
  windowRegistry.assignSession(info.id, evt.sender.id);
  return info;
});
```

- [ ] **Step 5: Commit**

```bash
git add src/main/main.ts src/main/preload.ts
git commit -m "feat(main): wire WindowRegistry, spawn peer windows, add ownership IPC"
```

---

### Task 1.4: Route session-scoped IPC emits via ownership

**Files:**
- Modify: `src/main/ipc-handlers.ts`
- Modify: `src/main/hook-relay.ts`
- Modify: `src/main/main.ts` (helper)

- [ ] **Step 1: Add `routeToOwner` helper in main.ts**

```typescript
export function routeToOwner(sessionId: string, channel: string, payload: any): void {
  const wid = windowRegistry.getOwner(sessionId);
  if (wid == null) return; // No owner (e.g., session being destroyed)
  const win = BrowserWindow.fromId(wid);
  win?.webContents.send(channel, payload);
}
```

- [ ] **Step 2: Replace broadcast with routed emits**

In `src/main/ipc-handlers.ts`, find every place that emits session-scoped events using `webContents.send(...)` or an `emit-to-all-windows` pattern. For each one:

Before (example):
```typescript
sessionManager.on('pty-output', (sessionId, data) => {
  mainWindow.webContents.send('pty:output', { sessionId, data });
});
```

After:
```typescript
import { routeToOwner } from './main';
sessionManager.on('pty-output', (sessionId, data) => {
  routeToOwner(sessionId, 'pty:output', { sessionId, data });
});
```

Apply the same transformation to:
- `pty:output`
- `session:created` (route to the owning window only; if no owner yet, the creating handler has already assigned one)
- `session:exit`
- `transcript:event` (emitted by `TranscriptWatcher`)
- `transcript:thinking-heartbeat` (if separate)

- [ ] **Step 3: Route permission requests**

In `src/main/hook-relay.ts`, find where `permission:request` is forwarded to the renderer. Replace the direct `mainWindow.webContents.send(...)` call with `routeToOwner(sessionId, 'permission:request', payload)`.

Same for `permission:expired`.

- [ ] **Step 4: Smoke test manually**

Run: `npm run dev`
In the running app, open DevTools and run `window.claude.detach.openDetached({ sessionId: '<current-session-id>' })` with a real session ID.
Expected: a second window appears, the source window removes the pill/chat (ownership-lost listener is not hooked up yet, so UI won't react — next phase). Check main-process logs: new window registered, ownership assigned.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc-handlers.ts src/main/hook-relay.ts src/main/main.ts
git commit -m "feat(main): route session-scoped IPC events to owning window only"
```

---

## Phase 2 — Ownership Reducer Actions + Transcript Replay

### Task 2.1: Add reducer actions for ownership gain/loss

**Files:**
- Modify: `src/renderer/state/chat-types.ts` (append action types)
- Modify: `src/renderer/state/chat-reducer.ts`
- Create: `src/renderer/state/chat-reducer.ownership.test.ts`

- [ ] **Step 1: Write failing test**

Create `src/renderer/state/chat-reducer.ownership.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { chatReducer, initialChatState } from './chat-reducer';
import type { SessionInfo } from '../../shared/types';

const mkInfo = (id: string): SessionInfo => ({
  id, name: `s-${id}`, cwd: '/', permissionMode: 'normal',
  skipPermissions: false, status: 'active', createdAt: 1, provider: 'claude',
});

describe('chat reducer ownership', () => {
  it('SESSION_OWNERSHIP_ACQUIRED adds session to sessions list', () => {
    const s = chatReducer(initialChatState, {
      type: 'SESSION_OWNERSHIP_ACQUIRED',
      payload: { sessionId: 's1', sessionInfo: mkInfo('s1'), freshWindow: true },
    });
    expect(s.sessions.some(x => x.id === 's1')).toBe(true);
  });

  it('SESSION_OWNERSHIP_LOST removes session and its toolCalls entries', () => {
    let s = chatReducer(initialChatState, {
      type: 'SESSION_OWNERSHIP_ACQUIRED',
      payload: { sessionId: 's1', sessionInfo: mkInfo('s1'), freshWindow: true },
    });
    // Pretend a tool call was recorded under s1
    s = { ...s, toolCallsBySession: new Map([['s1', new Map([['t1', { id: 't1', status: 'completed' }]])]]) as any };
    s = chatReducer(s, { type: 'SESSION_OWNERSHIP_LOST', payload: { sessionId: 's1' } });
    expect(s.sessions.find(x => x.id === 's1')).toBeUndefined();
    expect((s as any).toolCallsBySession.get('s1')).toBeUndefined();
  });

  it('SESSION_OWNERSHIP_ACQUIRED with freshWindow=true sets active session', () => {
    const s = chatReducer(initialChatState, {
      type: 'SESSION_OWNERSHIP_ACQUIRED',
      payload: { sessionId: 's1', sessionInfo: mkInfo('s1'), freshWindow: true },
    });
    expect(s.activeSessionId).toBe('s1');
  });
});
```

(Adjust property names to match the actual reducer shape — particularly how per-session `toolCalls` are stored. If `toolCalls` is a single flat Map keyed by toolUseId not session, the third assertion above needs to filter differently. Read the reducer first and adapt.)

- [ ] **Step 2: Run test, verify it fails**

Run: `npx vitest run src/renderer/state/chat-reducer.ownership.test.ts`
Expected: FAIL (action types unknown).

- [ ] **Step 3: Implement action types**

In `src/renderer/state/chat-types.ts`, add to the `ChatAction` union:

```typescript
| { type: 'SESSION_OWNERSHIP_ACQUIRED'; payload: { sessionId: string; sessionInfo: SessionInfo; freshWindow: boolean } }
| { type: 'SESSION_OWNERSHIP_LOST'; payload: { sessionId: string } }
```

- [ ] **Step 4: Implement reducer cases**

In `src/renderer/state/chat-reducer.ts`, add to the reducer switch:

```typescript
case 'SESSION_OWNERSHIP_ACQUIRED': {
  const { sessionId, sessionInfo, freshWindow } = action.payload;
  if (state.sessions.some(s => s.id === sessionId)) return state;
  const sessions = [...state.sessions, sessionInfo];
  return {
    ...state,
    sessions,
    activeSessionId: freshWindow ? sessionId : state.activeSessionId,
  };
}
case 'SESSION_OWNERSHIP_LOST': {
  const { sessionId } = action.payload;
  const sessions = state.sessions.filter(s => s.id !== sessionId);
  // Drop per-session state. Adjust shape to match actual reducer:
  // - timelineBySession, toolCallsBySession, activeTurnToolIdsBySession, etc.
  const next = { ...state, sessions };
  if (state.activeSessionId === sessionId) {
    next.activeSessionId = sessions[0]?.id;
  }
  // Cleanup per-session maps if they exist. Example pattern:
  for (const key of ['timelineBySession', 'toolCallsBySession', 'activeTurnToolIdsBySession', 'streamingTextBySession'] as const) {
    const m = (state as any)[key] as Map<string, unknown> | undefined;
    if (m instanceof Map && m.has(sessionId)) {
      const copy = new Map(m);
      copy.delete(sessionId);
      (next as any)[key] = copy;
    }
  }
  return next;
}
```

**Important:** Check the actual reducer state shape first. If chat state is not keyed by session (e.g., the reducer is single-session and App.tsx keeps one reducer per session), adapt the cleanup to match. The spirit is: when ownership is lost, remove every trace of that session from this window's state.

- [ ] **Step 5: Run tests, verify pass**

Run: `npx vitest run src/renderer/state/chat-reducer.ownership.test.ts`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/state/chat-types.ts src/renderer/state/chat-reducer.ts src/renderer/state/chat-reducer.ownership.test.ts
git commit -m "feat(reducer): add SESSION_OWNERSHIP_ACQUIRED and _LOST actions"
```

---

### Task 2.2: Subscribe to ownership events in App.tsx

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Add useEffect listeners**

Near the other `window.claude.*` effect listeners in App.tsx:

```typescript
useEffect(() => {
  if (!window.claude?.detach) return;
  window.claude.detach.onOwnershipAcquired(async (payload: any) => {
    if (payload.refocusOnly) {
      dispatch({ type: 'SESSION_SWITCHED', payload: { sessionId: payload.sessionId } });
      return;
    }
    dispatch({ type: 'SESSION_OWNERSHIP_ACQUIRED', payload });
    if (!payload.freshWindow) return; // new window freshly created — transcript stream starts immediately
    // For transferred sessions, request transcript replay to rebuild reducer state.
    window.claude.detach.requestTranscriptReplay(payload.sessionId);
  });
  window.claude.detach.onOwnershipLost((payload: any) => {
    dispatch({ type: 'SESSION_OWNERSHIP_LOST', payload });
  });
}, []);
```

Note: `freshWindow: true` means the new window was created specifically for this session — it has no prior state, so just start rendering new events. We still need replay for the case where the acquired session already has history on disk (which is virtually every detach). Change the condition:

```typescript
    // Always replay — the newly-created window has no in-memory history,
    // and the transcript watcher is the source of truth for past events.
    window.claude.detach.requestTranscriptReplay(payload.sessionId);
```

- [ ] **Step 2: Commit**

```bash
git add src/renderer/App.tsx
git commit -m "feat(renderer): subscribe to session ownership events"
```

---

### Task 2.3: Transcript replay + event buffering

**Files:**
- Modify: `src/main/transcript-watcher.ts`
- Modify: `src/main/main.ts` (or wherever `transcript:replay-from-start` is handled)

- [ ] **Step 1: Verify getHistory exists**

Read `src/main/transcript-watcher.ts`. Look for a method that returns all past events for a session. If one exists (likely `getHistory(sessionId): TranscriptEvent[]`), proceed. If not, implement:

```typescript
getHistory(sessionId: string): TranscriptEvent[] {
  // Read the JSONL file from disk up to current byte offset, parse each line
  // into a TranscriptEvent, and return in order. Use the same parser used by
  // the live watcher. Exclude duplicate uuids if any de-dup cache exists.
  const path = this.transcriptPathFor(sessionId); // existing helper
  if (!path || !fs.existsSync(path)) return [];
  const raw = fs.readFileSync(path, 'utf8');
  const events: TranscriptEvent[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    const ev = this.parseLine(sessionId, line); // existing parser
    if (ev) events.push(ev);
  }
  return events;
}
```

Use the project's actual parser / path-resolver (do not reinvent — read `transcript-watcher.ts` and reuse `parseLine` / equivalent).

- [ ] **Step 2: Add replay handler + buffer**

In `src/main/main.ts` (or wherever the watcher is wired):

```typescript
// Per-session event buffer during ownership transitions.
// Key: sessionId → queued events. When a window requests replay, we pause
// live routing for that session and flush replay + buffered events in order.
const replayBuffers = new Map<string, Array<{ channel: string; payload: any }>>();
const replayingFor = new Set<string>();

function startReplayWindow(sessionId: string) {
  replayingFor.add(sessionId);
  replayBuffers.set(sessionId, []);
}

function flushBuffer(sessionId: string, targetWindowId: number) {
  const buf = replayBuffers.get(sessionId) ?? [];
  const win = BrowserWindow.fromId(targetWindowId);
  for (const item of buf) win?.webContents.send(item.channel, item.payload);
  replayBuffers.delete(sessionId);
  replayingFor.delete(sessionId);
}

// Modify routeToOwner to buffer during replay:
export function routeToOwner(sessionId: string, channel: string, payload: any): void {
  const wid = windowRegistry.getOwner(sessionId);
  if (wid == null) return;
  if (replayingFor.has(sessionId)) {
    replayBuffers.get(sessionId)!.push({ channel, payload });
    return;
  }
  const win = BrowserWindow.fromId(wid);
  win?.webContents.send(channel, payload);
}

ipcMain.on('transcript:replay-from-start', (evt, { sessionId }: { sessionId: string }) => {
  startReplayWindow(sessionId);
  const events = transcriptWatcher.getHistory(sessionId);
  for (const ev of events) {
    evt.sender.send('transcript:event', ev);
  }
  // The replay itself is synchronous here, but the renderer is async — we let
  // the renderer ack when its reducer has consumed everything.
});

ipcMain.on('transcript:replay-done', (evt, { sessionId }: { sessionId: string }) => {
  const wid = windowRegistry.getOwner(sessionId);
  if (wid != null) flushBuffer(sessionId, wid);
});
```

- [ ] **Step 3: Ack replay from renderer**

In `App.tsx`, after dispatching `SESSION_OWNERSHIP_ACQUIRED` and kicking off replay, listen for transcript events tagged with the replayed session; after receiving all of them (use a sentinel event or ack after processing the synchronous-ish flood), call:

```typescript
window.claude.detach.ackTranscriptReplay(payload.sessionId);
```

Simpler approach: ack right after the `requestTranscriptReplay` call via a `setTimeout(0)` — the renderer processes events in order, and the replay is sent synchronously from main. Ack on the next microtask is safe:

```typescript
window.claude.detach.requestTranscriptReplay(payload.sessionId);
queueMicrotask(() => window.claude.detach.ackTranscriptReplay(payload.sessionId));
```

**Note:** If replay is large (hundreds of events), the renderer might be mid-processing when the ack fires. Not a correctness issue — buffered live events land in the reducer after the replay events and get deduped by existing uuid-based dedup in the transcript action. Keep the simple ack.

- [ ] **Step 4: Manual test**

Run: `npm run dev`. Open two sessions in one window. In DevTools:
```javascript
window.claude.detach.openDetached({ sessionId: '<id-of-second-session>' })
```
Expected: new window appears, its chat view shows full history of that session. Source window's SessionStrip no longer shows the detached session.

- [ ] **Step 5: Commit**

```bash
git add src/main/main.ts src/main/transcript-watcher.ts src/renderer/App.tsx
git commit -m "feat(main): transcript replay on ownership acquire + event buffering"
```

---

## Phase 3 — Detach Gesture (Drag Out)

### Task 3.1: Add pointer-capture drag to SessionStrip pills

**Files:**
- Modify: `src/renderer/components/SessionStrip.tsx`

- [ ] **Step 1: Add drag state + handlers**

At the top of `SessionStrip.tsx` component:

```typescript
type DragState = {
  sessionId: string;
  pointerId: number;
  startX: number;
  startY: number;
  pillRect: DOMRect;
} | null;

const [dragState, setDragState] = useState<DragState>(null);
const [draggingGhost, setDraggingGhost] = useState<{ x: number; y: number } | null>(null);
const stripRef = useRef<HTMLDivElement>(null);
```

Attach to each pill element:

```typescript
onPointerDown={(e) => {
  if (e.button !== 0) return;
  const rect = e.currentTarget.getBoundingClientRect();
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  setDragState({
    sessionId: session.id,
    pointerId: e.pointerId,
    startX: e.clientX,
    startY: e.clientY,
    pillRect: rect,
  });
}}
onPointerMove={(e) => {
  if (!dragState || e.pointerId !== dragState.pointerId) return;
  const dx = e.clientX - dragState.startX;
  const dy = e.clientY - dragState.startY;
  if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return; // threshold before we consider it a drag
  setDraggingGhost({ x: e.clientX, y: e.clientY });

  // Check if cursor has left the window — Electron reports negative or
  // out-of-bounds client coords when pointer capture keeps events flowing.
  const oob =
    e.clientX < 0 || e.clientY < 0 ||
    e.clientX > window.innerWidth || e.clientY > window.innerHeight;
  if (oob) {
    const sx = (e.screenX ?? (window.screenX + e.clientX));
    const sy = (e.screenY ?? (window.screenY + e.clientY));
    window.claude.detach.detachStart({ sessionId: dragState.sessionId, screenX: sx, screenY: sy });
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    setDragState(null);
    setDraggingGhost(null);
  }
}}
onPointerUp={(e) => {
  if (!dragState || e.pointerId !== dragState.pointerId) return;
  (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  setDragState(null);
  setDraggingGhost(null);
}}
```

- [ ] **Step 2: Render the ghost pill**

Near the pill list, add:

```tsx
{draggingGhost && dragState && (
  <div
    style={{
      position: 'fixed',
      left: draggingGhost.x - dragState.pillRect.width / 2,
      top: draggingGhost.y - dragState.pillRect.height / 2,
      width: dragState.pillRect.width,
      height: dragState.pillRect.height,
      pointerEvents: 'none',
      opacity: 0.8,
      zIndex: 9001,
    }}
    className="..." // copy pill classes so the ghost visually matches
  >
    {/* pill contents for dragState.sessionId */}
  </div>
)}
```

Also dim the source pill while `dragState?.sessionId === session.id` — e.g., `opacity-40`.

- [ ] **Step 3: Manual test**

Run: `npm run dev`. Open 2+ sessions. Drag a pill. Drag past the window edge.
Expected: ghost follows cursor, source pill dims, once cursor leaves window a new peer window spawns under the cursor with that session.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/SessionStrip.tsx
git commit -m "feat(session-strip): drag pill out of window to detach into new peer window"
```

---

## Phase 4 — Re-Dock Gesture (Drag Between Windows)

### Task 4.1: Cross-window cursor broadcast in main

**Files:**
- Modify: `src/main/main.ts`

- [ ] **Step 1: Add drag-state tracker + ticker**

```typescript
let activeDragSessionId: string | null = null;
let cursorTicker: NodeJS.Timeout | null = null;

ipcMain.on('session:drag-started', (_, { sessionId }: { sessionId: string }) => {
  activeDragSessionId = sessionId;
  if (cursorTicker) clearInterval(cursorTicker);
  cursorTicker = setInterval(() => {
    if (!activeDragSessionId) return;
    const { x, y } = screen.getCursorScreenPoint();
    for (const wid of windowRegistry.getWindowIds()) {
      const win = BrowserWindow.fromId(wid);
      win?.webContents.send('session:cross-window-cursor', { screenX: x, screenY: y });
    }
  }, 33); // ~30Hz
});

ipcMain.on('session:drag-ended', () => {
  activeDragSessionId = null;
  if (cursorTicker) { clearInterval(cursorTicker); cursorTicker = null; }
});
```

Re-use this same drag-ended signal when `session:drag-dropped` or `session:detach-start` fires — call the inline cleanup from their handlers too:

```typescript
function stopCursorTicker() {
  activeDragSessionId = null;
  if (cursorTicker) { clearInterval(cursorTicker); cursorTicker = null; }
}
// inside session:drag-dropped and session:detach-start handlers, after processing:
stopCursorTicker();
```

- [ ] **Step 2: Commit**

```bash
git add src/main/main.ts
git commit -m "feat(main): broadcast cross-window cursor coords during active drag"
```

---

### Task 4.2: Drop-zone detection in target window

**Files:**
- Modify: `src/renderer/components/SessionStrip.tsx`

- [ ] **Step 1: Update drag start to notify main**

In the `onPointerDown` handler, after `setDragState(...)`:

```typescript
window.claude.detach.dragStarted({ sessionId: session.id });
```

In the `onPointerUp` handler (end of local drag), and the OOB path (end of local drag, handoff to new window):

```typescript
window.claude.detach.dragEnded();
```

- [ ] **Step 2: Listen for cross-window cursor events**

At the top of `SessionStrip`:

```typescript
const [dropZoneActive, setDropZoneActive] = useState(false);

useEffect(() => {
  if (!window.claude?.detach) return;
  window.claude.detach.onCrossWindowCursor(({ screenX, screenY }: { screenX: number; screenY: number }) => {
    if (!stripRef.current) return;
    const rect = stripRef.current.getBoundingClientRect();
    const localX = screenX - window.screenX;
    const localY = screenY - window.screenY;
    const inside =
      localX >= rect.left && localX <= rect.right &&
      localY >= rect.top && localY <= rect.bottom;
    setDropZoneActive(inside);
  });
}, []);
```

Apply a visual treatment to the strip when `dropZoneActive` is true (outline, subtle background tint). Only the window this event arrives in shows the highlight — and only one window at a time will have the cursor inside its strip.

- [ ] **Step 3: Handle drop arriving at target**

Cross-window drops are tricky because the *source* window is the one seeing `pointerup` (it holds pointer capture). So the source must decide whether to drop in another window or detach.

Change the source's `onPointerUp` to query: *is any other window currently reporting its strip as the drop zone?* Simplest: have each window broadcast its current drop-zone state via IPC, or have main track it.

Cleaner: on `pointerup`, the source asks main — "where is the cursor?" — and main decides which window's strip (if any) contains it. Add a request/response IPC:

In `src/main/main.ts`:

```typescript
ipcMain.handle('session:drop-resolve', async () => {
  const { x, y } = screen.getCursorScreenPoint();
  for (const wid of windowRegistry.getWindowIds()) {
    const win = BrowserWindow.fromId(wid);
    if (!win) continue;
    // Ask that window whether its strip contains the cursor.
    try {
      const hit = await win.webContents.executeJavaScript(
        `(() => {
          const el = document.querySelector('[data-session-strip]');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const lx = ${x} - window.screenX;
          const ly = ${y} - window.screenY;
          return (lx >= r.left && lx <= r.right && ly >= r.top && ly <= r.bottom);
        })()`
      );
      if (hit) return { targetWindowId: wid };
    } catch {
      // ignore
    }
  }
  return { targetWindowId: null };
});
```

Expose in `preload.ts`:
```typescript
dropResolve: () => ipcRenderer.invoke('session:drop-resolve'),
```

- [ ] **Step 4: Mark the strip element for the script to find**

In `SessionStrip.tsx`, add `data-session-strip` to the strip container:

```tsx
<div ref={stripRef} data-session-strip ...>
```

- [ ] **Step 5: Source-side drop decision**

Replace the OOB detach path. In `onPointerMove`, remove the immediate detach on OOB. Instead, only set a flag: `setCursorOutside(true)`. The actual decision happens on `pointerup`:

```typescript
onPointerUp={async (e) => {
  if (!dragState || e.pointerId !== dragState.pointerId) return;
  (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);

  const screenX = e.screenX ?? (window.screenX + e.clientX);
  const screenY = e.screenY ?? (window.screenY + e.clientY);

  const { targetWindowId } = await window.claude.detach.dropResolve();
  if (targetWindowId && targetWindowId !== (window as any).__windowId) {
    // Drop onto another window's strip → re-dock
    window.claude.detach.dragDropped({
      sessionId: dragState.sessionId,
      targetWindowId,
      insertIndex: 0, // TODO: compute from cursor x within strip
    });
  } else {
    // Decide between detach vs snap-back based on cursor position
    const stripRect = stripRef.current?.getBoundingClientRect();
    const stillInsideOwnStrip = stripRect
      ? (e.clientX >= stripRect.left && e.clientX <= stripRect.right &&
         e.clientY >= stripRect.top && e.clientY <= stripRect.bottom)
      : true;
    const outsideWindow =
      e.clientX < 0 || e.clientY < 0 ||
      e.clientX > window.innerWidth || e.clientY > window.innerHeight;

    if (outsideWindow) {
      window.claude.detach.detachStart({ sessionId: dragState.sessionId, screenX, screenY });
    } else if (stillInsideOwnStrip) {
      // snap back — no-op
    } else {
      // Dropped in the same window but outside strip. Snap back.
    }
  }
  window.claude.detach.dragEnded();
  setDragState(null);
  setDraggingGhost(null);
}}
```

Also add `(window as any).__windowId = <webContentsId>` — get it via a new IPC `window:get-id` that main implements as `ipcMain.handle('window:get-id', evt => evt.sender.id)`. Call it once on mount in App.tsx and stash on window.

- [ ] **Step 6: Manual test**

Run: `npm run dev`. Open 2 windows (use the detach gesture from Task 3.1 first). Drag a pill from window A into window B's SessionStrip. Release.
Expected: pill appears in window B, chat view in B shows the transferred session's history. Window A's strip loses the pill. If A is now empty and B exists, A closes automatically.

- [ ] **Step 7: Commit**

```bash
git add src/renderer/components/SessionStrip.tsx src/main/main.ts src/main/preload.ts
git commit -m "feat(drag): cross-window drop resolution and re-dock"
```

---

## Phase 5 — Window Close Behavior

### Task 5.1: Confirm-on-close when sessions active

**Files:**
- Modify: `src/main/main.ts`

- [ ] **Step 1: Add before-close prompt**

In `createAppWindow`, after `win.on('closed', ...)`:

```typescript
win.on('close', async (ev) => {
  const ownedSessions = windowRegistry.sessionsForWindow(win.webContents.id);
  if (ownedSessions.length === 0) return; // allow close
  ev.preventDefault();
  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    buttons: ['Cancel', 'Close & Kill Sessions'],
    defaultId: 0,
    cancelId: 0,
    message: `This window has ${ownedSessions.length} active session${ownedSessions.length === 1 ? '' : 's'}.`,
    detail: 'Closing the window will terminate these sessions.',
  });
  if (response === 1) {
    for (const sid of ownedSessions) {
      sessionManager.destroySession(sid);
      windowRegistry.releaseSession(sid);
    }
    win.destroy();
  }
});
```

- [ ] **Step 2: Manual test**

Run: `npm run dev`. Create a session. Close the window.
Expected: prompt appears. Cancel keeps the window open. "Close & Kill" destroys the session and closes the window.

- [ ] **Step 3: Commit**

```bash
git add src/main/main.ts
git commit -m "feat(main): confirm before closing window with active sessions"
```

---

## Phase 6 — "Launch in New Window" Toggle

### Task 6.1: Add toggle to session creation flow

**Files:**
- Modify: `src/renderer/components/NewSessionDialog.tsx` (or equivalent — find via grep `createSession`)

- [ ] **Step 1: Find the creation dialog**

Run: `grep -rln "session:create\|createSession" src/renderer/components/`
Open whichever component renders the new-session form.

- [ ] **Step 2: Add toggle state**

```typescript
const [launchInNewWindow, setLaunchInNewWindow] = useState(false);

// In JSX, near other form controls:
{!isAndroid && (
  <label className="flex items-center gap-2 text-sm">
    <input
      type="checkbox"
      checked={launchInNewWindow}
      onChange={e => setLaunchInNewWindow(e.target.checked)}
    />
    Launch in new window
  </label>
)}
```

Where `isAndroid = location.protocol === 'file:'` (existing platform detection pattern).

- [ ] **Step 3: Wire into submit handler**

After the session is created:

```typescript
const info = await window.claude.session.create({ ...opts });
if (launchInNewWindow) {
  window.claude.detach.openDetached({ sessionId: info.id });
}
```

- [ ] **Step 4: Same for ResumeBrowser**

Apply the same checkbox + conditional call in `src/renderer/components/ResumeBrowser.tsx`.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/NewSessionDialog.tsx src/renderer/components/ResumeBrowser.tsx
git commit -m "feat(ui): 'Launch in new window' toggle for session create/resume"
```

---

## Phase 7 — Session Switcher Grouping

### Task 7.1: Wire window directory into renderer state

**Files:**
- Modify: `src/renderer/App.tsx`

- [ ] **Step 1: Add directory state**

```typescript
const [windowDirectory, setWindowDirectory] = useState<WindowDirectory | null>(null);
const [myWindowId, setMyWindowId] = useState<number | null>(null);

useEffect(() => {
  window.claude.detach.onDirectoryUpdated(setWindowDirectory);
  window.claude.window.getId?.().then(setMyWindowId);
}, []);
```

Add `getId: () => ipcRenderer.invoke('window:get-id')` to preload's `window` namespace.

- [ ] **Step 2: Pass to SessionStrip**

```tsx
<SessionStrip
  sessions={...}
  windowDirectory={windowDirectory}
  myWindowId={myWindowId}
  ...
/>
```

- [ ] **Step 3: Commit**

```bash
git add src/renderer/App.tsx src/main/preload.ts
git commit -m "feat(renderer): expose window directory to SessionStrip"
```

---

### Task 7.2: Two-group switcher dropdown

**Files:**
- Modify: `src/renderer/components/SessionStrip.tsx`

- [ ] **Step 1: Compute groups**

Inside the switcher dropdown render:

```typescript
const localIds = new Set(props.sessions.map(s => s.id));
const otherWindows = (props.windowDirectory?.windows ?? [])
  .filter(w => w.window.id !== props.myWindowId)
  .map(w => ({
    label: w.window.label,
    sessions: w.sessionIds.filter(id => !localIds.has(id)),
  }))
  .filter(w => w.sessions.length > 0);
```

- [ ] **Step 2: Render grouped menu**

```tsx
<div className="switcher">
  <div className="group-header">Sessions in this window</div>
  {props.sessions.map(s => <LocalItem key={s.id} session={s} />)}

  {otherWindows.length > 0 && (
    <>
      <div className="group-header">Sessions in other windows</div>
      {otherWindows.map(w => (
        w.sessions.map(sid => (
          <RemoteItem
            key={sid}
            sessionId={sid}
            windowLabel={w.label}
            onSelect={() => {
              const wid = props.windowDirectory!.windows.find(x => x.sessionIds.includes(sid))!.window.id;
              window.claude.detach.focusAndSwitch({ windowId: wid, sessionId: sid });
            }}
          />
        ))
      ))}
    </>
  )}
</div>
```

A `RemoteItem` shows the session name (or id) with a right-chevron + window label, e.g. `marketplace → window 2`.

- [ ] **Step 3: Handle remote session metadata**

Remote sessions don't have `SessionInfo` in this window. Options:
- (a) Include `SessionInfo` snapshots inside `WindowDirectoryEntry.sessionIds` — change the type to `sessions: SessionInfo[]` and populate in `WindowRegistry.getDirectory()`.
- (b) Show only the session ID as a fallback.

Go with (a). Update `WindowDirectoryEntry`:

```typescript
export interface WindowDirectoryEntry {
  window: WindowInfo;
  sessions: SessionInfo[]; // renamed from sessionIds
}
```

In `WindowRegistry.getDirectory()`, accept an injected `(id) => SessionInfo | undefined` resolver. In main, pass `id => sessionManager.getSession(id)`.

```typescript
// main.ts
function broadcastDirectory() {
  const dir = windowRegistry.getDirectory(id => sessionManager.getSession(id));
  // ... broadcast ...
}
```

Adjust `WindowRegistry.getDirectory` signature:

```typescript
getDirectory(resolver: (id: string) => SessionInfo | undefined): WindowDirectory {
  // ...
  for (const e of sorted) {
    const sessions = this.sessionsForWindow(e.id)
      .map(resolver)
      .filter((s): s is SessionInfo => !!s);
    entries.push({ window: { id: e.id, label: e.label, createdAt: e.createdAt }, sessions });
  }
  // ...
}
```

Update the unit test in Task 1.2 accordingly.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/SessionStrip.tsx src/main/window-registry.ts src/main/window-registry.test.ts src/main/main.ts src/shared/types.ts
git commit -m "feat(switcher): two-group dropdown with remote sessions and focus-switch"
```

---

## Phase 8 — Leader Election & Cross-Window Broadcasts

### Task 8.1: Leader state in renderer

**Files:**
- Modify: `src/renderer/App.tsx`
- Modify: `src/renderer/hooks/usePartyLobby.ts`

- [ ] **Step 1: Add isLeader state + provide via context**

In App.tsx:

```typescript
const [leaderWindowId, setLeaderWindowId] = useState<number | null>(null);
useEffect(() => {
  window.claude.detach.onLeaderChanged(setLeaderWindowId);
}, []);
const isLeader = leaderWindowId != null && myWindowId != null && leaderWindowId === myWindowId;
```

Create or extend an existing context (e.g., a `WindowContext`) to expose `isLeader`.

- [ ] **Step 2: Gate usePartyLobby**

In `src/renderer/hooks/usePartyLobby.ts`, read `isLeader` from context. Skip `new PartySocket(...)` when `!isLeader`. When `isLeader` flips true, connect; when it flips false, close the socket.

```typescript
const { isLeader } = useWindowContext();
useEffect(() => {
  if (!isLeader) return; // non-leader: do not open lobby socket
  const socket = new PartySocket({ ... });
  // ... existing behavior ...
  return () => socket.close();
}, [isLeader, /* existing deps */]);
```

- [ ] **Step 3: Manual test**

Run: `npm run dev`. Open a detached window via Task 3.1. Verify only one window shows "online" in the lobby UI (check dev tools network → websocket connections, or the lobby roster).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/App.tsx src/renderer/hooks/usePartyLobby.ts
git commit -m "feat(leader): gate PartyKit lobby on leader window"
```

---

### Task 8.2: Broadcast theme and settings changes

**Files:**
- Modify: `src/renderer/state/theme-context.tsx`
- Modify: `src/main/main.ts`
- Modify: `src/main/preload.ts`

- [ ] **Step 1: Add broadcast channel**

In `src/main/main.ts`:

```typescript
ipcMain.on('theme:changed-broadcast', (evt, payload) => {
  for (const wid of windowRegistry.getWindowIds()) {
    if (wid === evt.sender.id) continue;
    BrowserWindow.fromId(wid)?.webContents.send('theme:changed-external', payload);
  }
});

ipcMain.on('settings:changed-broadcast', (evt, payload) => {
  for (const wid of windowRegistry.getWindowIds()) {
    if (wid === evt.sender.id) continue;
    BrowserWindow.fromId(wid)?.webContents.send('settings:changed-external', payload);
  }
});
```

Expose in preload:

```typescript
// Inside contextBridge.exposeInMainWorld('claude', { ... }):
theme: {
  broadcastChange: (payload: any) => ipcRenderer.send('theme:changed-broadcast', payload),
  onExternalChange: (cb: (p: any) => void) => ipcRenderer.on('theme:changed-external', (_, p) => cb(p)),
},
settings: {
  broadcastChange: (payload: any) => ipcRenderer.send('settings:changed-broadcast', payload),
  onExternalChange: (cb: (p: any) => void) => ipcRenderer.on('settings:changed-external', (_, p) => cb(p)),
},
```

- [ ] **Step 2: Call broadcast from ThemeProvider**

In `src/renderer/state/theme-context.tsx`, after every `setTheme` / `setFont` / `setReducedEffects` / etc. that persists to localStorage:

```typescript
window.claude.theme.broadcastChange({ theme, font, reducedEffects, showTimestamps, cycleList });
```

And listen once on mount:

```typescript
useEffect(() => {
  window.claude.theme.onExternalChange((payload: any) => {
    // Apply incoming change without re-broadcasting.
    applyThemeExternal(payload);
  });
}, []);
```

Where `applyThemeExternal` runs the same set-state logic but bypasses the broadcast. Easiest: guard the broadcast with a `isExternalApply` ref.

- [ ] **Step 3: Apply same pattern to settings**

For anything in `SettingsPanel` that writes to disk or persistent state (remote access config, skill favorites, chips), call `window.claude.settings.broadcastChange({ key, value })` after the write and listen for external changes to re-read from source of truth.

Minimum viable: emit a generic "settings changed, re-read" signal and let each settings-dependent component refetch its data.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/state/theme-context.tsx src/main/main.ts src/main/preload.ts src/renderer/components/SettingsPanel.tsx
git commit -m "feat(broadcast): sync theme and settings across peer windows"
```

---

## Phase 9 — Android / Remote Shim Compatibility

### Task 9.1: Stub detach IPC in remote-shim

**Files:**
- Modify: `src/renderer/remote-shim.ts`

- [ ] **Step 1: Add no-op stubs**

If `location.protocol === 'file:'` (Android) or the remote-shim path, add:

```typescript
window.claude.detach = {
  onDirectoryUpdated: () => {},
  onLeaderChanged: () => {},
  onOwnershipAcquired: () => {},
  onOwnershipLost: () => {},
  onCrossWindowCursor: () => {},
  detachStart: () => {},
  dragStarted: () => {},
  dragEnded: () => {},
  dragDropped: () => {},
  focusAndSwitch: () => {},
  openDetached: () => {},
  requestTranscriptReplay: () => {},
  ackTranscriptReplay: () => {},
  dropResolve: () => Promise.resolve({ targetWindowId: null }),
};
```

This ensures SessionStrip's drag handlers are harmless on Android (single-window WebView). Also hide the "Launch in new window" checkbox on Android (already conditional in Task 6.1).

- [ ] **Step 2: Commit**

```bash
git add src/renderer/remote-shim.ts
git commit -m "feat(android): no-op detach IPC stubs for single-window WebView"
```

---

## Phase 10 — Verification

### Task 10.1: Full manual test matrix

- [ ] **Step 1: Run through all scenarios**

Start with a clean desktop app: `npm run dev`

Exercise each:
- [ ] Create session → drag pill out past window edge → peer window spawns, source strip loses pill
- [ ] Create 2 windows → drag pill from A into B's strip → session moves, source closes (A was last remaining session)
- [ ] 3 windows (A, B, C) → drag from A to B → A closes because last session, B now has its original + transferred, C unchanged
- [ ] "Launch in new window" toggle in new-session dialog → spawns second window directly
- [ ] "Launch in new window" toggle in resume dialog → same
- [ ] Shift-hold switcher in window A shows window B's sessions under "Sessions in other windows" group
- [ ] Select a remote session in switcher → window B focuses and switches to that session
- [ ] Close window with active session → prompt appears, Cancel keeps open, Close & Kill terminates
- [ ] Detach while Claude is streaming → transferred window picks up mid-stream correctly
- [ ] Permission prompt in detached window → only that window sees the prompt, source unaffected
- [ ] Change theme in window A → window B updates live
- [ ] PartyKit lobby: open detached window → only one lobby "online" entry for your user (leader only)
- [ ] Close leader window → other window inherits leader, its lobby connects

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected: all pass.

- [ ] **Step 3: Typecheck + build**

```bash
npm run build
```

Expected: no errors.

- [ ] **Step 4: Commit any fixes**

Any issues surfaced during verification → fix + commit separately per bug.

---

## Self-Review

Spec coverage check (against `2026-04-12-drag-session-detach-window-design.md`):

- [x] Peer window model — Phase 1
- [x] Detach gesture (drag out) — Phase 3
- [x] Re-dock gesture (drag in) — Phase 4
- [x] State hydration via transcript replay — Phase 2
- [x] Event buffering during ownership transfer — Task 2.3
- [x] "Launch in New Window" toggle — Phase 6
- [x] Window close with active sessions prompt — Phase 5
- [x] Auto-close emptied peer window — Task 1.3 (`maybeAutoCloseEmptyWindow`)
- [x] Session switcher grouping — Phase 7
- [x] Leader election — Task 8.1
- [x] PartyKit lobby gate — Task 8.1
- [x] Theme/settings broadcast — Task 8.2
- [x] Android stubs — Phase 9
- [x] Permission routing via ownership — Task 1.4
- [x] Race protection (IPC serialization + ownership check in `handleOwnershipTransfer`) — Task 1.3
- [x] Window bounds (per-window localStorage is existing behavior; no change needed; non-primary windows don't survive app restart — implicit, no code required)
- [x] Verification test pass — Phase 10

No gaps.
