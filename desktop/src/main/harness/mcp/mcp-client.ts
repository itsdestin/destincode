// Single-server MCP client (spec: native MCP phase 1, Task 3). Owns exactly
// ONE server's connection lifecycle: connect, list tools, call one, close.
// Task 4 (connection manager) pools these across sessions and owns
// refcounting/reconnect policy — none of that lives here. Task 5 turns the
// tools this file lists into app tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ResolvedMcpServer } from './types';

export type McpToolDef = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

type ToolCallResult = { text: string; isError: boolean };

// Structural subset of the SDK's Client this file actually calls. Tests
// inject a fake satisfying this shape (via `deps.clientFactory`) so the
// suite never spawns a real subprocess or opens a real HTTP connection —
// same seam convention as NativeHomeLike/SecretsLike in mcp-registry.ts.
export interface McpClientLike {
  connect(transport: Transport): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string; description?: string; inputSchema: Record<string, unknown> }> }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<{ content: unknown[]; isError?: boolean }>;
  close(): Promise<void>;
}

export type ClientFactory = () => McpClientLike;

const DEFAULT_CALL_TIMEOUT_MS = 120_000;
// "last ~4KB" per the brief — enough to carry a real failure message without
// letting a chatty child unboundedly grow lastError.
const STDERR_BUFFER_LIMIT_BYTES = 4096;

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
  state: 'idle' | 'ready' | 'error' | 'needs-setup' = 'idle';
  lastError: string | null = null;

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
      this.state = 'ready';
      this.lastError = null;
    } catch (err) {
      if (isUnauthorizedError(err)) {
        // Expected "needs setup" state (v1 has no OAuth flow), not a bug —
        // see the streamableHttp construction comment below.
        this.state = 'needs-setup';
        this.lastError = errorMessage(err);
        return;
      }
      this.state = 'error';
      this.lastError = this.describeConnectFailure(err);
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

    const callPromise = client
      .callTool({ name, arguments: args as Record<string, unknown> | undefined })
      .then((result): ToolCallResult => ({ text: flatten(result.content ?? []), isError: !!result.isError }))
      .catch((err): ToolCallResult => ({ text: errorMessage(err), isError: true }));

    // A hung MCP server must NOT look like a stalled model. Native sessions
    // already have a stall watchdog, and an unbounded tool call would
    // surface as "the model stopped responding" — a wrong cause, which
    // docs/error-message-standards.md forbids. Name the server and the
    // bound instead, so the message is actionable.
    const timeoutPromise = new Promise<ToolCallResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({ text: `${label} did not respond within ${this.callTimeoutMs}ms.`, isError: true });
      }, this.callTimeoutMs);
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
    this.state = 'idle';
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
        this.stderrBuffer = (this.stderrBuffer + chunk.toString('utf8')).slice(-STDERR_BUFFER_LIMIT_BYTES);
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
