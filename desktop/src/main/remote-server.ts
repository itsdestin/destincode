import http from 'http';
import zlib from 'zlib';
import { listProjectsIndex } from './artifacts/projects-index';
import { staticAssetPolicy } from './remote-static-policy';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { EventEmitter } from 'events';
import type { SessionManager } from './session-manager';
import type { HookRelay } from './hook-relay';
import type { RemoteConfig } from './remote-config';
import type { LocalSkillProvider } from './skill-provider';
import type { SerializedChatState } from '../renderer/state/chat-types';
import { VITE_DEV_PORT } from '../shared/ports';
import type { NativeSessionHost } from './harness/native-session-host';
import { NATIVE_META_UNSUPPORTED, type NativeSendResult } from '../shared/types';
import type { ProviderRegistry } from './providers/provider-registry';
import type { ModelCatalog } from './providers/model-catalog';
import type { SearchKeyStore } from './harness/search/search-key-store';
import type { SearchService } from './harness/search/search-service';
import type { EngineManager } from './engine/engine-manager';
import type { ModelManager } from './models/model-manager';
import { detectEndpoints } from './models/endpoint-detectors';
import { BrowserWindow } from 'electron';
import { readTranscriptMeta } from './transcript-utils';
import { listPastSessions, loadHistory } from './session-browser';
import { getSyncStatus, getSyncConfig, setSyncConfig, forceSync, getSyncLog, dismissWarning, addBackend, removeBackend, updateBackend, pushBackend } from './sync-state';
// Cross-device sync spaces (spec 2026-07-03) — same service functions the
// Electron IPC handlers call, so remote browsers get identical behavior.
import { syncSpacesStatus, syncSpacesEnable, syncSpacesSyncNow, syncSpacesCreateProject, syncSpacesImportProject, syncSpacesRenameProject, syncSpacesStopProject, getManagedRoots } from './sync-spaces/service';
import { readDevices, renameDevice, removeDevice } from './sync-spaces/device-registry';
import { checkSyncPrereqs, installRclone, checkGdriveRemote, authGdrive, authGithub, createGithubRepo } from './sync-setup-handlers';
// Connect-GitHub modal (device-flow auth). status/install are stateless direct
// calls; connect start/cancel drive the shared orchestrator singleton created in
// ipc-handlers (its emitDone broadcasts github:connect-done to remote clients).
import { installGh } from './github-auth';
import { combinedGithubStatus } from './github-client';
import { getGithubConnect, disconnectGithub } from './github-connect';

const PTY_BUFFER_SIZE = 4 * 1024 * 1024; // 4MB per session — enough for full conversation replay
const HOOK_BUFFER_SIZE = 10_000; // ~10MB max, covers full conversations without excessive memory
const AUTH_TIMEOUT_MS = 5000;
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_FAILURES = 5;

interface AuthenticatedClient {
  id: string;
  ws: WebSocket;
  token: string;
  ip: string;
  connectedAt: number;
}

export interface ClientInfo {
  id: string;
  ip: string;
  connectedAt: number;
}

