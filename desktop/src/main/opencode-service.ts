import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as net from 'net';

// Verified API Surface: @opencode-ai/sdk@1.14.35 exports createOpencodeClient
// (factory) and OpencodeClient (class). We use the factory.
//
// IMPORTANT: the SDK is ESM-only ("type": "module" with no "require" condition
// in its exports map). Our project compiles to CommonJS, so a static
// `import { createOpencodeClient } from '@opencode-ai/sdk'` becomes a
// `require()` at runtime which Node refuses with ERR_PACKAGE_PATH_NOT_EXPORTED.
// Use dynamic import inside the async start() method instead — that compiles
// to a real `await import()` (ESM-friendly) under module: commonjs.

export interface OpenCodeServiceOpts {
  /** Absolute path to the opencode binary, located by ipc-handlers from prerequisite-installer's recorded path. */
  binaryPath: string;
  /** Override for testing — env vars passed through to the child. */
  env?: NodeJS.ProcessEnv;
  /** Override for testing — inject a mock fetch for the readiness probe. */
  fetchImpl?: typeof fetch;
  /** How long to wait for the port to become reachable. Default 15_000 ms. */
  readyDeadlineMs?: number;
  /** Poll interval for the readiness probe. Default 200 ms. */
  readyPollMs?: number;
  /**
   * Override for testing — return the SDK module. Production uses the
   * Function-constructor trick to escape TS's `await import()` -> `require()`
   * transpilation; tests inject a mock so vitest's `vi.mock` can intercept.
   */
  sdkLoader?: () => Promise<any>;
}

/**
 * Manages a single shared `opencode serve` daemon that all local-mode sessions
 * use. Owns subprocess lifecycle, port allocation, ready-detection, crash
 * detection, graceful shutdown.
 */
export class OpenCodeService extends EventEmitter {
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private host: string = '127.0.0.1';
  private client: any = null;       // typed as the actual SDK return type during impl
  private intentionalShutdown = false;

  constructor(private readonly opts: OpenCodeServiceOpts) {
    super();
  }

  isRunning(): boolean { return !!this.child && this.port !== null; }
  baseUrl(): string {
    if (this.port === null) throw new Error('OpenCodeService not started');
    return `http://${this.host}:${this.port}`;
  }
  sdk(): any {
    if (!this.client) throw new Error('OpenCodeService SDK not initialized');
    return this.client;
  }

