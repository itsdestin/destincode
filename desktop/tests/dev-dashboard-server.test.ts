import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import http from 'node:http';
import { guardRequest, createServer, json } from '../dev-dashboard/server.mjs';

const req = (headers: Record<string, string>) => ({ headers });

describe('guardRequest', () => {
  it('allows a loopback host with no origin', () => {
    expect(guardRequest(req({ host: '127.0.0.1:5240' }))).toBeNull();
  });

  it('allows an origin that matches its own host', () => {
    expect(guardRequest(req({ host: '127.0.0.1:5240', origin: 'http://127.0.0.1:5240' }))).toBeNull();
  });

  it('refuses a non-loopback host', () => {
    // A DNS name resolving to 127.0.0.1 would otherwise let any site on the
    // internet drive a server that runs commands on this machine.
    expect(guardRequest(req({ host: 'evil.example.com' }))).toMatch(/host/i);
  });

  it('refuses a cross-origin request', () => {
    expect(guardRequest(req({ host: '127.0.0.1:5240', origin: 'http://evil.example.com' })))
      .toMatch(/origin/i);
  });

  it('refuses a missing host', () => {
    expect(guardRequest(req({}))).toMatch(/host/i);
  });
});

describe('the server over a real socket', () => {
  it('serves checkouts and 404s an unknown api route', async () => {
    const server = createServer({ repoDir: process.cwd(), workspaceRoot: process.cwd(), vitePort: 1 });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/api/checkouts`);
      expect(ok.status).toBe(200);
      expect(Array.isArray((await ok.json()).checkouts)).toBe(true);

      const missing = await fetch(`http://127.0.0.1:${port}/api/nope`);
      expect(missing.status).toBe(404);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('reports the real reason when the dev server behind it is not running', async () => {
    // A non-api path proxies to Vite. With nothing on that port the page must say
    // so — never a hardcoded guess at the cause (docs/error-message-standards.md).
    const server = createServer({ repoDir: process.cwd(), workspaceRoot: process.cwd(), vitePort: 1 });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      expect(res.status).toBe(502);
      expect((await res.json()).error).toMatch(/port 1 did not answer/);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('theme assets cannot escape the theme directory', () => {
  it('refuses an encoded traversal, and never serves a file outside it', async () => {
    // Two shapes, both real: percent-encoded ".." reaches the handler intact and
    // must be refused there; a literal ".." is normalised away by `new URL()`
    // BEFORE routing, so it falls through to the Vite proxy instead. Neither may
    // ever return a file from outside the theme folder.
    const server = createServer({ repoDir: process.cwd(), workspaceRoot: process.cwd(), vitePort: 1 });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const encoded = await fetch(
        `http://127.0.0.1:${port}/theme-asset/x/..%2f..%2f..%2fetc%2fpasswd`,
      );
      expect(encoded.status).toBe(404);
      expect(await encoded.text()).not.toMatch(/root:x:/);

      const slug = await fetch(`http://127.0.0.1:${port}/theme-asset/..%2f..%2f.ssh/id_rsa`);
      expect(slug.status).toBe(404);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('json() after the response has started', () => {
  it('does not throw, so an error listener cannot kill the helper', () => {
    // The real first-boot failure: a proxied response had already sent headers
    // when the upstream errored, and the 502 handler called writeHead a SECOND
    // time. Inside an 'error' listener that throw is uncaught — the helper died,
    // the page went blank, and run.sh's trap killed Vite with it.
    const fake = {
      headersSent: true,
      writableEnded: false,
      destroyed: false,
      destroy() { this.destroyed = true; },
      writeHead() { throw new Error('ERR_HTTP_HEADERS_SENT: writeHead called twice'); },
      end() { throw new Error('end called after headers'); },
    };
    expect(() => json(fake, 502, { error: 'upstream died' })).not.toThrow();
    expect(fake.destroyed).toBe(true);
  });

  it('still writes normally when the response has not started', () => {
    const written: Array<[number, unknown]> = [];
    const fake = {
      headersSent: false,
      writableEnded: false,
      destroy() { throw new Error('should not destroy a fresh response'); },
      writeHead(code: number, headers: unknown) { written.push([code, headers]); },
      end(_body: string) { /* body captured by the assertion below */ },
    };
    json(fake, 404, { error: 'nope' });
    expect(written[0][0]).toBe(404);
  });
});
