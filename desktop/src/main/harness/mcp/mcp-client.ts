// Single-server MCP client (spec: native MCP phase 1, Task 3). Owns exactly
// ONE server's connection lifecycle: connect, list tools, call one, close.
// Task 4 (connection manager) pools these across sessions and owns
// refcounting/reconnect policy — none of that lives here. Task 5 turns the
// tools this file lists into app tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ResolvedMcpServer } from './types';

export type McpToolDef = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

type ToolCallResult = { text: string; isError: boolean };

// The SDK's own per-request options (RequestOptions in
// @modelcontextprotocol/sdk/dist/esm/shared/protocol.d.ts) — only the two
// fields this file threads through, not the whole shape (onprogress, task,
// etc. are unused here).
export interface McpCallToolOptions {
  signal?: AbortSignal;
  timeout?: number;
}

// Structural subset of the SDK's Client this file actually calls. Tests
// inject a fake satisfying this shape (via `deps.clientFactory`) so the
// suite never spawns a real subprocess or opens a real HTTP connection —
// same seam convention as NativeHomeLike/SecretsLike in mcp-registry.ts.
//
// The middle `resultSchema` param looks pointless (we always pass
// `undefined`) but its POSITION is load-bearing: the real
// Client#callTool's signature is (params, resultSchema, options) — see
// node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js. This file
// never validates structured output (that's Task 5's problem), so we let
// the SDK fall back to its default CallToolResultSchema by passing
// `undefined` in position 2. If a future edit "simplifies" this away to a
// 2-arg (params, options) signature, `options` would silently land in the
// SDK's `resultSchema` slot instead, and `signal`/`timeout` would vanish —
// exactly the bug this fix pass exists to close.
export interface McpClientLike {
  connect(transport: Transport): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }>;
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    resultSchema: undefined,
    options?: McpCallToolOptions
  ): Promise<{ content: unknown[]; isError?: boolean }>;
  close(): Promise<void>;
}

export type ClientFactory = () => McpClientLike;

const DEFAULT_CALL_TIMEOUT_MS = 120_000;
// The SDK's own request timeout (threaded into callTool() below) is the
// path that normally wins a hung call — it carries proper cleanup
// (notifications/cancelled, handler teardown). This is only a backstop for
// the case where the SDK never rejects at all (a future SDK regression, a
// transport that ignores `options.timeout`). Kept strictly ABOVE the real
// bound so it can never preempt the SDK's better-behaved rejection.
const BACKSTOP_GRACE_MS = 1_000;
// "last ~4KB" per the brief — enough to carry a real failure message without
// letting a chatty child unboundedly grow lastError. NOT a byte bound: the
// ring is trimmed with String#slice, which counts UTF-16 code units, so a
// stream containing multi-byte UTF-8 (emoji, non-Latin diagnostics) yields
// fewer than 4096 real bytes. Named for what it actually measures rather
// than the byte count the old name implied.
const STDERR_BUFFER_LIMIT_CHARS = 4096;

function defaultClientFactory(): McpClientLike {
  return new Client({ name: 'youcoded', version: '1.0.0' }) as unknown as McpClientLike;
}