  async start(): Promise<void> {
    if (this.isRunning()) return;
    this.intentionalShutdown = false;
    const port = await this.allocatePort();
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const readyDeadlineMs = this.opts.readyDeadlineMs ?? 15_000;
    const readyPollMs = this.opts.readyPollMs ?? 200;

    const child = spawn(
      this.opts.binaryPath,
      ['serve', '--port', String(port)],
      {
        env: { ...process.env, ...(this.opts.env ?? {}) },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    this.child = child;
    this.host = '127.0.0.1';

    // Track child exit BEFORE port becomes reachable (start failed) vs AFTER
    // (crash). Used by the polling loop and the long-lived crash handler.
    let exitedDuringStartup = false;
    const startupExitListener = (code: number | null) => {
      exitedDuringStartup = true;
    };
    child.once('exit', startupExitListener);

    // Poll /global/health until reachable or deadline. Per Verified API Surface,
    // GET /global/health returns { healthy: true, version: string } and is the
    // documented liveness probe.
    const baseUrl = `http://${this.host}:${port}`;
    // Lazy-load the SDK. The SDK is ESM-only ("type": "module" with no
    // "require" condition in its exports map). Under module: commonjs, even
    // `await import()` gets transpiled by TypeScript into a require() wrapper
    // (Promise.resolve(require())), which hits the same ERR_PACKAGE_PATH_NOT_EXPORTED.
    // The Function-constructor trick escapes TypeScript's transformation and
    // emits a literal native dynamic import() that Node's ESM resolver handles
    // correctly. Standard workaround for ESM packages in CJS TypeScript projects.
    // Tests override via opts.sdkLoader so vitest's vi.mock can intercept.
    const sdkModule = await (this.opts.sdkLoader
      ? this.opts.sdkLoader()
      : (new Function('specifier', 'return import(specifier)') as (s: string) => Promise<any>)('@opencode-ai/sdk'));
    const createOpencodeClient = sdkModule.createOpencodeClient ?? sdkModule.default?.createOpencodeClient;
    if (typeof createOpencodeClient !== 'function') {
      child.kill();
      this.child = null;
      throw new Error('@opencode-ai/sdk: createOpencodeClient is not exported as expected');
    }

    const deadline = Date.now() + readyDeadlineMs;
    while (Date.now() < deadline && !exitedDuringStartup) {
      try {
        const res = await fetchImpl(`${baseUrl}/global/health`, { method: 'GET' });
        if (res.ok) {
          this.port = port;
          // Stainless Config field is `baseUrl` (lowercase 'u'). NOT `baseURL`.
          // Passing `baseURL` would be silently ignored and the SDK falls back
          // to its bundled default (54321/etc.), so all calls go to a port
          // where nothing's listening and hang indefinitely.
          this.client = createOpencodeClient({ baseUrl: baseUrl });
          // Swap startup exit listener for the long-lived crash handler.
          child.off('exit', startupExitListener);
          child.on('exit', (code) => {
            const wasRunning = this.isRunning();
            this.child = null;
            this.port = null;
            this.client = null;
            if (this.intentionalShutdown) return;
            if (wasRunning) this.emit('crashed', { exitCode: code });
          });
          return;
        }
      } catch { /* not yet reachable, keep polling */ }
      await new Promise((r) => setTimeout(r, readyPollMs));
    }

    // Either the deadline elapsed or the child exited before becoming reachable.
    child.kill();
    this.child = null;
    if (exitedDuringStartup) {
      throw new Error('opencode serve exited before becoming reachable');
    }
    throw new Error(`opencode serve did not become reachable within ${readyDeadlineMs}ms`);
  }

  async stop(): Promise<void> {
    if (!this.child) return;
    this.intentionalShutdown = true;
    this.child.kill();
    // Best-effort wait for exit — non-fatal if it doesn't.
    await new Promise<void>((resolve) => {
      if (!this.child) return resolve();
      this.child.once('exit', () => resolve());
      setTimeout(() => resolve(), 2_000);
    });
    this.child = null;
    this.port = null;
    this.client = null;
  }

  // Session-level convenience wrappers.
  // The SDK is Stainless-generated: every method takes a single options object
  // with shape { body?, path?, query? }, NOT positional arguments. Each SDK
  // call returns { data, error } (request/response envelope), not bare data.
  // Throw on `error`; return `data`.
  async createSession(_opts?: { systemPrompt?: string }): Promise<{ id: string }> {
    // Note: SessionCreateData.body is { parentID?, title? } only — no systemPrompt.
    // System prompts go on the prompt body's `system` field instead (see sendMessage).
    const res = await this.client.session.create({ body: {} });
    if (res.error) throw new Error(`OpenCode session.create failed: ${JSON.stringify(res.error)}`);
    return res.data;
  }
  /** Streaming send — events arrive via SSE. Use this for chat (we render incrementally).
   *  `system` overrides the agent's built-in system prompt for this turn. */
  async sendMessage(
    sessionId: string,
    text: string,
    model?: { providerID: string; modelID: string },
    system?: string,
  ): Promise<void> {
    const res = await this.client.session.promptAsync({
      path: { id: sessionId },
      body: {
        parts: [{ type: 'text', text }],
        ...(model ? { model } : {}),
        ...(system ? { system } : {}),
      },
    });
    if (res.error) throw new Error(`OpenCode session.promptAsync failed: ${JSON.stringify(res.error)}`);
  }
  async cancelSession(sessionId: string): Promise<void> {
    const res = await this.client.session.abort({ path: { id: sessionId } });
    if (res.error) throw new Error(`OpenCode session.abort failed: ${JSON.stringify(res.error)}`);
  }
  async destroySession(sessionId: string): Promise<void> {
    const res = await this.client.session.delete({ path: { id: sessionId } });
    if (res.error) throw new Error(`OpenCode session.delete failed: ${JSON.stringify(res.error)}`);
  }
  async listSessions(): Promise<Array<{ id: string; title: string; time?: { updated: number } }>> {
    const res = await this.client.session.list();
    if (res.error) throw new Error(`OpenCode session.list failed: ${JSON.stringify(res.error)}`);
    return res.data ?? [];
  }
  /** Fetch message history for a session (used for resume hydration). */
  async listMessages(sessionId: string): Promise<Array<{ info: any; parts: any[] }>> {
    const res = await this.client.session.messages({ path: { id: sessionId } });
    if (res.error) throw new Error(`OpenCode session.messages failed: ${JSON.stringify(res.error)}`);
    return res.data ?? [];
  }

  private async allocatePort(): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(0, '127.0.0.1', () => {
        const addr = srv.address();
        if (typeof addr === 'object' && addr) {
          const port = addr.port;
          srv.close(() => resolve(port));
        } else {
          srv.close(() => reject(new Error('failed to allocate port')));
        }
      });
      srv.on('error', reject);
    });
  }
}
