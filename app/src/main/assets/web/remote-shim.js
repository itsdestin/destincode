"use strict";
/**
 * WebSocket-backed implementation of window.claude for browser (non-Electron) access.
 * Provides the same API surface as the Electron preload bridge.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getConnectionState = getConnectionState;
exports.onConnectionStateChange = onConnectionStateChange;
exports.connect = connect;
exports.disconnect = disconnect;
exports.connectToHost = connectToHost;
exports.disconnectFromHost = disconnectFromHost;
exports.installShim = installShim;
let ws = null;
let messageId = 0;
const pending = new Map();
const listeners = new Map();
let connectionState = 'disconnected';
let stateChangeCallback = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
const MAX_RECONNECT_DELAY = 30_000;
/** Override WebSocket target — set by connectToHost(), cleared by disconnectFromHost() */
let targetUrl = null;
/** Whether to preserve __PLATFORM__ on next auth:ok (prevents desktop overwriting 'android') */
let preservePlatform = false;
function setConnectionState(state) {
    connectionState = state;
    stateChangeCallback?.(state);
}
function getConnectionState() {
    return connectionState;
}
function onConnectionStateChange(cb) {
    stateChangeCallback = cb;
}
function getWsUrl() {
    // If a remote host override is set, use it (connectToHost sets this)
    if (targetUrl)
        return targetUrl;
    // Android WebView loads from file:// — connect to local bridge server
    if (location.protocol === 'file:') {
        return 'ws://localhost:9901';
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}/ws`;
}
function send(msg) {
    if (ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
    }
}
function invoke(type, payload) {
    return new Promise((resolve, reject) => {
        const id = `msg-${++messageId}`;
        const timeout = setTimeout(() => {
            if (pending.has(id)) {
                pending.delete(id);
                reject(new Error(`Request ${type} timed out`));
            }
        }, 30_000);
        pending.set(id, { resolve, reject, timeout });
        send({ type, id, payload });
    });
}
function fire(type, payload) {
    send({ type, payload });
}
function addListener(channel, cb) {
    let set = listeners.get(channel);
    if (!set) {
        set = new Set();
        listeners.set(channel, set);
    }
    set.add(cb);
    return cb;
}
function removeListener(channel, handler) {
    const set = listeners.get(channel);
    if (set) {
        set.delete(handler);
        if (set.size === 0)
            listeners.delete(channel);
    }
}
function removeAllListeners(channel) {
    listeners.delete(channel);
}
function dispatchEvent(type, ...args) {
    const set = listeners.get(type);
    if (set) {
        for (const cb of set) {
            try {
                cb(...args);
            }
            catch (e) {
                console.error(`[remote-shim] listener error on ${type}:`, e);
            }
        }
    }
}
function handleMessage(data) {
    let msg;
    try {
        msg = JSON.parse(data);
    }
    catch {
        return;
    }
    const { type, id, payload } = msg;
    // Auth responses are handled separately
    if (type === 'auth:ok' || type === 'auth:failed')
        return;
    // Response to a pending request
    if (type?.endsWith(':response') && id && pending.has(id)) {
        const entry = pending.get(id);
        clearTimeout(entry.timeout);
        pending.delete(id);
        entry.resolve(payload);
        return;
    }
    // Push events — dispatch to registered listeners
    switch (type) {
        case 'pty:output':
            dispatchEvent('pty:output', payload.sessionId, payload.data); // global (App.tsx mode detection)
            dispatchEvent(`pty:output:${payload.sessionId}`, payload.data); // per-session (TerminalView)
            break;
        case 'hook:event':
            dispatchEvent('hook:event', payload);
            break;
        case 'session:created':
            dispatchEvent('session:created', payload);
            break;
        case 'session:destroyed':
            dispatchEvent('session:destroyed', payload.sessionId || payload);
            break;
        case 'session:renamed':
            dispatchEvent('session:renamed', payload.sessionId, payload.name);
            break;
        case 'status:data':
            dispatchEvent('status:data', payload);
            break;
        case 'ui:action':
            dispatchEvent('ui:action:received', payload);
            break;
        case 'transcript:event':
            dispatchEvent('transcript:event', payload);
            break;
        case 'prompt:show':
            dispatchEvent('prompt:show', payload);
            break;
        case 'prompt:dismiss':
            dispatchEvent('prompt:dismiss', payload);
            break;
        case 'prompt:complete':
            dispatchEvent('prompt:complete', payload);
            break;
    }
}
function connect(passwordOrToken, isToken = false) {
    return new Promise((resolve, reject) => {
        setConnectionState('connecting');
        ws = new WebSocket(getWsUrl());
        ws.onopen = () => {
            setConnectionState('authenticating');
            const authMsg = isToken
                ? { type: 'auth', token: passwordOrToken }
                : { type: 'auth', password: passwordOrToken };
            ws.send(JSON.stringify(authMsg));
        };
        let authResolved = false;
        ws.onmessage = (event) => {
            if (!authResolved) {
                let msg;
                try {
                    msg = JSON.parse(event.data);
                }
                catch {
                    return;
                }
                if (msg.type === 'auth:ok') {
                    authResolved = true;
                    reconnectDelay = 1000; // Reset backoff on success
                    setConnectionState('connected');
                    // Store token for reconnection
                    const token = msg.token;
                    localStorage.setItem('destincode-remote-token', token);
                    // Preserve __PLATFORM__ when connecting to a remote desktop from Android —
                    // the desktop server responds with platform:"electron" but we're still on a phone
                    if (!preservePlatform) {
                        const platform = msg.platform || 'browser';
                        window.__PLATFORM__ = platform;
                    }
                    resolve(token);
                    // Switch to normal message handling
                    ws.onmessage = (e) => handleMessage(e.data);
                }
                else if (msg.type === 'auth:failed') {
                    authResolved = true;
                    setConnectionState('disconnected');
                    reject(new Error(msg.reason || 'Authentication failed'));
                    ws.close();
                }
                return;
            }
            handleMessage(event.data);
        };
        ws.onclose = () => {
            if (!authResolved) {
                setConnectionState('disconnected');
                reject(new Error('Connection closed before auth'));
                return;
            }
            setConnectionState('disconnected');
            // Attempt reconnection with stored token
            const storedToken = localStorage.getItem('destincode-remote-token');
            if (storedToken) {
                scheduleReconnect(storedToken);
            }
        };
        ws.onerror = () => {
            // onclose will fire after this
        };
    });
}
function scheduleReconnect(token) {
    if (reconnectTimer)
        return;
    reconnectTimer = setTimeout(async () => {
        reconnectTimer = null;
        try {
            await connect(token, true);
        }
        catch {
            reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY);
            scheduleReconnect(token);
        }
    }, reconnectDelay);
}
function disconnect() {
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }
    if (ws) {
        ws.close();
        ws = null;
    }
    setConnectionState('disconnected');
    localStorage.removeItem('destincode-remote-token');
}
/**
 * Connect to a remote desktop server. Disconnects from the current server first.
 * __PLATFORM__ is preserved as 'android' so touch adaptations stay active.
 */
async function connectToHost(host, port, password) {
    const { setConnectionMode } = await Promise.resolve().then(() => __importStar(require('./platform')));
    // Disconnect from current server (local bridge or previous remote)
    disconnect();
    // Reject any pending requests from the old server
    for (const [id, entry] of pending) {
        clearTimeout(entry.timeout);
        entry.reject(new Error('Server switched'));
    }
    pending.clear();
    // Point at the desktop server
    targetUrl = `ws://${host}:${port}/ws`;
    localStorage.setItem('destincode-remote-target', targetUrl);
    preservePlatform = true;
    // Connect with password auth
    await connect(password, false);
    preservePlatform = false;
    setConnectionMode('remote');
}
/**
 * Disconnect from a remote desktop and reconnect to the local bridge server.
 */
