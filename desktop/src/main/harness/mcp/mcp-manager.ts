// MCP connection manager (spec: native MCP phase 1, Task 4). Sits between the
// registry (Task 2, WHICH servers exist) and the single-server client (Task 3,
// HOW to talk to one) — its whole job is POOLING: one live connection per
// server, shared and refcounted across every session that wants it. Two chat
// sessions both using the Gmail server must share one subprocess, not spawn
// two. Task 5 turns the tools acquire() hands back into app tools; Task 6
// attaches them to a session.
import type { ResolvedMcpServer } from './types';
import type { McpToolDef } from './mcp-client';

// Structural subsets of McpRegistry/createConnection's real shapes — same
// seam convention as NativeHomeLike/SecretsLike/ClientFactory elsewhere in
// this folder. Tests inject fakes; the real registry/mcp-client module both
// satisfy these without this file importing their concrete classes.
export interface McpRegistryLike {
  resolveAllEnabled(): Promise<ResolvedMcpServer[]>;
}

// The exact McpConnection surface this file pools: state/lastError for
// status(), connect()/close() for lifecycle, listTools()/callTool() for the
// ReadyServer this file hands back. connect() is documented (mcp-client.ts)
// to NEVER throw — every failure lands in state/lastError instead — which is
// what lets one broken server be recorded without ever rejecting acquire().
export interface McpConnectionLike {
  readonly state: 'idle' | 'ready' | 'error' | 'needs-setup';
  readonly lastError: string | null;
  connect(): Promise<void>;
  listTools(): McpToolDef[];
  callTool(name: string, args: unknown, signal: AbortSignal): Promise<{ text: string; isError: boolean }>;
  close(): Promise<void>;
}

export type McpConnectionFactory = (server: ResolvedMcpServer) => McpConnectionLike;

export type ReadyServer = {
  id: string;
  label: string;
  tools: McpToolDef[];
  call(tool: string, args: unknown, signal: AbortSignal): Promise<{ text: string; isError: boolean }>;
};

// One pooled server: its connection (may still be idle/connecting/errored)
// plus WHO currently holds it. holders empties → close(); holders refills
// (a later acquire) → the entry is already gone from the map, so a fresh
// connect() happens, same as first touch. This mirrors the refcounting the
// brief specifies rather than a simple boolean, so two overlapping sessions
// never race each other into a double-connect (see connecting below) or a
// premature close.
interface PooledEntry {
  server: ResolvedMcpServer;
  conn: McpConnectionLike;
  holders: Set<string>;
  // In-flight connect() promise, set the FIRST time any session touches this
  // server and cleared once it settles. A second concurrent acquire() for
  // the same not-yet-connected server awaits THIS instead of calling
  // connect() again — the seam that makes "one broken/slow server, two
  // simultaneous acquire()s" connect once, not twice. See McpManager.acquire.
  connecting?: Promise<void>;
}

export class McpManager {
  private readonly registry: McpRegistryLike;
  private readonly connectionFactory: McpConnectionFactory;
  // serverId -> pooled entry. Absence means "never touched yet" — NOT the
  // same as a connected-but-errored server, which stays present (see acquire).
  private pool = new Map<string, PooledEntry>();

  constructor(deps: { registry: McpRegistryLike; connectionFactory: McpConnectionFactory }) {
    this.registry = deps.registry;
    this.connectionFactory = deps.connectionFactory;
  }

  /**
   * Register `sessionId` as a holder of every enabled server, connecting any
   * server this is the FIRST holder for, and return only the ones that came
   * up `ready`. A server that fails to connect (or needs setup) is still
   * pooled — so status() can report its real error and a later acquire()
   * doesn't reconnect it every time — but it is EXCLUDED from the returned
   * list: one broken server must never deny a session its working ones.
   */
  async acquire(sessionId: string): Promise<ReadyServer[]> {
    const servers = await this.registry.resolveAllEnabled();
    const ready: ReadyServer[] = [];
    for (const server of servers) {
      const entry = await this.ensureConnected(server);
      entry.holders.add(sessionId);
      if (entry.conn.state === 'ready') {
        ready.push({
          id: entry.server.id,
          label: entry.server.label,
          tools: entry.conn.listTools(),
          call: (tool, args, signal) => entry.conn.callTool(tool, args, signal),
        });
      }
    }
    return ready;
  }

  // Looks up (or creates) the pooled entry for `server`, connecting it if
  // this is the first-ever touch, and AWAITS an already-in-flight connect
  // rather than starting a second one. This is the concurrency-safety seam:
  // two acquire() calls racing on the same server both reach this method,
  // both see the SAME entry.connecting promise (the entry + its promise are
  // installed synchronously, before either await below), so only one
  // connect() ever runs no matter how many sessions ask at once.
  private async ensureConnected(server: ResolvedMcpServer): Promise<PooledEntry> {
    let entry = this.pool.get(server.id);
    if (!entry) {
      const conn = this.connectionFactory(server);
      entry = { server, conn, holders: new Set() };
      this.pool.set(server.id, entry);
      entry.connecting = conn.connect().finally(() => {
        entry!.connecting = undefined;
      });
    }
    if (entry.connecting) await entry.connecting;
    return entry;
  }

  /**
   * Drop `sessionId`'s hold on every server it holds. A server whose holder
   * set empties as a result is closed and removed from the pool (a later
   * acquire() reconnects it fresh). Releasing a session that never acquired
   * anything — or a server it never held — is a no-op, never a throw: the
   * caller (session teardown) shouldn't have to first check whether MCP was
   * ever in play for that session.
   */
  async release(sessionId: string): Promise<void> {
    for (const [id, entry] of [...this.pool.entries()]) {
      if (!entry.holders.has(sessionId)) continue;
      entry.holders.delete(sessionId);
      if (entry.holders.size === 0) {
        this.pool.delete(id);
        await entry.conn.close();
      }
    }
  }

  /** App-quit teardown: close every pooled connection regardless of
   *  refcount. A leaked MCP subprocess would otherwise outlive the app. */
  async destroyAll(): Promise<void> {
    const entries = [...this.pool.values()];
    this.pool.clear();
    for (const entry of entries) {
      await entry.conn.close();
    }
  }

  /** Every server this manager has ever touched, including ones that failed
   *  to connect — their REAL error (McpConnection.lastError, never reworded)
   *  so a session picker can show why a server is unavailable. */
  status(): Array<{ id: string; state: string; error: string | null }> {
    return [...this.pool.values()].map((entry) => ({
      id: entry.server.id,
      state: entry.conn.state,
      error: entry.conn.lastError,
    }));
  }
}