export class RemoteServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  // Tracks whether start() has completed. start() used to be called exactly
  // once at app boot, so re-entrancy never came up; it is now also called from
  // the Settings toggle (IPC.REMOTE_SET_CONFIG), and a second start() would
  // double-subscribe the SessionManager/HookRelay listeners and listen() twice.
  private running = false;
  // Held so stop() can clear it. Previously this interval was created by start()
  // and never cancelled, so it survived stop() and a restart stacked another.
  private uploadCleanupTimer: ReturnType<typeof setInterval> | null = null;
  private clients = new Set<AuthenticatedClient>();
  private lastClientActivityMs = 0; // see getLastClientActivityMs()
  private tokens = new Map<string, boolean>(); // token → valid
  private tokensPath: string;
  // `${encoding}:${urlPath}` → compressed bytes. Safe to hold indefinitely
  // because Vite content-hashes the URLs it serves; see compressStatic().
  private compressedAssets = new Map<string, Buffer>();
  // Channels already warned about, so an unbridged channel that a client polls
  // logs once instead of every second. See the `default:` case in handleMessage.
  private warnedChannels = new Set<string>();
  private ptyBuffers = new Map<string, string>(); // sessionId → rolling PTY output
  private hookBuffers = new Map<string, any[]>(); // sessionId → rolling hook events
  // statusInterval removed — status data now fed by ipc-handlers.ts via broadcastStatusData()
  private failedAttempts = new Map<string, { count: number; resetAt: number }>();
  // Last-known topic names, fed by ipc-handlers.ts via setLastTopic()
  private lastTopics = new Map<string, string>();
  // Last-known context remaining %, fed by ipc-handlers.ts via broadcastStatusData()
  private contextMap: Record<string, number> = {};
  // Provider injected at construction — called when new clients connect to get the full chat state.
  // Task 6 wires this into replayBuffers(); declared here so the field exists before that step.
  private requestSnapshot: () => Promise<SerializedChatState>;
  // Native runtime stack — injected by ipc-handlers via setNativeRuntime() AFTER
  // it constructs the instances (they can't be built at RemoteServer construction
  // time because they live in the ipc-handlers scope). Null until wired; the
  // native:* / provider:* WS cases no-op until then.
  // Merge note: nativeRuntime carries modelManager (Plan C) AND the leaseWiring
  // field (Plan 2b) — both were added independently on master and this branch.
  private nativeRuntime: { nativeHost: NativeSessionHost; providerRegistry: ProviderRegistry; modelCatalog: ModelCatalog; engineManager: EngineManager; modelManager: ModelManager; searchKeyStore: SearchKeyStore; searchService: SearchService } | null = null;
  // Plan 2b Task 11: conversation-lease + device wiring, injected by ipc-handlers
  // via setLeaseWiring() AFTER main.ts builds the lease client/requester (they
  // live in the whenReady scope, not reachable at RemoteServer construction).
  // Null until wired; the syncspaces:lease-*/device WS cases degrade the same
  // way the desktop handlers do (free/error) so a remote resume never hard-blocks.
  private leaseWiring: {
    client: import('./conversations/lease-client').LeaseClient;
    requester: import('./conversations/takeover').RequesterTakeoverType;
    deviceId: string;  // per-INSTALL — leases only
    machineId: string; // per-MACHINE — device-registry self-marking only
  } | null = null;

  constructor(
    private sessionManager: SessionManager,
    private hookRelay: HookRelay,
    private config: RemoteConfig,
    private skillProvider?: LocalSkillProvider,
    opts?: { requestSnapshot?: () => Promise<SerializedChatState> },
  ) {
    this.tokensPath = path.join(os.homedir(), '.claude', '.remote-tokens.json');
    this.loadTokens();
    // Default is a no-op that returns an empty snapshot — allows the server to
    // be constructed before the main window exists (e.g. during first-run setup).
    this.requestSnapshot = opts?.requestSnapshot ?? (() => Promise.resolve({ sessions: [] }));
  }

  /** Injected by main.ts. Read-only access to the marketplace auth session so
   *  remote clients can see whether the host is signed in — the game lobby
   *  renders its sign-in screen off account:signed-in, so without this a remote
   *  browser showed "signed out" while the host app was signed in. */
  setAccountStore(store: { getToken(): string | null; getUser(): any }): void {
    this.accountStore = store;
  }
  private accountStore?: { getToken(): string | null; getUser(): any };

  /** Injected by ipc-handlers after it constructs the native stack, so remote
   *  WS clients reach the SAME nativeHost / providerRegistry / modelCatalog the
   *  Electron IPC handlers use (mirrors setLastTopic / broadcastStatusData). */
  setNativeRuntime(rt: { nativeHost: NativeSessionHost; providerRegistry: ProviderRegistry; modelCatalog: ModelCatalog; engineManager: EngineManager; modelManager: ModelManager; searchKeyStore: SearchKeyStore; searchService: SearchService }): void {
    this.nativeRuntime = rt;
  }

  /** True when this id belongs to a native session, which has no conversation-store
   *  record to write meta into yet (see NATIVE_META_UNSUPPORTED). Remote clients pass
   *  raw session ids — no sessionIdMap resolution is needed because native ids are
   *  mapped to themselves (ipc-handlers sets sessionIdMap identity for native).
   *  If the native runtime isn't wired yet there are no native sessions to protect,
   *  so the answer is false and the write proceeds as before. */
  private isNativeMetaTarget(sessionId: unknown): boolean {
    const rt = this.nativeRuntime;
    if (!rt) return false;
    return rt.nativeHost.isNativeSessionId(String(sessionId ?? ''));
  }

  /** Injected by ipc-handlers after main.ts builds the lease client/requester,
   *  so remote WS clients reach the SAME lease state the Electron IPC handlers
   *  use (mirrors setNativeRuntime). machineId marks self in list-devices —
   *  deviceId is the per-INSTALL lease id and must NOT be used for that. */
  setLeaseWiring(w: {
    client: import('./conversations/lease-client').LeaseClient;
    requester: import('./conversations/takeover').RequesterTakeoverType;
    deviceId: string;
    machineId: string;
  }): void {
    this.leaseWiring = w;
  }

  private loadTokens(): void {
    try {
      const data = JSON.parse(fs.readFileSync(this.tokensPath, 'utf8'));
      if (Array.isArray(data)) {
        for (const t of data) this.tokens.set(t, true);
      }
    } catch { /* no persisted tokens yet */ }
  }

  private saveTokens(): void {
    try {
      fs.mkdirSync(path.dirname(this.tokensPath), { recursive: true });
      // Security: restrict file permissions to owner-only (prevents other users reading tokens)
      fs.writeFileSync(this.tokensPath, JSON.stringify(Array.from(this.tokens.keys())), { mode: 0o600 });
    } catch { /* best effort */ }
  }

  /** True once start() has bound the port; false after stop() or a failed start. */
  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      console.log('[RemoteServer] Disabled in config, not starting');
      return;
    }
    if (this.running) return;

    // Re-read persisted tokens: stop() clears the in-memory map, and loadTokens()
    // only ran in the constructor. Without this, toggling remote access off and
    // back on forced every already-paired device to re-enter the password.
    this.loadTokens();

    // Subscribe to events for buffering and broadcasting
    this.sessionManager.on('pty-output', this.onPtyOutput);
    this.hookRelay.on('hook-event', this.onHookEvent);
    this.sessionManager.on('session-exit', this.onSessionExit);
    this.sessionManager.on('session-created', this.onSessionCreated);

    // Determine static file directory (production) or Vite dev server URL (development)
    const staticDir = path.join(__dirname, '..', 'renderer');
    // Fix: this fallback hardcoded port 5173 and ignored YOUCODED_PORT_OFFSET,
    // so a dev instance (Vite on 5223) proxied to a port with nothing on it and
    // every remote request returned a bare HTTP 502. main.ts:188 already derived
    // its dev URL from VITE_DEV_PORT; remote-server was the one place that
    // didn't. Never reintroduce a literal port here — import it from ports.ts.
    const viteDevUrl = process.env.VITE_DEV_SERVER_URL || `http://127.0.0.1:${VITE_DEV_PORT}`;
    // In dev mode, dist/renderer/index.html doesn't exist — proxy to Vite
    const hasStaticBuild = fs.existsSync(path.join(staticDir, 'index.html'));

    this.httpServer = http.createServer((req, res) => {
      if (hasStaticBuild) {
        this.handleHttpRequest(req, res, staticDir);
      } else {
        this.proxyToVite(req, res, viteDevUrl);
      }
    });

    // Security: limit message size to 50MB to prevent memory exhaustion attacks
    this.wss = new WebSocketServer({ server: this.httpServer, path: '/ws', maxPayload: 52428800 });
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));

    // Dev mode: proxy WebSocket upgrades (non-/ws) to Vite for HMR
    if (!hasStaticBuild) {
      this.httpServer.on('upgrade', (req, socket, head) => {
        if (req.url === '/ws') return; // handled by our WebSocketServer
        // Use http:// URL — WebSocket upgrade is an HTTP request with Upgrade header
        const proxyUrl = new URL(req.url || '/', viteDevUrl);
        const proxyReq = http.request(proxyUrl, {
          method: 'GET',
          headers: req.headers,
        });
        proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
          socket.write(
            `HTTP/1.1 101 Switching Protocols\r\n` +
            Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n') +
            '\r\n\r\n'
          );
          if (proxyHead.length) socket.write(proxyHead);
          proxySocket.pipe(socket);
          socket.pipe(proxySocket);
        });
        proxyReq.on('error', () => socket.destroy());
        proxyReq.end();
      });
    }

    // Status data is now fed by ipc-handlers.ts via broadcastStatusData() —
    // no independent polling needed. This eliminates duplicate file reads.

    // Cleanup uploaded files older than 1 hour
    const uploadDir = path.join(os.tmpdir(), 'claude-desktop-uploads');
    this.uploadCleanupTimer = setInterval(async () => {
      try {
        const files = await fs.promises.readdir(uploadDir);
        const now = Date.now();
        for (const file of files) {
          try {
            const stat = await fs.promises.stat(path.join(uploadDir, file));
            if (now - stat.mtimeMs > 3600_000) {
              await fs.promises.unlink(path.join(uploadDir, file));
            }
          } catch {}
        }
      } catch {}
    }, 3600_000);

    // Topic names are tracked by ipc-handlers.ts and forwarded via setLastTopic() + broadcast()

    // listen() errors (EADDRINUSE, EACCES) used to have no handler at all: the
    // promise simply never settled and the 'error' event went unhandled. That
    // was survivable when start() ran once during boot inside a try/catch that
    // only logged, but the Settings toggle now awaits this — an unsettled
    // promise would hang the toggle forever with no feedback. Reject with the
    // real OS error so the caller can surface it verbatim rather than guess.
    return new Promise<void>((resolve, reject) => {
      const server = this.httpServer!;
      let settled = false;
      const onError = (err: NodeJS.ErrnoException) => {
        if (settled) return;
        settled = true;
        // Roll back the half-built state (event subscriptions, timer, sockets)
        // so a retry starts clean instead of double-subscribing.
        this.stop();
        reject(err);
      };
      server.once('error', onError);
      server.listen(this.config.port, () => {
        if (settled) return;
        settled = true;
        server.removeListener('error', onError);
        this.running = true;
        console.log(`[RemoteServer] Listening on port ${this.config.port}`);
        resolve();
      });
    });
  }

  /** Store a topic name for replay on new connections. Called by ipc-handlers.ts. */
  setLastTopic(desktopId: string, name: string): void {
    this.lastTopics.set(desktopId, name);
  }

  /** Broadcast status data to all connected remote clients. Called by ipc-handlers.ts
   *  so that both the local renderer and remote clients share the same polling cycle. */
  broadcastStatusData(data: Record<string, any>): void {
    this.contextMap = data.contextMap || {};
    this.broadcast({ type: 'status:data', payload: data });
  }

  stop(): void {
    this.running = false;
    if (this.uploadCleanupTimer) {
      clearInterval(this.uploadCleanupTimer);
      this.uploadCleanupTimer = null;
    }
    this.lastTopics.clear();
    this.sessionManager.off('pty-output', this.onPtyOutput);
    this.hookRelay.off('hook-event', this.onHookEvent);
    this.sessionManager.off('session-exit', this.onSessionExit);
    this.sessionManager.off('session-created', this.onSessionCreated);

    for (const client of this.clients) {
      client.ws.close(1001, 'Server shutting down');
    }
    this.clients.clear();
    this.tokens.clear();

    if (this.wss) { this.wss.close(); this.wss = null; }
    if (this.httpServer) { this.httpServer.close(); this.httpServer = null; }
  }

  /** Invalidate all session tokens (e.g., after password change). */
  invalidateTokens(): void {
    this.tokens.clear();
    this.saveTokens();
    for (const client of this.clients) {
      client.ws.close(4001, 'Password changed');
    }
    this.clients.clear();
  }

  /** Number of currently connected remote clients. */
  getClientCount(): number {
    return this.clients.size;
  }

  /** Epoch ms of the last authenticated remote-client message (0 = never).
   *  Read by the presence idle poller (social-handlers.ts): someone driving
   *  the app through remote access produces no LOCAL keyboard/mouse input, so
   *  system idle time alone would wrongly mark them away. */
  getLastClientActivityMs(): number {
    return this.lastClientActivityMs;
  }

  /** List all connected remote clients. */
  getClientList(): ClientInfo[] {
    return Array.from(this.clients).map(c => ({
      id: c.id,
      ip: c.ip,
      connectedAt: c.connectedAt,
    }));
  }

  /** Disconnect a specific client by ID. */
  disconnectClient(clientId: string): boolean {
    for (const client of this.clients) {
      if (client.id === clientId) {
        client.ws.close(4002, 'Disconnected by admin');
        this.clients.delete(client);
        return true;
      }
    }
    return false;
  }

  // --- Event handlers for buffering ---

  private onPtyOutput = (sessionId: string, data: string) => {
    // Append to rolling buffer
    let buf = this.ptyBuffers.get(sessionId) || '';
    buf += data;
    if (buf.length > PTY_BUFFER_SIZE) {
      buf = buf.slice(buf.length - PTY_BUFFER_SIZE);
    }
    this.ptyBuffers.set(sessionId, buf);

    // Broadcast live
    this.broadcast({ type: 'pty:output', payload: { sessionId, data } });
  };

  private onHookEvent = (event: any) => {
    const sessionId = event.sessionId || '';

    // Append to rolling buffer
    let buf = this.hookBuffers.get(sessionId) || [];
    buf.push(event);
    if (buf.length > HOOK_BUFFER_SIZE) {
      buf = buf.slice(buf.length - HOOK_BUFFER_SIZE);
    }
    this.hookBuffers.set(sessionId, buf);

    // Broadcast live
    this.broadcast({ type: 'hook:event', payload: event });
  };

  private onSessionCreated = (info: any) => {
    this.broadcast({ type: 'session:created', payload: info });
  };

  private onSessionExit = (sessionId: string, exitCode: number = 0) => {
    this.ptyBuffers.delete(sessionId);
    this.hookBuffers.delete(sessionId);
    this.lastTopics.delete(sessionId);
    // Forward exitCode so the remote shim can surface 'session-died' banners
    // when Claude's process dies mid-turn on the host machine.
    this.broadcast({ type: 'session:destroyed', payload: { sessionId, exitCode } });
  };

  // --- HTTP static file serving ---

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse, staticDir: string): void {
    const url = req.url || '/';
    let filePath: string;

    if (url === '/' || url === '/index.html') {
      filePath = path.join(staticDir, 'index.html');
    } else {
      // Prevent directory traversal — decode percent-encoding first
      const decoded = decodeURIComponent(url);
      const safePath = path.normalize(decoded).replace(/^(\.\.[\/\\])+/, '');
      filePath = path.join(staticDir, safePath);
    }

    // Verify the resolved path is within staticDir
    if (!filePath.startsWith(staticDir)) {
      res.writeHead(403);
      res.end('Forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        // SPA fallback — serve index.html for non-file routes
        fs.readFile(path.join(staticDir, 'index.html'), (err2, html) => {
          if (err2) {
            res.writeHead(404);
            res.end('Not found');
          } else {
            this.sendStatic(req, res, '/index.html', '.html', html);
          }
        });
        return;
      }

      this.sendStatic(req, res, url, path.extname(filePath).toLowerCase(), data);
    });
  }

  /**
   * Writes a static asset with negotiated compression and cache headers.
   *
   * Before this, remote clients re-downloaded the ~2.14 MB uncompressed critical
   * path (2,016 kB entry chunk + 128 kB CSS) on every page load, with no caching
   * headers at all — the dominant cost of a first connect over a phone link.
   */
  private sendStatic(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    urlPath: string,
    ext: string,
    data: Buffer,
  ): void {
    const policy = staticAssetPolicy(urlPath, ext, req.headers['accept-encoding'] as string, data.length);

    const headers: Record<string, string> = {
      'Content-Type': policy.contentType,
      'Cache-Control': policy.cacheControl,
      // Caches key on the encoding we picked, or a gzip response can be replayed
      // to a client that never asked for one.
      Vary: 'Accept-Encoding',
    };

    if (!policy.encoding) {
      res.writeHead(200, headers);
      res.end(data);
      return;
    }

    const body = this.compressStatic(urlPath, policy.encoding, data);
    headers['Content-Encoding'] = policy.encoding;
    res.writeHead(200, headers);
    res.end(body);
  }

  /**
   * Compresses once per (asset, encoding) and reuses the result.
   *
   * Assets under assets/ are content-hashed, so a given URL's bytes never
   * change and the cached output can never go stale. This is what makes brotli
   * affordable — compressing a 2 MB chunk per request would cost far more than
   * the transfer it saves.
   */
  private compressStatic(urlPath: string, encoding: 'br' | 'gzip', data: Buffer): Buffer {
    const key = `${encoding}:${urlPath}`;
    const cached = this.compressedAssets.get(key);
    if (cached) return cached;

    const compressed = encoding === 'br'
      // Quality 5 rather than the default 11: near-gzip CPU cost for
      // meaningfully better ratios. At 11 the first request for the entry chunk
      // would stall for seconds.
      // Measured on the real 1,969 kB entry chunk (2026-07-20): q5 = 38 ms,
      // q11 = 4,719 ms. Do NOT raise this — the default (11) would stall the
      // first request by ~5 s, costing more than the transfer it saves.
      ? zlib.brotliCompressSync(data, {
          params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5 },
        })
      : zlib.gzipSync(data);

    // Bound the cache. A production build emits a handful of assets, but this
    // is fed by request URLs, so it must not be allowed to grow without limit.
    if (this.compressedAssets.size >= 64) this.compressedAssets.clear();
    this.compressedAssets.set(key, compressed);
    return compressed;
  }

  // --- Dev mode: proxy HTTP requests to Vite dev server ---

  private proxyToVite(req: http.IncomingMessage, res: http.ServerResponse, viteUrl: string): void {
    const url = new URL(req.url || '/', viteUrl);
    const proxyReq = http.request(url, {
      method: req.method,
      headers: req.headers,
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', () => {
      res.writeHead(502);
      res.end('Vite dev server not available');
    });
    req.pipe(proxyReq);
  }

  // --- WebSocket connection handling ---

  private handleConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const ip = req.socket.remoteAddress || '';

    // Check rate limiting
    if (this.isRateLimited(ip)) {
      ws.close(4029, 'Too many failed attempts');
      return;
    }

    // Auto-accept Tailscale-trusted connections
    if (this.config.trustTailscale && this.config.isTailscaleIp(ip)) {
      const token = randomUUID();
      this.tokens.set(token, true);
      this.saveTokens();
      this.config.markPaired();
      this.addClient(ws, token, ip);
      ws.send(JSON.stringify({ type: 'auth:ok', token, platform: 'desktop' }));
      this.replayBuffers(ws).catch((err) => {
        console.error('[remote-server] replayBuffers failed:', err);
      });
      return;
    }

    // Auth timeout
    const timeout = setTimeout(() => {
      ws.close(4000, 'Auth timeout');
    }, AUTH_TIMEOUT_MS);

    // Wait for auth message
    const authHandler = async (raw: Buffer | string) => {
      clearTimeout(timeout);
      ws.off('message', authHandler);

      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type !== 'auth') {
          ws.send(JSON.stringify({ type: 'auth:failed', reason: 'expected-auth' }));
          ws.close(4000, 'Expected auth');
          return;
        }

        // No password configured
        if (!this.config.passwordHash) {
          ws.send(JSON.stringify({ type: 'auth:failed', reason: 'no-password-configured' }));
          ws.close(4000, 'No password configured');
          return;
        }

        let authenticated = false;

        if (msg.token && this.tokens.has(msg.token)) {
          authenticated = true;
        } else if (msg.password) {
          authenticated = await this.config.verifyPassword(msg.password);
        }

        if (authenticated) {
          this.clearFailedAttempts(ip);
          const token = msg.token && this.tokens.has(msg.token) ? msg.token : randomUUID();
          this.tokens.set(token, true);
          this.saveTokens();
          this.config.markPaired();
          this.addClient(ws, token, ip);
          ws.send(JSON.stringify({ type: 'auth:ok', token, platform: 'desktop' }));
          this.replayBuffers(ws).catch((err) => {
            console.error('[remote-server] replayBuffers failed:', err);
          });
        } else {
          this.recordFailedAttempt(ip);
          ws.send(JSON.stringify({ type: 'auth:failed', reason: 'invalid-credentials' }));
          ws.close(4001, 'Auth failed');
        }
      } catch {
        ws.send(JSON.stringify({ type: 'auth:failed', reason: 'invalid-message' }));
        ws.close(4000, 'Invalid auth message');
      }
    };

    ws.on('message', authHandler);
  }

  private addClient(ws: WebSocket, token: string, ip: string): void {
    const client: AuthenticatedClient = { id: randomUUID(), ws, token, ip, connectedAt: Date.now() };
    this.clients.add(client);

    ws.on('message', (raw) => this.handleMessage(client, raw as Buffer | string));
    ws.on('close', () => this.clients.delete(client));
    ws.on('error', () => this.clients.delete(client));
  }

  // --- Replay buffers on new connection ---

  private async replayBuffers(ws: WebSocket): Promise<void> {
    // Session list — sent immediately so client can initialize chat state
    const sessions = this.sessionManager.listSessions();
    ws.send(JSON.stringify({
      type: 'session:list:response',
      id: '_replay',
      payload: sessions,
    }));

    for (const session of sessions) {
      ws.send(JSON.stringify({ type: 'session:created', payload: session }));
    }

    // Send current topic names for all mapped sessions
    for (const [desktopId, name] of this.lastTopics) {
      ws.send(JSON.stringify({ type: 'session:renamed', payload: { sessionId: desktopId, name } }));
    }

    // NEW: request a snapshot of the desktop's chat reducer state and push it
    // to the connecting client so they see the full chat history immediately.
    // Must happen before PTY/hook replay so the reducer has state to merge
    // subsequent transcript events into.
    try {
      const snapshot = await this.requestSnapshot();
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'chat:hydrate', payload: snapshot }));
      }
    } catch (err) {
      console.error('[remote-server] chat:hydrate failed:', err);
    }

    // Delay PTY + hook replay to give the client time to process SESSION_INIT.
    // Without this delay, hook events arrive before the chat reducer has
    // initialized the session state, and all events are silently dropped.
    // Note: the preceding `requestSnapshot()` await can take up to 2000ms
    // (its internal timeout), so the worst-case total delay before PTY/hook
    // replay starts is ~2500ms for a connect when the renderer is unresponsive.
    setTimeout(() => {
      if (ws.readyState !== WebSocket.OPEN) return;

      // PTY buffers
      for (const [sessionId, buf] of this.ptyBuffers) {
        if (buf.length > 0) {
          ws.send(JSON.stringify({ type: 'pty:output', payload: { sessionId, data: buf } }));
        }
      }

      // Hook event buffers
      for (const [_sessionId, events] of this.hookBuffers) {
        for (const event of events) {
          ws.send(JSON.stringify({ type: 'hook:event', payload: event }));
        }
      }

    }, 500); // 500ms gives React time to render App and register SESSION_INIT
  }

  // --- Message routing ---

  private async handleMessage(client: AuthenticatedClient, raw: Buffer | string): Promise<void> {
    let msg: any;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // Presence-activity stamp (see getLastClientActivityMs). Any parsed frame
    // counts: a remote user's typing arrives as pty:input / chat sends, and
    // even passive viewing produces periodic client messages.
    this.lastClientActivityMs = Date.now();

    const { type, id, payload } = msg;

    switch (type) {
      // --- Request/response ---
      case 'session:create': {
        const info = this.sessionManager.createSession(payload);
        this.respond(client.ws, type, id, info);
        // session:created broadcast is handled by the onSessionCreated event listener
        break;
      }
      case 'session:destroy': {
        // Tear down the native HarnessSession too (mirrors Electron
        // SESSION_DESTROY) so a native session isn't leaked when destroyed via
        // remote. No-op for non-native ids; guarded until the stack is wired.
        await this.nativeRuntime?.nativeHost.destroy(payload.sessionId || payload);
        const result = this.sessionManager.destroySession(payload.sessionId || payload);
        this.respond(client.ws, type, id, result);
        if (result) {
          this.broadcast({ type: 'session:destroyed', payload: { sessionId: payload.sessionId || payload } });
        }
        break;
      }
      case 'session:list': {
        const sessions = this.sessionManager.listSessions();
        this.respond(client.ws, type, id, sessions);
        break;
      }
      case 'session:switch': {
        // Session switching is client-side state — acknowledge so the request doesn't time out
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'session:browse': {
        const activeIds = new Set(this.sessionManager.listSessions().map(s => s.id));
        const sessions = await listPastSessions(activeIds);
        this.respond(client.ws, type, id, sessions);
        break;
      }
      // --- Native runtime (Phase 1 Plan A) — same instances as Electron IPC ---
      case 'native:set-binding': {
        const ok = this.nativeRuntime ? await this.nativeRuntime.nativeHost.setBinding(payload.sessionId, payload.binding) : false;
        this.respond(client.ws, type, id, ok);
        break;
      }
      case 'native:set-permission-mode': {
        // setPermissionMode THROWS on an unknown mode string — respond an error
        // object (same convention as the provider CRUD handlers below) so the
        // remote client's request id resolves instead of hanging to timeout.
        try {
          const mode = this.nativeRuntime ? this.nativeRuntime.nativeHost.setPermissionMode(payload.sessionId, payload.mode) : null;
          this.respond(client.ws, type, id, mode);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'native:get-permission-mode': {
        // Read-only — never throws. Falls back to 'ask' when no native runtime
        // (mirrors NativeSessionHost.getPermissionMode's default).
        const mode = this.nativeRuntime ? this.nativeRuntime.nativeHost.getPermissionMode(payload.sessionId) : 'ask';
        this.respond(client.ws, type, id, mode);
        break;
      }
      case 'native:send': {
        // M1: mirrors the desktop invoke — never throw (transport-parity rule).
        const notLive = { status: 'failed', reason: 'not-live' } satisfies NativeSendResult;
        const result = this.nativeRuntime ? this.nativeRuntime.nativeHost.send(payload.sessionId, payload.text) : notLive;
        this.respond(client.ws, type, id, result);
        break;
      }
      // Task 11: removeQueued is sync + never throws — mirrors the desktop invoke.
      case 'native:queue-remove': {
        const removed = this.nativeRuntime ? this.nativeRuntime.nativeHost.removeQueued(payload.sessionId, payload.queueId) : false;
        this.respond(client.ws, type, id, removed);
        break;
      }
      case 'native:sessions-list': {
        this.respond(client.ws, type, id, this.nativeRuntime ? this.nativeRuntime.nativeHost.list() : []);
        break;
      }
      case 'provider:list': {
        this.respond(client.ws, type, id, this.nativeRuntime ? await this.nativeRuntime.providerRegistry.list() : []);
        break;
      }
      // The provider CRUD/key/catalog handlers can THROW (bad input, built-in
      // removal, keychain failure). Each responds an error object on throw so
      // the remote client's request id resolves instead of hanging to timeout.
      case 'provider:upsert': {
        try {
          const res = this.nativeRuntime ? await this.nativeRuntime.providerRegistry.upsert(payload) : null;
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'provider:remove': {
        try {
          if (this.nativeRuntime) await this.nativeRuntime.providerRegistry.remove(payload.id ?? payload);
          this.respond(client.ws, type, id, true);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'provider:test': {
        try {
          const res = this.nativeRuntime
            ? await this.nativeRuntime.providerRegistry.testConnection(payload.id ?? payload)
            : { ok: false, message: 'Native runtime not available.' };
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, message: err?.message ?? String(err) });
        }
        break;
      }
      case 'provider:set-key': {
        try {
          if (this.nativeRuntime) await this.nativeRuntime.providerRegistry.setKey(payload.id, payload.key);
          this.respond(client.ws, type, id, true);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'provider:catalog': {
        try {
          const res = this.nativeRuntime
            ? await this.nativeRuntime.modelCatalog.get(await this.nativeRuntime.providerRegistry.list())
            : [];
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      // WebSearch providers (Phase 2 Plan B) — mirror the desktop IPC handlers so
      // remote WS clients reach the SAME searchKeyStore/searchService instances.
      // set/remove-key can throw (empty key, keychain failure); each responds an
      // error object so the client's request id resolves instead of timing out.
      // search:test is never-throws — { ok, message } is the result.
      case 'search:list': {
        this.respond(client.ws, type, id, this.nativeRuntime ? await this.nativeRuntime.searchKeyStore.list() : []);
        break;
      }
      case 'search:set-key': {
        try {
          if (this.nativeRuntime) await this.nativeRuntime.searchKeyStore.setKey(payload.backend, payload.key);
          this.respond(client.ws, type, id, true);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'search:remove-key': {
        try {
          if (this.nativeRuntime) await this.nativeRuntime.searchKeyStore.removeKey(payload.backend);
          this.respond(client.ws, type, id, true);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'search:test': {
        const res = this.nativeRuntime
          ? await this.nativeRuntime.searchService.testBackend(payload.backend, payload.key)
          : { ok: false, message: 'Native runtime not available.' };
        this.respond(client.ws, type, id, res);
        break;
      }
      case 'tags:list': {
        const { getTagRegistry } = await import('./conversations/tag-registry-service');
        const reg = getTagRegistry();
        const list = reg ? await reg.list().catch(() => []) : [];
        this.respond(client.ws, type, id, list);
        break;
      }
      case 'tags:create': {
        const { getTagRegistry } = await import('./conversations/tag-registry-service');
        const reg = getTagRegistry();
        if (!reg) { this.respond(client.ws, type, id, { ok: false, error: 'tag registry unavailable' }); break; }
        try {
          const tag = await reg.create(String(payload?.label ?? ''), payload?.color);
          this.broadcast({ type: 'tags:changed', payload: {} });
          this.respond(client.ws, type, id, { ok: true, tag });
        } catch (e: any) { this.respond(client.ws, type, id, { ok: false, error: e?.message || String(e) }); }
        break;
      }
      case 'tags:update': {
        const { getTagRegistry } = await import('./conversations/tag-registry-service');
        const reg = getTagRegistry();
        if (!reg) { this.respond(client.ws, type, id, { ok: false, error: 'tag registry unavailable' }); break; }
        try {
          const tag = await reg.update(String(payload?.id), payload?.patch ?? {});
          this.broadcast({ type: 'tags:changed', payload: {} });
          this.respond(client.ws, type, id, { ok: true, tag });
        } catch (e: any) { this.respond(client.ws, type, id, { ok: false, error: e?.message || String(e) }); }
        break;
      }
      case 'tags:delete': {
        const { getTagRegistry } = await import('./conversations/tag-registry-service');
        const reg = getTagRegistry();
        if (!reg) { this.respond(client.ws, type, id, { ok: false, error: 'tag registry unavailable' }); break; }
        try {
          await reg.delete(String(payload?.id));
          this.broadcast({ type: 'tags:changed', payload: {} });
          this.respond(client.ws, type, id, { ok: true });
        } catch (e: any) { this.respond(client.ws, type, id, { ok: false, error: e?.message || String(e) }); }
        break;
      }
      case 'session:set-tag': {
        const { noteFlagChanged } = await import('./conversations/service');
        const { tagFlagKey } = await import('../shared/tags');
        const tagId = String(payload?.tagId ?? '');
        if (!tagId.startsWith('tag_')) { this.respond(client.ws, type, id, { ok: false, error: 'invalid tag id' }); break; }
        // Same native refusal as the ipcMain handler. Without this the remote path
        // still seeds the phantom provider:'claude' record the 2026-07-18 gate was
        // written to prevent — a phone tagging a native session bypassed it entirely.
        if (this.isNativeMetaTarget(payload?.sessionId)) {
          this.respond(client.ws, type, id, { ok: false, error: NATIVE_META_UNSUPPORTED, unsupported: true, unsupportedReason: NATIVE_META_UNSUPPORTED });
          break;
        }
        noteFlagChanged(String(payload?.sessionId), tagFlagKey(tagId), !!payload?.value);
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'session:set-note': {
        const { noteSessionNote } = await import('./conversations/service');
        const text = String(payload?.note ?? '');
        if (text.length > 8000) { this.respond(client.ws, type, id, { ok: false, error: 'note too long' }); break; }
        if (this.isNativeMetaTarget(payload?.sessionId)) {
          this.respond(client.ws, type, id, { ok: false, error: NATIVE_META_UNSUPPORTED, unsupported: true, unsupportedReason: NATIVE_META_UNSUPPORTED });
          break;
        }
        noteSessionNote(String(payload?.sessionId), text);
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'session:get-meta': {
        const { getConversationStore } = await import('./conversations/service');
        const store = getConversationStore();
        let out = { tags: [] as string[], note: '', supported: true };
        if (this.isNativeMetaTarget(payload?.sessionId)) {
          this.respond(client.ws, type, id, { tags: [], note: '', supported: false, unsupportedReason: NATIVE_META_UNSUPPORTED });
          break;
        }
        if (store) {
          try {
            const rec = await store.get('claude', String(payload?.sessionId));
            if (rec) {
              const tags: string[] = [];
              for (const [k, v] of Object.entries(rec.flags)) {
                if ((v as any).value && k.startsWith('tag:')) tags.push(k.slice(4));
              }
              out = { tags, note: rec.note || '', supported: true };
            }
          } catch { /* fall through to empty */ }
        }
        this.respond(client.ws, type, id, out);
        break;
      }
      // Local engine (Plan B). status is sync; install/restart resolve to a
      // fresh status() so the remote client mirrors the desktop IPC contract.
      case 'engine:status': {
        this.respond(client.ws, type, id, this.nativeRuntime ? this.nativeRuntime.engineManager.status() : null);
        break;
      }
      case 'engine:install': {
        try {
          if (this.nativeRuntime) await this.nativeRuntime.engineManager.install();
          this.respond(client.ws, type, id, this.nativeRuntime?.engineManager.status() ?? null);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'engine:restart': {
        try {
          if (this.nativeRuntime) await this.nativeRuntime.engineManager.restart();
          this.respond(client.ws, type, id, this.nativeRuntime?.engineManager.status() ?? null);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      // Model manager (Plan C). Every handler can throw (network, HF API, disk
      // guard, bad input) so each responds an error object on throw — the remote
      // client's request id resolves instead of hanging to timeout. Payloads are
      // objects matching remote-shim's invoke() calls (payload.query / .repo /
      // .quant / .downloadId / .id / .backend). download-progress is broadcast
      // from ipc-handlers' emitter; no per-case push needed here.
      case 'engine:set-backend': {
        try {
          if (this.nativeRuntime) await this.nativeRuntime.engineManager.setBackend((payload.backend ?? payload) as any);
          this.respond(client.ws, type, id, this.nativeRuntime?.engineManager.status() ?? null);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'engine:set-context': {
        try {
          if (this.nativeRuntime) await this.nativeRuntime.engineManager.setContext((payload.contextSize ?? payload) as number);
          this.respond(client.ws, type, id, this.nativeRuntime?.engineManager.status() ?? null);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'models:curated': {
        try {
          const res = this.nativeRuntime ? await this.nativeRuntime.modelManager.curatedList() : [];
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'models:search': {
        try {
          const res = this.nativeRuntime ? await this.nativeRuntime.modelManager.search(payload.query ?? payload) : [];
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'models:quants': {
        try {
          const res = this.nativeRuntime ? await this.nativeRuntime.modelManager.quants(payload.repo ?? payload) : [];
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'models:download': {
        try {
          const res = this.nativeRuntime ? await this.nativeRuntime.modelManager.download(payload.repo, payload.quant) : null;
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'models:download-cancel': {
        try {
          this.nativeRuntime?.modelManager.cancel(payload.downloadId ?? payload);
          this.respond(client.ws, type, id, true);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'models:delete': {
        try {
          if (this.nativeRuntime) await this.nativeRuntime.engineManager.deleteModel(payload.id ?? payload);
          this.respond(client.ws, type, id, true);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'models:installed': {
        try {
          const res = this.nativeRuntime ? await this.nativeRuntime.engineManager.installedModels() : [];
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      // Orphaned .partial scan (2026-07-15) — mirrors the Electron IPC handler.
      case 'models:orphaned-partials': {
        try {
          const res = this.nativeRuntime ? this.nativeRuntime.modelManager.orphanedPartials() : [];
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'engine:models': {
        try {
          const res = this.nativeRuntime ? await this.nativeRuntime.engineManager.liveModels() : [];
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'models:memory-check': {
        try {
          const res = this.nativeRuntime
            ? await this.nativeRuntime.modelManager.memoryCheck(payload.modelId ?? payload)
            : { verdict: 'ok', headline: '', detail: '' };
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'models:load': {
        try {
          if (this.nativeRuntime) await this.nativeRuntime.engineManager.loadModel(payload.modelId ?? payload);
          this.respond(client.ws, type, id, true);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'endpoints:detect': {
        try {
          const res = this.nativeRuntime
            ? await detectEndpoints(fetch, await this.nativeRuntime.providerRegistry.list())
            : [];
          this.respond(client.ws, type, id, res);
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: err?.message ?? String(err) });
        }
        break;
      }
      case 'session:history': {
        const { sessionId: histSessionId, count, all } = payload;
        // Find the JSONL file across all project slugs
        const projectsDir = path.join(os.homedir(), '.claude', 'projects');
        const slugs = await fs.promises.readdir(projectsDir).catch(() => [] as string[]);
        let foundSlug = '';
        for (const slug of slugs) {
          const candidate = path.join(projectsDir, slug, histSessionId + '.jsonl');
          try {
            await fs.promises.access(candidate);
            foundSlug = slug;
            break;
          } catch {}
        }
        if (!foundSlug) {
          this.respond(client.ws, type, id, []);
          break;
        }
        const history = await loadHistory(histSessionId, foundSlug, count, all);
        this.respond(client.ws, type, id, history);
        break;
      }
      case 'permission:respond': {
        const { requestId, decision } = payload;
        // Native asks share the channel; 'native-'-prefixed ids route to the
        // broker first, then fall through to hookRelay (mirrors ipc-handlers).
        const result = this.nativeRuntime?.nativeHost.respondPermission(requestId, decision)
          ? true
          : this.hookRelay.respond(requestId, decision);
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:list': {
        const skills = this.skillProvider ? await this.skillProvider.getInstalled() : [];
        this.respond(client.ws, type, id, skills);
        break;
      }
      case 'skills:list-marketplace': {
        const result = this.skillProvider ? await this.skillProvider.listMarketplace(payload) : [];
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:get-detail': {
        const result = this.skillProvider ? await this.skillProvider.getSkillDetail(payload.id) : null;
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:search': {
        const result = this.skillProvider ? await this.skillProvider.search(payload.query) : [];
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:install': {
        const installResult = this.skillProvider
          ? await this.skillProvider.install(payload.id)
          : { status: 'failed' as const, error: 'Skill provider not initialized' };
        // Reload plugins so Claude Code discovers the new plugin. Delayed
        // via broadcastReloadPlugins() to avoid racing the prompt-ready state.
        if (installResult.status === 'installed' && 'type' in installResult && installResult.type === 'plugin') {
          this.sessionManager.broadcastReloadPlugins();
        }
        this.respond(client.ws, type, id, installResult);
        break;
      }
      case 'skills:uninstall': {
        const uninstallResult = this.skillProvider
          ? await this.skillProvider.uninstall(payload.id)
          : { type: 'prompt' as const };
        // Reload plugins so Claude Code drops the uninstalled plugin — matches
        // Android behavior (SessionService.kt:490)
        if (uninstallResult.type === 'plugin') {
          this.sessionManager.broadcastReloadPlugins();
        }
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'skills:get-favorites': {
        const result = this.skillProvider ? await this.skillProvider.getFavorites() : [];
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:set-favorite': {
        if (this.skillProvider) await this.skillProvider.setFavorite(payload.id, payload.favorited);
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'skills:get-chips': {
        const result = this.skillProvider ? await this.skillProvider.getChips() : [];
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:set-chips': {
        if (this.skillProvider) await this.skillProvider.setChips(payload.chips);
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'skills:get-override': {
        const overrides = this.skillProvider ? await this.skillProvider.getOverrides() : {};
        this.respond(client.ws, type, id, overrides[payload.id] || null);
        break;
      }
      case 'skills:set-override': {
        if (this.skillProvider) await this.skillProvider.setOverride(payload.id, payload.override);
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'skills:create-prompt': {
        const result = this.skillProvider ? await this.skillProvider.createPromptSkill(payload) : null;
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:delete-prompt': {
        if (this.skillProvider) await this.skillProvider.deletePromptSkill(payload.id);
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'skills:publish': {
        const result = this.skillProvider ? await this.skillProvider.publish(payload.id) : null;
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:get-share-link': {
        const result = this.skillProvider ? await this.skillProvider.generateShareLink(payload.id) : '';
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:import-from-link': {
        const result = this.skillProvider ? await this.skillProvider.importFromLink(payload.encoded) : null;
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:get-curated-defaults': {
        const result = this.skillProvider ? await this.skillProvider.getCuratedDefaults() : [];
        this.respond(client.ws, type, id, result);
        break;
      }
      // Decomposition v3 §9.9: integration badges via remote/Android session
      case 'skills:get-integration-info': {
        const result = this.skillProvider
          ? await this.skillProvider.getIntegrationInfo(payload.id as string)
          : { provides: [], optionalIntegrations: [] };
        this.respond(client.ws, type, id, result);
        break;
      }
      // Decomposition v3 §9.10: onboarding helpers via remote/Android
      case 'skills:install-many': {
        const result = this.skillProvider
          ? await this.skillProvider.installMany((payload.ids as string[]) || [])
          : [];
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'skills:apply-output-style': {
        if (this.skillProvider) this.skillProvider.applyOutputStyle(payload.styleId as string);
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'file:upload': {
        const uploadDir = path.join(os.tmpdir(), 'claude-desktop-uploads');
        try {
          await fs.promises.mkdir(uploadDir, { recursive: true });
          // Sanitize filename — strip path separators and limit length
          const rawName = String(payload.name || 'upload').replace(/[/\\:*?"<>|]/g, '_').slice(0, 200);
          const filePath = path.join(uploadDir, `${Date.now()}-${rawName}`);
          const buffer = Buffer.from(payload.data, 'base64');
          await fs.promises.writeFile(filePath, buffer);
          this.respond(client.ws, type, id, { path: filePath });
        } catch (err) {
          this.respond(client.ws, type, id, { error: 'Upload failed' });
        }
        break;
      }
      case 'model:get-preference': {
        const modelPrefPath = path.join(os.homedir(), '.claude', 'youcoded-model.json');
        try {
          const raw = await fs.promises.readFile(modelPrefPath, 'utf8');
          const parsed = JSON.parse(raw);
          this.respond(client.ws, type, id, parsed.model || 'sonnet');
        } catch {
          this.respond(client.ws, type, id, 'sonnet');
        }
        break;
      }
      case 'model:set-preference': {
        const modelPrefPath = path.join(os.homedir(), '.claude', 'youcoded-model.json');
        const model = payload.model || payload;
        try {
          await fs.promises.mkdir(path.dirname(modelPrefPath), { recursive: true });
          await fs.promises.writeFile(modelPrefPath, JSON.stringify({ model }));
          this.respond(client.ws, type, id, true);
        } catch {
          this.respond(client.ws, type, id, false);
        }
        break;
      }
      case 'appearance:get': {
        const appearancePath = path.join(os.homedir(), '.claude', 'youcoded-appearance.json');
        try {
          const raw = await fs.promises.readFile(appearancePath, 'utf8');
          this.respond(client.ws, type, id, JSON.parse(raw));
        } catch {
          this.respond(client.ws, type, id, null);
        }
        break;
      }
      case 'appearance:set': {
        const appearancePath = path.join(os.homedir(), '.claude', 'youcoded-appearance.json');
        try {
          let existing: Record<string, any> = {};
          try {
            existing = JSON.parse(await fs.promises.readFile(appearancePath, 'utf8'));
          } catch {}
          const merged = { ...existing, ...payload };
          await fs.promises.mkdir(path.dirname(appearancePath), { recursive: true });
          await fs.promises.writeFile(appearancePath, JSON.stringify(merged));
          this.respond(client.ws, type, id, true);
        } catch {
          this.respond(client.ws, type, id, false);
        }
        break;
      }
      case 'defaults:get': {
        const defaultsPrefPath = path.join(os.homedir(), '.claude', 'youcoded-defaults.json');
        const DEFAULTS_INITIAL = { skipPermissions: false, model: 'sonnet', projectFolder: '' };
        try {
          const raw = await fs.promises.readFile(defaultsPrefPath, 'utf8');
          this.respond(client.ws, type, id, { ...DEFAULTS_INITIAL, ...JSON.parse(raw) });
        } catch {
          this.respond(client.ws, type, id, { ...DEFAULTS_INITIAL });
        }
        break;
      }
      case 'defaults:set': {
        const defaultsPrefPath = path.join(os.homedir(), '.claude', 'youcoded-defaults.json');
        const DEFAULTS_INITIAL = { skipPermissions: false, model: 'sonnet', projectFolder: '' };
        try {
          let current = { ...DEFAULTS_INITIAL };
          try { current = { ...current, ...JSON.parse(await fs.promises.readFile(defaultsPrefPath, 'utf8')) }; } catch {}
          const merged = { ...current, ...payload };
          await fs.promises.writeFile(defaultsPrefPath, JSON.stringify(merged, null, 2));
          this.respond(client.ws, type, id, merged);
        } catch {
          this.respond(client.ws, type, id, null);
        }
        break;
      }
      case 'get-home-path': {
        this.respond(client.ws, type, id, os.homedir());
        break;
      }
      // Claude Code settings.json bridge — mirrors ipc-handlers.ts 'settings:get'/'settings:set'.
      // Dot-path keys supported (e.g. 'permissions.defaultMode').
      case 'settings:get': {
        const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        try {
          const raw = await fs.promises.readFile(claudeSettingsPath, 'utf-8');
          const parsed = JSON.parse(raw);
          const field: string = (payload as any)?.field ?? '';
          const value = field.split('.').reduce((obj: any, k) => (obj == null ? undefined : obj[k]), parsed);
          this.respond(client.ws, type, id, value);
        } catch {
          this.respond(client.ws, type, id, undefined);
        }
        break;
      }
      // Fast + effort mode persistence — mirrors ipc-handlers.ts 'modes:get'/'modes:set'.
      case 'modes:get': {
        const modelModesPath = path.join(os.homedir(), '.claude', 'youcoded-model-modes.json');
        try {
          const raw = await fs.promises.readFile(modelModesPath, 'utf-8');
          this.respond(client.ws, type, id, JSON.parse(raw));
        } catch {
          this.respond(client.ws, type, id, { fast: false, effort: 'auto' });
        }
        break;
      }
      case 'modes:set': {
        const modelModesPath = path.join(os.homedir(), '.claude', 'youcoded-model-modes.json');
        try {
          let current = { fast: false, effort: 'auto' } as Record<string, any>;
          try { current = { ...current, ...JSON.parse(await fs.promises.readFile(modelModesPath, 'utf-8')) }; } catch {}
          const merged = { ...current, ...(payload as Record<string, any>) };
          await fs.promises.mkdir(path.dirname(modelModesPath), { recursive: true });
          await fs.promises.writeFile(modelModesPath, JSON.stringify(merged));
          this.respond(client.ws, type, id, merged);
        } catch {
          this.respond(client.ws, type, id, null);
        }
        break;
      }
      case 'settings:set': {
        const claudeSettingsPath = path.join(os.homedir(), '.claude', 'settings.json');
        try {
          let existing: Record<string, any> = {};
          try { existing = JSON.parse(await fs.promises.readFile(claudeSettingsPath, 'utf-8')); } catch {}
          const field: string = (payload as any)?.field ?? '';
          const value = (payload as any)?.value;
          const keys = field.split('.');
          let cursor = existing;
          for (let i = 0; i < keys.length - 1; i++) {
            const k = keys[i];
            if (cursor[k] == null || typeof cursor[k] !== 'object') cursor[k] = {};
            cursor = cursor[k];
          }
          if (value === null || value === undefined) {
            delete cursor[keys[keys.length - 1]];
          } else {
            cursor[keys[keys.length - 1]] = value;
          }
          await fs.promises.mkdir(path.dirname(claudeSettingsPath), { recursive: true });
          await fs.promises.writeFile(claudeSettingsPath, JSON.stringify(existing, null, 2));
          this.respond(client.ws, type, id, true);
        } catch {
          this.respond(client.ws, type, id, false);
        }
        break;
      }
      case 'folders:list': {
        const foldersPrefPath = path.join(os.homedir(), '.claude', 'youcoded-folders.json');
        try {
          const raw = await fs.promises.readFile(foldersPrefPath, 'utf8');
          let folders = JSON.parse(raw);
          if (!Array.isArray(folders)) folders = [];
          if (folders.length === 0) {
            const home = os.homedir();
            folders = [{ path: home, nickname: 'Home', addedAt: Date.now() }];
            await fs.promises.writeFile(foldersPrefPath, JSON.stringify(folders, null, 2));
          }
          const annotated = folders.map((f: any) => ({ ...f, exists: fs.existsSync(f.path) }));
          this.respond(client.ws, type, id, annotated);
        } catch {
          const home = os.homedir();
          const folders = [{ path: home, nickname: 'Home', addedAt: Date.now(), exists: true }];
          this.respond(client.ws, type, id, folders);
        }
        break;
      }
      case 'folders:add': {
        const foldersPrefPath = path.join(os.homedir(), '.claude', 'youcoded-folders.json');
        try {
          let folders: any[] = [];
          try { folders = JSON.parse(await fs.promises.readFile(foldersPrefPath, 'utf8')); } catch {}
          if (!Array.isArray(folders)) folders = [];
          const normalized = path.resolve(payload.folderPath);
          if (folders.some((f: any) => path.resolve(f.path) === normalized)) {
            this.respond(client.ws, type, id, folders.find((f: any) => path.resolve(f.path) === normalized));
            break;
          }
          const entry = { path: normalized, nickname: payload.nickname || path.basename(normalized), addedAt: Date.now() };
          folders.unshift(entry);
          await fs.promises.mkdir(path.dirname(foldersPrefPath), { recursive: true });
          await fs.promises.writeFile(foldersPrefPath, JSON.stringify(folders, null, 2));
          this.respond(client.ws, type, id, entry);
        } catch {
          this.respond(client.ws, type, id, null);
        }
        break;
      }
      case 'folders:remove': {
        const foldersPrefPath = path.join(os.homedir(), '.claude', 'youcoded-folders.json');
        try {
          let folders: any[] = [];
          try { folders = JSON.parse(await fs.promises.readFile(foldersPrefPath, 'utf8')); } catch {}
          if (!Array.isArray(folders)) folders = [];
          const normalized = path.resolve(payload.folderPath);
          const filtered = folders.filter((f: any) => path.resolve(f.path) !== normalized);
          if (filtered.length === folders.length) { this.respond(client.ws, type, id, false); break; }
          await fs.promises.writeFile(foldersPrefPath, JSON.stringify(filtered, null, 2));
          this.respond(client.ws, type, id, true);
        } catch {
          this.respond(client.ws, type, id, false);
        }
        break;
      }
      case 'folders:rename': {
        const foldersPrefPath = path.join(os.homedir(), '.claude', 'youcoded-folders.json');
        try {
          let folders: any[] = [];
          try { folders = JSON.parse(await fs.promises.readFile(foldersPrefPath, 'utf8')); } catch {}
          if (!Array.isArray(folders)) folders = [];
          const normalized = path.resolve(payload.folderPath);
          const entry = folders.find((f: any) => path.resolve(f.path) === normalized);
          if (!entry) { this.respond(client.ws, type, id, false); break; }
          entry.nickname = payload.nickname;
          await fs.promises.writeFile(foldersPrefPath, JSON.stringify(folders, null, 2));
          this.respond(client.ws, type, id, true);
        } catch {
          this.respond(client.ws, type, id, false);
        }
        break;
      }
      case 'favorites:get': {
        const favPath = path.join(os.homedir(), '.claude', 'youcoded-favorites.json');
        try {
          const data = await fs.promises.readFile(favPath, 'utf8');
          this.respond(client.ws, type, id, JSON.parse(data));
        } catch {
          this.respond(client.ws, type, id, { favorites: [] });
        }
        break;
      }
      case 'favorites:set': {
        const favPath = path.join(os.homedir(), '.claude', 'youcoded-favorites.json');
        let existing: Record<string, any> = {};
        try { existing = JSON.parse(await fs.promises.readFile(favPath, 'utf8')); } catch {}
        existing.favorites = payload.favorites ?? payload;
        await fs.promises.writeFile(favPath, JSON.stringify(existing, null, 2));
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'game:getIncognito': {
        const gPath = path.join(os.homedir(), '.claude', 'youcoded-favorites.json');
        try {
          const data = JSON.parse(await fs.promises.readFile(gPath, 'utf8'));
          this.respond(client.ws, type, id, data.incognito ?? false);
        } catch {
          this.respond(client.ws, type, id, false);
        }
        break;
      }
      case 'game:setIncognito': {
        const gPath = path.join(os.homedir(), '.claude', 'youcoded-favorites.json');
        let existing: Record<string, any> = {};
        try { existing = JSON.parse(await fs.promises.readFile(gPath, 'utf8')); } catch {}
        existing.incognito = payload;
        await fs.promises.writeFile(gPath, JSON.stringify(existing, null, 2));
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'transcript:read-meta': {
        const transcriptPath = payload.path || payload;
        const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
        const resolvedPath = path.resolve(transcriptPath);
        if (!resolvedPath.startsWith(claudeProjects)) {
          this.respond(client.ws, type, id, null);
          break;
        }
        try {
          const meta = await readTranscriptMeta(transcriptPath);
          this.respond(client.ws, type, id, meta);
        } catch {
          this.respond(client.ws, type, id, null);
        }
        break;
      }
      case 'model:read-last': {
        // Mirror of ipc-handlers.ts model:read-last — reads the last assistant
        // message's model field from a JSONL transcript. Accepts either a raw
        // string or { transcriptPath } so the same shim wrapping works on
        // Android (wraps in object) and remote browsers (passes string).
        const transcriptPath = (payload && typeof payload === 'object' && 'transcriptPath' in payload)
          ? payload.transcriptPath
          : payload;
        if (typeof transcriptPath !== 'string') {
          this.respond(client.ws, type, id, null);
          break;
        }
        try {
          const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
          const resolved = path.resolve(transcriptPath);
          if (!resolved.startsWith(claudeProjects + path.sep)) {
            this.respond(client.ws, type, id, null);
            break;
          }
          const content = await fs.promises.readFile(transcriptPath, 'utf-8');
          const lines = content.trim().split('\n');
          let model: string | null = null;
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const entry = JSON.parse(lines[i]);
              if (entry.type === 'assistant' && entry.message?.model) {
                model = entry.message.model;
                break;
              }
            } catch { /* skip malformed line */ }
          }
          this.respond(client.ws, type, id, model);
        } catch {
          this.respond(client.ws, type, id, null);
        }
        break;
      }
      case 'remote:get-config': {
        const config = {
          ...this.config.toSafeObject(),
          clientCount: this.getClientCount(),
        };
        this.respond(client.ws, type, id, config);
        break;
      }
      case 'remote:set-password': {
        // Security: only allow password changes from local connections (not remote clients)
        const isLocal = client.ip === '127.0.0.1' || client.ip === '::1' || client.ip === '::ffff:127.0.0.1';
        if (!isLocal) {
          this.respond(client.ws, type, id, { error: 'Password change only allowed from local connection' });
          break;
        }
        await this.config.setPassword(payload);
        this.invalidateTokens();
        this.respond(client.ws, type, id, true);
        break;
      }
      case 'remote:set-config': {
        if (typeof payload.enabled === 'boolean') this.config.enabled = payload.enabled;
        if (typeof payload.trustTailscale === 'boolean') this.config.trustTailscale = payload.trustTailscale;
        if (typeof payload.keepAwakeHours === 'number') this.config.keepAwakeHours = payload.keepAwakeHours;
        this.config.save();
        this.respond(client.ws, type, id, this.config.toSafeObject());
        break;
      }
      case 'remote:detect-tailscale': {
        const { RemoteConfig } = require('./remote-config');
        const result = await RemoteConfig.detectTailscale(this.config.port);
        this.respond(client.ws, type, id, result);
        break;
      }
      case 'remote:get-client-count': {
        this.respond(client.ws, type, id, this.getClientCount());
        break;
      }
      case 'remote:get-client-list': {
        this.respond(client.ws, type, id, this.getClientList());
        break;
      }
      case 'remote:disconnect-client': {
        const result = this.disconnectClient(payload.clientId || payload);
        this.respond(client.ws, type, id, result);
        break;
      }

      // --- Sync management ---
      case 'sync:get-status': {
        const syncStatus = await getSyncStatus();
        this.respond(client.ws, type, id, syncStatus);
        break;
      }
      case 'sync:get-config': {
        const syncConfig = await getSyncConfig();
        this.respond(client.ws, type, id, syncConfig);
        break;
      }
      case 'sync:set-config': {
        const updatedConfig = await setSyncConfig(payload.updates || payload);
        this.respond(client.ws, type, id, updatedConfig);
        break;
      }
      case 'sync:force': {
        const syncResult = await forceSync();
        this.respond(client.ws, type, id, syncResult);
        break;
      }
      case 'sync:get-log': {
        const logLines = await getSyncLog(payload?.lines);
        this.respond(client.ws, type, id, logLines);
        break;
      }
      case 'sync:dismiss-warning': {
        // The remote-shim always sends { warning }, so payload.warning is
        // the authoritative path. Guard against missing payload rather than
        // falling back to the whole object (which would be a silent no-op).
        await dismissWarning(payload?.warning ?? '');
        this.respond(client.ws, type, id, { ok: true });
        break;
      }

      // Cross-device sync spaces (spec 2026-07-03). Remote-shim sends payloads
      // wrapped as { enabled } / { name }; unwrap the same way the sync:* cases
      // above do. The syncspaces:event push reaches remote clients via the
      // broadcast in service.ts (see broadcastToRenderers wiring below).
      case 'syncspaces:status': {
        this.respond(client.ws, type, id, await syncSpacesStatus());
        break;
      }
      case 'syncspaces:enable': {
        this.respond(client.ws, type, id, await syncSpacesEnable(!!payload?.enabled));
        break;
      }
      case 'syncspaces:sync-now': {
        // Optional spaceId narrows to one space (Project View "Sync now"); omit for all.
        this.respond(client.ws, type, id, await syncSpacesSyncNow(
          payload?.spaceId ? String(payload.spaceId) : undefined));
        break;
      }
      case 'syncspaces:create-project': {
        this.respond(client.ws, type, id, await syncSpacesCreateProject(String(payload?.name ?? '')));
        break;
      }
      case 'syncspaces:import-project': {
        this.respond(client.ws, type, id, await syncSpacesImportProject(
          String(payload?.sourcePath ?? ''), String(payload?.name ?? ''),
          this.sessionManager.listSessions().filter(s => s.status !== 'destroyed').map(s => s.cwd)));
        break;
      }
      // Cross-device rename (display-name only) + stop-syncing (2026-07-12).
      case 'syncspaces:rename-project': {
        this.respond(client.ws, type, id, await syncSpacesRenameProject(
          String(payload?.name ?? ''), String(payload?.displayName ?? '')));
        break;
      }
      case 'syncspaces:stop-project': {
        this.respond(client.ws, type, id, await syncSpacesStopProject(String(payload?.name ?? '')));
        break;
      }
      // Conversation-lease takeover (Plan 2b Task 9/11). Thin passthroughs to the
      // lease client (query) and requester flow (takeover/force), matching the
      // desktop ipc handlers. When wiring is absent (sync disabled) they degrade
      // to a free/error answer so the remote resume gate proceeds (spec §3 never-block).
      case 'syncspaces:lease-query': {
        // query() is async — await before respond (unlike ipcMain.handle, respond
        // doesn't unwrap promises).
        this.respond(client.ws, type, id,
          (await this.leaseWiring?.client.query(String(payload?.claudeSessionId ?? ''))) ?? { held: false, source: 'none' });
        break;
      }
      case 'syncspaces:lease-takeover': {
        this.respond(client.ws, type, id,
          (await this.leaseWiring?.requester.takeover(String(payload?.claudeSessionId ?? ''))) ?? { outcome: 'error' });
        break;
      }
      case 'syncspaces:lease-force': {
        this.respond(client.ws, type, id,
          (await this.leaseWiring?.requester.force(String(payload?.claudeSessionId ?? ''))) ?? { ok: false });
        break;
      }
      // Device registry (Plan 2b spec §10a). readDevices/renameDevice are direct
      // service-level calls (like the syncspaces:* rows above); self:true marks
      // the current machine via the injected machineId.
      case 'syncspaces:list-devices': {
        const pr = getManagedRoots()?.personalRoot;
        // machineId — must match the Electron handler exactly (ipc-channels.test.ts
        // pins the channel pair; this is the semantic half it can't see).
        const selfId = this.leaseWiring?.machineId ?? '';
        this.respond(client.ws, type, id,
          pr ? readDevices(pr).map((d) => ({ ...d, self: !!selfId && d.id === selfId })) : []);
        break;
      }
      case 'syncspaces:rename-device': {
        const pr = getManagedRoots()?.personalRoot;
        if (!pr) { this.respond(client.ws, type, id, { ok: false }); break; }
        try { await renameDevice(pr, String(payload?.id ?? ''), String(payload?.name ?? '')); this.respond(client.ws, type, id, { ok: true }); }
        catch { this.respond(client.ws, type, id, { ok: false }); }
        break;
      }
      case 'syncspaces:remove-device': {
        const pr = getManagedRoots()?.personalRoot;
        if (!pr) { this.respond(client.ws, type, id, { ok: false }); break; }
        const target = String(payload?.id ?? '');
        if (!target) { this.respond(client.ws, type, id, { ok: false }); break; }
        // Same self-guard as the Electron handler — a remote client must not be
        // able to remove the host machine's own row (it re-registers anyway).
        if (target === (this.leaseWiring?.machineId ?? '')) {
          this.respond(client.ws, type, id, { ok: false, error: 'cannot remove this device' });
          break;
        }
        try { await removeDevice(pr, target); this.respond(client.ws, type, id, { ok: true }); }
        catch { this.respond(client.ws, type, id, { ok: false }); }
        break;
      }

      // Connect-GitHub modal (device-flow auth) — remote browser parity. The flow
      // is all main-process; the browser just renders the code/URL and waits for
      // the github:connect-done broadcast. The access token never crosses the WS.
      case 'github:status': {
        // Combined status (Phase 2) — same payload as the desktop handler:
        // authed = stored app token OR gh login (legacy shape + additive fields).
        this.respond(client.ws, type, id, await combinedGithubStatus());
        break;
      }
      case 'github:connect-start': {
        // Drives the shared orchestrator singleton; completion arrives as the
        // github:connect-done broadcast (fanned out to every client).
        const gc = getGithubConnect();
        this.respond(client.ws, type, id, gc ? await gc.start() : { error: 'unavailable' });
        break;
      }
      case 'github:connect-cancel': {
        getGithubConnect()?.cancel();
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'github:install-gh': {
        this.respond(client.ws, type, id, await installGh());
        break;
      }
      case 'github:disconnect': {
        this.respond(client.ws, type, id, await disconnectGithub());
        break;
      }

      // V2: Per-instance backend management (remote browser parity)
      case 'sync:add-backend': {
        const added = await addBackend(payload);
        this.respond(client.ws, type, id, added);
        break;
      }
      case 'sync:remove-backend': {
        await removeBackend(payload.id || payload);
        this.respond(client.ws, type, id, { ok: true });
        break;
      }
      case 'sync:update-backend': {
        const updated = await updateBackend(payload.id, payload.updates);
        this.respond(client.ws, type, id, updated);
        break;
      }
      case 'sync:push-backend': {
        const pushResult = await pushBackend(payload.id || payload);
        this.respond(client.ws, type, id, pushResult);
        break;
      }
      // sync:pull-backend ("Download now") removed in sync-legacy-demolition.
      case 'sync:open-folder': {
        // Remote clients can't open local folders — return the URL for them to open manually.
        // For Drive, resolve the actual sync folder ID via rclone so the client deep-links
        // to the synced folder, not just drive.google.com's homepage.
        const cfg = await getSyncConfig();
        const backend = cfg.backends.find((b: any) => b.id === (payload.id || payload));
        let url = '';
        if (backend?.type === 'drive') {
          const rcloneRemote = backend.config?.rcloneRemote || 'gdrive';
          const driveRoot = backend.config?.DRIVE_ROOT || 'Claude';
          try {
            const { execFile } = require('child_process');
            const stdout: string = await new Promise((resolve, reject) => {
              execFile(
                'rclone',
                ['lsjson', `${rcloneRemote}:${driveRoot}/Backup`, '--dirs-only'],
                { timeout: 15000 },
                (err: any, out: string) => (err ? reject(err) : resolve(String(out || ''))),
              );
            });
            const entries = JSON.parse(stdout) as Array<{ Name: string; ID?: string }>;
            const match = entries.find((e) => e.Name === 'personal' && e.ID);
            url = match?.ID
              ? `https://drive.google.com/drive/folders/${match.ID}`
              : 'https://drive.google.com';
          } catch {
            url = 'https://drive.google.com';
          }
        } else if (backend?.type === 'github') {
          url = backend.config?.PERSONAL_SYNC_REPO || '';
        }
        this.respond(client.ws, type, id, { url });
        break;
      }

      // Guided setup wizard (prerequisite detection, install, OAuth, repo creation)
      case 'sync:setup:check-prereqs': {
        const prereqs = await checkSyncPrereqs(payload.backend || payload);
        this.respond(client.ws, type, id, prereqs);
        break;
      }
      case 'sync:setup:install-rclone': {
        const installResult = await installRclone();
        this.respond(client.ws, type, id, installResult);
        break;
      }
      case 'sync:setup:check-gdrive': {
        const gdriveCheck = await checkGdriveRemote();
        this.respond(client.ws, type, id, gdriveCheck);
        break;
      }
      case 'sync:setup:auth-gdrive': {
        const gdriveAuth = await authGdrive();
        this.respond(client.ws, type, id, gdriveAuth);
        break;
      }
      case 'sync:setup:auth-github': {
        const ghAuth = await authGithub();
        this.respond(client.ws, type, id, ghAuth);
        break;
      }
      case 'sync:setup:create-repo': {
        const repoResult = await createGithubRepo(payload.repoName || payload);
        this.respond(client.ws, type, id, repoResult);
        break;
      }

      // --- UI state sync: broadcast actions to all OTHER clients ---
      case 'ui:action': {
        const data = JSON.stringify({ type: 'ui:action', payload });
        for (const c of this.clients) {
          if (c !== client && c.ws.readyState === WebSocket.OPEN) {
            c.ws.send(data);
          }
        }
        // Also forward to Electron window via IPC if this came from a remote client
        this.sessionManager.emit('ui-action', payload);
        break;
      }

      // --- Zoom controls (applies to the desktop Electron window) ---
      case 'zoom:in':
      case 'zoom:out':
      case 'zoom:reset':
      case 'zoom:get': {
        const win = BrowserWindow.getAllWindows()[0];
        if (!win || win.isDestroyed()) {
          this.respond(client.ws, type, id, 100);
          break;
        }
        const ZOOM_STEP = 0.5;
        const ZOOM_MIN = -3;
        const ZOOM_MAX = 5;
        const toPercent = (l: number) => Math.round(Math.pow(1.2, l) * 100);
        const wc = win.webContents;
        if (type === 'zoom:in') {
          wc.setZoomLevel(Math.min(wc.getZoomLevel() + ZOOM_STEP, ZOOM_MAX));
        } else if (type === 'zoom:out') {
          wc.setZoomLevel(Math.max(wc.getZoomLevel() - ZOOM_STEP, ZOOM_MIN));
        } else if (type === 'zoom:reset') {
          wc.setZoomLevel(0);
        }
        this.respond(client.ws, type, id, toPercent(wc.getZoomLevel()));
        break;
      }

      // --- Fire-and-forget ---
      case 'session:input': {
        this.sessionManager.sendInput(payload.sessionId, payload.text);
        break;
      }
      // Native runtime interrupt — fire-and-forget (no response). The host no-ops unknown ids.
      case 'native:interrupt': {
        this.nativeRuntime?.nativeHost.interrupt(payload.sessionId);
        break;
      }
      case 'session:resize': {
        this.sessionManager.resizeSession(payload.sessionId, payload.cols, payload.rows);
        break;
      }
      case 'session:terminal-ready': {
        // Remote clients don't need the buffering gate that ipc-handlers uses,
        // because we replay the PTY buffer on connect instead.
        break;
      }

      // --- Project View ---
      case 'artifacts:list-projects-index': {
        // Shared with the Electron IPC handler (artifacts/projects-index.ts) so
        // both transports return the same thing. Without this case the request
        // fell through to nothing and remote Project View was permanently empty.
        try {
          this.respond(client.ws, type, id, await listProjectsIndex(payload));
        } catch (err: any) {
          this.respond(client.ws, type, id, { ok: false, error: String(err?.message ?? err) });
        }
        break;
      }

      // --- Account (drives the game lobby's signed-in state) ---
      case 'account:signed-in': {
        // No store injected → report signed-out rather than hanging. Mirrors
        // marketplace-api-handlers' `!!store.getToken()`.
        this.respond(client.ws, type, id, !!this.accountStore?.getToken());
        break;
      }
      case 'account:user': {
        // Cached profile only. The Electron handler additionally heals an empty
        // cache by calling /auth/me; that path needs the API client, which lives
        // in marketplace-api-handlers. Returning the cache (or null) keeps this
        // read-only and is enough for the lobby to see a signed-in user.
        this.respond(client.ws, type, id, this.accountStore?.getUser() ?? null);
        break;
      }

      default: {
        // WHY this exists: the switch had no default, so any channel the remote
        // server doesn't implement was silently dropped. The shim registers a
        // pending promise with a 30s timer (remote-shim.ts invoke()), so an
        // unimplemented channel presented as a 30-SECOND HANG followed by a
        // rejection with no indication of which side failed — which is how
        // Project View and the game lobby looked merely "broken" rather than
        // unimplemented. Respond immediately and name the channel instead.
        //
        // Fire-and-forget message types legitimately have no id; only answer
        // when the client is actually awaiting something.
        if (id) {
          // Warn ONCE per channel. useAttentionClassifier polls the unbridged
          // `terminal:get-screen-text` every second, so an unconditional warn
          // wrote a line per second for the life of the connection — drowning
          // the log and, because stdout writes can throw, multiplying the odds
          // of hitting the EPIPE crash guarded in main.ts.
          //
          // Deduped by channel (not by client) deliberately: the point is to
          // tell a developer which channels are missing, and that set does not
          // change when another phone connects. Mirrors the shim's
          // feature-level dedup in remote-unsupported.ts.
          if (!this.warnedChannels.has(type)) {
            this.warnedChannels.add(type);
            console.warn(`[RemoteServer] unhandled channel: ${type}`);
          }
          this.respond(client.ws, type, id, {
            ok: false,
            error: `This feature isn't available over remote access yet (${type}).`,
            unsupported: true,
          });
        }
        break;
      }
    }
  }

  // --- Helpers ---

  private respond(ws: WebSocket, type: string, id: string, payload: any): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: `${type}:response`, id, payload }));
    }
  }

  broadcast(msg: { type: string; payload: any }): void {
    const data = JSON.stringify(msg);
    for (const client of this.clients) {
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(data);
      }
    }
  }

  // --- Rate limiting ---

  private isRateLimited(ip: string): boolean {
    const entry = this.failedAttempts.get(ip);
    if (!entry) return false;
    if (Date.now() > entry.resetAt) {
      this.failedAttempts.delete(ip);
      return false;
    }
    return entry.count >= RATE_LIMIT_MAX_FAILURES;
  }

  private recordFailedAttempt(ip: string): void {
    const entry = this.failedAttempts.get(ip);
    if (entry && Date.now() < entry.resetAt) {
      entry.count++;
    } else {
      this.failedAttempts.set(ip, { count: 1, resetAt: Date.now() + RATE_LIMIT_WINDOW_MS });
    }
  }

  private clearFailedAttempts(ip: string): void {
    this.failedAttempts.delete(ip);
  }
}