async function disconnectFromHost() {
    const { setConnectionMode } = await Promise.resolve().then(() => __importStar(require('./platform')));
    disconnect();
    for (const [id, entry] of pending) {
        clearTimeout(entry.timeout);
        entry.reject(new Error('Server switched'));
    }
    pending.clear();
    // Clear remote target — getWsUrl() falls back to localhost:9901
    targetUrl = null;
    localStorage.removeItem('destincode-remote-target');
    preservePlatform = false;
    // Reconnect to local bridge
    await connect('android-local', false);
    setConnectionMode('local');
}
/** Install the window.claude shim. Call once on app startup in browser mode. */
function installShim() {
    // Restore remote target from previous session (e.g., page reload while in remote mode)
    const savedTarget = localStorage.getItem('destincode-remote-target');
    if (savedTarget) {
        targetUrl = savedTarget;
        preservePlatform = true; // Will be set on next auth:ok
        // Restore connection mode synchronously so components render correctly on first paint
        Promise.resolve().then(() => __importStar(require('./platform'))).then(({ setConnectionMode }) => setConnectionMode('remote'));
    }
    window.claude = {
        session: {
            create: (opts) => invoke('session:create', opts),
            destroy: (sessionId) => invoke('session:destroy', { sessionId }),
            list: () => invoke('session:list'),
            browse: () => invoke('session:browse'),
            loadHistory: (sessionId, count, all, projectSlug) => invoke('session:history', { sessionId, count, all, projectSlug }),
            switch: (sessionId) => invoke('session:switch', { sessionId }),
            sendInput: (sessionId, text) => fire('session:input', { sessionId, text }),
            resize: (sessionId, cols, rows) => fire('session:resize', { sessionId, cols, rows }),
            signalReady: (sessionId) => fire('session:terminal-ready', { sessionId }),
            respondToPermission: (requestId, decision) => invoke('permission:respond', { requestId, decision }),
        },
        on: {
            sessionCreated: (cb) => addListener('session:created', cb),
            sessionDestroyed: (cb) => addListener('session:destroyed', cb),
            ptyOutput: (cb) => addListener('pty:output', cb),
            ptyOutputForSession: (sessionId, cb) => {
                const channel = `pty:output:${sessionId}`;
                const handler = addListener(channel, cb);
                return () => removeListener(channel, handler);
            },
            hookEvent: (cb) => addListener('hook:event', cb),
            statusData: (cb) => addListener('status:data', cb),
            sessionRenamed: (cb) => addListener('session:renamed', cb),
            uiAction: (cb) => addListener('ui:action:received', cb),
            transcriptEvent: (cb) => addListener('transcript:event', cb),
            promptShow: (cb) => addListener('prompt:show', cb),
            promptDismiss: (cb) => addListener('prompt:dismiss', cb),
            promptComplete: (cb) => addListener('prompt:complete', cb),
        },
        skills: {
            list: () => invoke('skills:list'),
            listMarketplace: (filters) => invoke('skills:list-marketplace', filters),
            getDetail: (id) => invoke('skills:get-detail', { id }),
            search: (query) => invoke('skills:search', { query }),
            install: (id) => invoke('skills:install', { id }),
            uninstall: (id) => invoke('skills:uninstall', { id }),
            getFavorites: () => invoke('skills:get-favorites'),
            setFavorite: (id, favorited) => invoke('skills:set-favorite', { id, favorited }),
            getChips: () => invoke('skills:get-chips'),
            setChips: (chips) => invoke('skills:set-chips', { chips }),
            getOverride: (id) => invoke('skills:get-override', { id }),
            setOverride: (id, override) => invoke('skills:set-override', { id, override }),
            createPrompt: (skill) => invoke('skills:create-prompt', skill),
            deletePrompt: (id) => invoke('skills:delete-prompt', { id }),
            publish: (id) => invoke('skills:publish', { id }),
            getShareLink: (id) => invoke('skills:get-share-link', { id }),
            importFromLink: (encoded) => invoke('skills:import-from-link', { encoded }),
            getCuratedDefaults: () => invoke('skills:get-curated-defaults'),
        },
        dialog: {
            openFile: async () => [],
            openFolder: async () => null,
            readTranscriptMeta: (p) => invoke('transcript:read-meta', { path: p }),
            saveClipboardImage: async () => null,
        },
        shell: {
            openChangelog: async () => { },
        },
        remote: {
            getConfig: () => invoke('remote:get-config'),
            setPassword: (password) => invoke('remote:set-password', password),
            setConfig: (updates) => invoke('remote:set-config', updates),
            detectTailscale: () => invoke('remote:detect-tailscale'),
            getClientCount: () => invoke('remote:get-client-count'),
            getClientList: () => invoke('remote:get-client-list'),
            disconnectClient: (clientId) => invoke('remote:disconnect-client', clientId),
            broadcastAction: (action) => fire('ui:action', action),
        },
        // Android-only bridge methods — only called when isAndroid() is true
        android: {
            getTier: () => invoke('android:get-tier'),
            setTier: (tier) => invoke('android:set-tier', { tier }),
            getDirectories: () => invoke('android:get-directories'),
            addDirectory: (path, label) => invoke('android:add-directory', { path, label }),
            removeDirectory: (path) => invoke('android:remove-directory', { path }),
            getAbout: () => invoke('android:get-about'),
            getPairedDevices: () => invoke('android:get-paired-devices'),
            savePairedDevice: (device) => invoke('android:save-paired-device', device),
            removePairedDevice: (host, port) => invoke('android:remove-paired-device', { host, port }),
            scanQr: () => invoke('android:scan-qr'),
        },
        off: (channel, handler) => removeListener(channel, handler),
        removeAllListeners: (channel) => removeAllListeners(channel),
        getGitHubAuth: () => invoke('github:auth'),
        getHomePath: () => invoke('get-home-path'),
        getFavorites: () => invoke('favorites:get'),
        setFavorites: (favorites) => invoke('favorites:set', favorites),
        getIncognito: () => invoke('game:getIncognito'),
        setIncognito: (incognito) => invoke('game:setIncognito', incognito),
    };
}