// The real UnauthorizedError (thrown by StreamableHTTPClientTransport when a
// server requires OAuth and we have no authProvider) does NOT set `.name` —
// it inherits Error.prototype.name === 'Error', so `instanceof` is the
// reliable real-world check. `.name`/`.constructor.name` are checked too so
// a synthetic error built the way tests build one (`err.name =
// 'UnauthorizedError'`) is still recognized, without requiring every caller
// to construct a real SDK class instance just to signal this state.
function isUnauthorizedError(err: unknown): boolean {
  if (err instanceof UnauthorizedError) return true;
  const e = err as { name?: unknown; constructor?: { name?: unknown } } | null;
  return e?.name === 'UnauthorizedError' || e?.constructor?.name === 'UnauthorizedError';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The model's tool result is text (ToolResultPayload.text). Non-text parts
// are DESCRIBED rather than dropped so the model knows something came back
// it cannot see — image/audio parity is M4 item 6, deliberately not solved
// here.
function flatten(content: unknown[]): string {
  return content
    .map((part) => {
      const p = part as { type?: string; text?: unknown; mimeType?: unknown; resource?: { uri?: unknown } } | null;
      if (p?.type === 'text') return String(p.text);
      if (p?.type === 'image' || p?.type === 'audio') {
        return `[${p.mimeType} attachment omitted — this session cannot display it]`;
      }
      if (p?.type === 'resource') return `[resource ${p.resource?.uri ?? 'unknown'}]`;
      return `[unsupported content part: ${p?.type ?? 'unknown'}]`;
    })
    .join('\n');
}

export class McpConnection {
  // Backing fields for the readonly getters below — the brief specifies
  // `readonly state`/`readonly lastError` so no caller outside this class
  // can stomp on connection status; only this file's own methods may write
  // via the private fields.
  private _state: 'idle' | 'ready' | 'error' | 'needs-setup' = 'idle';
  private _lastError: string | null = null;

  get state(): 'idle' | 'ready' | 'error' | 'needs-setup' {
    return this._state;
  }

  get lastError(): string | null {
    return this._lastError;
  }

  private readonly clientFactory: ClientFactory;
  private readonly callTimeoutMs: number;
  private client: McpClientLike | null = null;
  private tools: McpToolDef[] = [];
  // Bounded ring of the piped stdio child's stderr — see buildTransport().
  private stderrBuffer = '';

  constructor(
    private readonly server: ResolvedMcpServer,
    deps?: { clientFactory?: ClientFactory; callTimeoutMs?: number }
  ) {
    this.clientFactory = deps?.clientFactory ?? defaultClientFactory;
    this.callTimeoutMs = deps?.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  }

  // Never throws — one broken server must not be able to take down the
  // session that's trying to use it. Every failure path records `state` +
  // `lastError` and returns instead.
  async connect(): Promise<void> {
    const client = this.clientFactory();
    this.client = client;
    try {
      const transport = this.buildTransport();
      await client.connect(transport);
      const { tools } = await client.listTools();
      this.tools = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
      this._state = 'ready';
      this._lastError = null;
    } catch (err) {
      if (isUnauthorizedError(err)) {
        // Expected "needs setup" state (v1 has no OAuth flow), not a bug —
        // see the streamableHttp construction comment below.
        this._state = 'needs-setup';
        this._lastError = errorMessage(err);
        return;
      }
      this._state = 'error';
      this._lastError = this.describeConnectFailure(err);
    }
  }

  listTools(): McpToolDef[] {
    return this.tools;
  }

  async callTool(name: string, args: unknown, signal: AbortSignal): Promise<ToolCallResult> {
    if (!this.client || this.state !== 'ready') {
      return { text: `${this.server.label} is not connected.`, isError: true };
    }
    const client = this.client;
    const label = this.server.label;

    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      if (onAbort) signal.removeEventListener('abort', onAbort);
    };

    // Thread `signal` and `timeout` into the SDK's own request options
    // (position 3 — see the McpClientLike comment above for why). Without
    // this, the SDK applies ITS OWN DEFAULT_REQUEST_TIMEOUT_MSEC (60_000ms,
    // hardcoded in protocol.js) whenever `options.timeout` is absent, so a
    // real hung server would have been killed by the SDK ~1 minute before
    // our own backstop timer below ever got a chance to run — with a
    // message naming neither the server nor our bound. Threading `signal`
    // also lets the SDK send `notifications/cancelled` and tear down its
    // internal `_responseHandlers`/`_progressHandlers` entries immediately
    // on abort, instead of leaking them until its own timeout self-cleans.
    const callPromise = client
      .callTool(
        { name, arguments: args as Record<string, unknown> | undefined },
        undefined,
        { signal, timeout: this.callTimeoutMs }
      )
      .then((result): ToolCallResult => ({ text: flatten(result.content ?? []), isError: !!result.isError }))
      .catch((err): ToolCallResult => {
        // The SDK's own timeout rejects with McpError(RequestTimeout,
        // 'Request timed out') — true, but names neither the server nor the
        // bound, which docs/error-message-standards.md requires. Detect it
        // by the SDK's own error CODE (never by matching message text,
        // which is an SDK implementation detail) and rewrite into the
        // actionable shape below. This is not a guessed cause: a
        // RequestTimeout code IS a timeout, with certainty, so relabeling it
        // is translation, not invention. Every other error (a real server
        // failure) falls through and surfaces its own text verbatim.
        if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
          return { text: `${label} did not respond within ${this.callTimeoutMs}ms.`, isError: true };
        }
        return { text: errorMessage(err), isError: true };
      });

    // Backstop only — normally the SDK's own timeout (threaded above) wins
    // this race, since it takes the proper cleanup path (cancel
    // notification + handler teardown) that this timer cannot. This exists
    // solely for the case where the SDK never rejects at all (a future SDK
    // regression, or a transport that ignores `options.timeout`), so its
    // delay is deliberately callTimeoutMs + BACKSTOP_GRACE_MS: strictly
    // longer than the SDK's own bound, so it can never preempt the SDK's
    // better-behaved rejection in the normal case.
    const timeoutPromise = new Promise<ToolCallResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({ text: `${label} did not respond within ${this.callTimeoutMs}ms.`, isError: true });
      }, this.callTimeoutMs + BACKSTOP_GRACE_MS);
    });

    // Abort resolves to an error result rather than throwing, matching how
    // defineTool labels an in-flight abort as a cancellation rather than a
    // bug.
    const abortPromise = new Promise<ToolCallResult>((resolve) => {
      const resolveCancelled = () => resolve({ text: `Call to "${name}" on ${label} was cancelled.`, isError: true });
      if (signal.aborted) {
        resolveCancelled();
        return;
      }
      onAbort = resolveCancelled;
      signal.addEventListener('abort', onAbort, { once: true });
    });

    try {
      return await Promise.race([callPromise, timeoutPromise, abortPromise]);
    } finally {
      cleanup();
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this._state = 'idle';
    if (!client) return;
    try {
      await client.close();
    } catch {
      // Best-effort teardown — a close failure on a connection we're
      // discarding anyway isn't actionable for the caller.
    }
  }

  private buildTransport(): Transport {
    if (this.server.transport.type === 'stdio') {
      const transport = new StdioClientTransport({
        command: this.server.transport.command,
        args: this.server.transport.args,
        env: this.server.env,
        cwd: this.server.transport.cwd,
        // stderr:'pipe' is LOAD-BEARING. The SDK defaults to 'inherit',
        // which routes a failing server's only explanation into the app's
        // own stderr where no error message can reach the user — exactly
        // the guessed-cause failure docs/error-message-standards.md
        // forbids. We buffer the piped stream ourselves (bounded, see
        // describeConnectFailure) so a failed connect can quote it.
        stderr: 'pipe',
      });
      const stderrStream = transport.stderr;
      stderrStream?.on('data', (chunk: Buffer) => {
        this.stderrBuffer = (this.stderrBuffer + chunk.toString('utf8')).slice(-STDERR_BUFFER_LIMIT_CHARS);
      });
      return transport;
    }
    // HTTP: header secrets ride requestInit. No authProvider in v1 — a
    // server that requires OAuth throws UnauthorizedError, which connect()
    // maps to 'needs-setup'.
    return new StreamableHTTPClientTransport(new URL(this.server.transport.url), {
      requestInit: { headers: this.server.headers },
    });
  }

  // For a stdio server, the child's stderr IS the real cause — append
  // whatever was captured so lastError doesn't stop at a generic
  // "connection closed"-shaped SDK message.
  private describeConnectFailure(err: unknown): string {
    const base = errorMessage(err);
    const stderr = this.stderrBuffer.trim();
    if (this.server.transport.type === 'stdio' && stderr.length > 0) {
      return `${base}\n${stderr}`;
    }
    return base;
  }
}

export function createConnection(
  server: ResolvedMcpServer,
  deps?: { clientFactory?: ClientFactory; callTimeoutMs?: number }
): McpConnection {
  return new McpConnection(server, deps);
}
