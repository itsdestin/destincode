// The dev dashboard's helper. It is the ONLY piece that runs commands; the page
// asks it and never touches a shell itself.
//
// Dev-only: electron-builder.yml's `files:` allowlist (dist/, node_modules/,
// scripts/, hook-scripts/, assets/, package.json) excludes this folder, the same
// way it already excludes test-engine/.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { listCheckouts } from './checkouts.mjs';
import { readAppearance, listThemes, readTheme, resolveAssetFile, MIME, assetExists } from './theme.mjs';
import * as instances from './instances.mjs';
import * as suites from './suites.mjs';
import { workspaceState, verdict } from './workspace.mjs';
import { checkoutDetail, backupWork } from './detail.mjs';

/** Returns a refusal reason, or null to allow.
 *  WHY both checks: a Host header naming a domain that resolves to 127.0.0.1 would
 *  otherwise let any page on the internet drive a server that runs commands here.
 *  The Origin check stops a cross-site request doing the same. This is the guard
 *  scripts/questions/serve.py already runs, for the same reason. */
export function guardRequest(req) {
  const host = req.headers.host;
  if (!host) return 'refused: no Host header';
  const hostname = host.replace(/:\d+$/, '');
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
    return `refused: Host ${hostname} is not loopback`;
  }
  const origin = req.headers.origin;
  if (origin && origin !== `http://${host}`) {
    return `refused: Origin ${origin} does not match this server`;
  }
  return null;
}

export function json(res, code, body) {
  // Never write headers twice. A proxied response that fails MID-STREAM has
  // already sent them, and writeHead throws ERR_HTTP_HEADERS_SENT — which, from
  // inside an 'error' listener, is an uncaught exception that kills the whole
  // helper. It did exactly that on first boot: the page went blank and Vite died
  // with it, because the run.sh trap tears the group down.
  if (res.headersSent || res.writableEnded) {
    res.destroy();
    return;
  }
  const text = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 64 * 1024) reject(new Error('request body too large'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
  });
}

export function createServer(opts) {
  const { repoDir, workspaceRoot, vitePort } = opts;

  /** Resolve a checkout by the id WE handed out. A path taken from a request would
   *  let a caller name any directory on the machine; an id can only ever select
   *  something git already told us about. */
  async function checkoutById(id) {
    return (await listCheckouts(repoDir)).find((c) => c.id === id);
  }

  const server = http.createServer(async (req, res) => {
    const refusal = guardRequest(req);
    if (refusal) { json(res, 403, { error: refusal }); return; }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const baseUrl = `http://${req.headers.host}`;

    try {
      if (url.pathname === '/api/workspace' && req.method === 'GET') {
        // `fetch=0` skips the network hop, for a fast first paint; the page then
        // asks again with the fetch so the number is true rather than remembered.
        const doFetch = url.searchParams.get('fetch') !== '0';
        const state = await workspaceState(workspaceRoot, { fetch: doFetch });
        json(res, 200, { ...state, verdict: verdict(state) });
        return;
      }

      if (url.pathname === '/api/checkouts' && req.method === 'GET') {
        json(res, 200, { checkouts: await listCheckouts(repoDir) });
        return;
      }

      // ---- theme ----------------------------------------------------------
      if (url.pathname === '/api/theme/appearance' && req.method === 'GET') {
        json(res, 200, { appearance: await readAppearance() });
        return;
      }
      if (url.pathname === '/api/theme/list' && req.method === 'GET') {
        json(res, 200, { slugs: await listThemes() });
        return;
      }
      if (url.pathname.startsWith('/api/theme/read/') && req.method === 'GET') {
        const slug = decodeURIComponent(url.pathname.slice('/api/theme/read/'.length));
        // readTheme returns manifest JSON as TEXT, because claude.theme.readFile's
        // contract is a string the renderer parses itself.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(await readTheme(slug, baseUrl));
        return;
      }
      if (url.pathname.startsWith('/theme-asset/')) {
        const rest = url.pathname.slice('/theme-asset/'.length);
        const slash = rest.indexOf('/');
        if (slash < 0) { json(res, 404, { error: 'no such theme asset' }); return; }
        const slug = decodeURIComponent(rest.slice(0, slash));
        const rel = decodeURIComponent(rest.slice(slash + 1));
        const file = resolveAssetFile(slug, rel);
        if (!file || !assetExists(file)) { json(res, 404, { error: 'no such theme asset' }); return; }
        res.writeHead(200, {
          'content-type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        });
        fs.createReadStream(file).pipe(res);
        return;
      }

      // ---- dev instances --------------------------------------------------
      if (url.pathname === '/api/dev/instances' && req.method === 'GET') {
        json(res, 200, { instances: instances.list() });
        return;
      }
      if (url.pathname === '/api/dev/start' && req.method === 'POST') {
        const { id } = await readBody(req);
        const checkout = await checkoutById(id);
        if (!checkout) { json(res, 404, { error: `no checkout with id ${id}` }); return; }
        json(res, 200, { instance: instances.start(checkout, { workspaceRoot }) });
        return;
      }
      if (url.pathname === '/api/dev/stop' && req.method === 'POST') {
        const { id } = await readBody(req);
        json(res, 200, { stopped: instances.stop(id) });
        return;
      }

      // ---- check suites ---------------------------------------------------
      // What is actually IN a checkout. On demand, not in the list: this runs a
      // diff and shells out to `gh`, far too slow to do 24 times on every load.
      if (url.pathname.startsWith('/api/checkout/') && url.pathname.endsWith('/detail') && req.method === 'GET') {
        const id = url.pathname.slice('/api/checkout/'.length, -'/detail'.length);
        const checkout = await checkoutById(id);
        if (!checkout) { json(res, 404, { error: `no checkout with id ${id}` }); return; }
        json(res, 200, { detail: await checkoutDetail(checkout) });
        return;
      }

      // The one action the page performs rather than prompts for. Purely additive:
      // it records the files on a new branch using a throwaway index, so the
      // working tree, the real index and HEAD are left exactly as found.
      if (url.pathname === '/api/checkout/backup' && req.method === 'POST') {
        const { id } = await readBody(req);
        const checkout = await checkoutById(id);
        if (!checkout) { json(res, 404, { error: `no checkout with id ${id}` }); return; }
        json(res, 200, { result: await backupWork(checkout) });
        return;
      }

      if (url.pathname === '/api/suites' && req.method === 'GET') {
        json(res, 200, {
          suites: suites.SUITES.map(({ key, label, weight, paid, does, covers }) => ({
            key, label, weight, paid, does, covers,
          })),
        });
        return;
      }
      if (url.pathname === '/api/checks/runs' && req.method === 'GET') {
        // `full=0` drops the captured output, which is what the polling list wants
        // — sending 512 KB of build log every two seconds is not a status poll.
        const full = url.searchParams.get('full') !== '0';
        const all = suites.listRuns();
        json(res, 200, {
          runsDir: suites.runsDir(),
          runs: full ? all : all.map(({ output, ...rest }) => ({ ...rest, outputBytes: output?.length ?? 0 })),
        });
        return;
      }

      if (url.pathname.startsWith('/api/checks/run/') && req.method === 'GET') {
        const runId = url.pathname.slice('/api/checks/run/'.length);
        const run = suites.getRun(runId);
        if (!run) { json(res, 404, { error: `no run with id ${runId}` }); return; }
        json(res, 200, { run });
        return;
      }
      if (url.pathname === '/api/checks/run' && req.method === 'POST') {
        const { id, suite, confirmSpend } = await readBody(req);
        const checkout = await checkoutById(id);
        if (!checkout) { json(res, 404, { error: `no checkout with id ${id}` }); return; }
        json(res, 200, {
          run: await suites.runSuite(suite, checkout, { workspaceRoot, confirmSpend }),
        });
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        json(res, 404, { error: `no route for ${url.pathname}` });
        return;
      }

      // ---- everything else is Vite ----------------------------------------
      // WHY proxy rather than tell Destin two ports: one address to open, and the
      // page then shares an origin with its data, which keeps the Origin guard
      // above simple and true.
      const proxied = http.request(
        {
          host: '127.0.0.1', port: vitePort, path: req.url,
          method: req.method, headers: req.headers,
        },
        (up) => {
          res.writeHead(up.statusCode ?? 502, up.headers);
          // A body that dies mid-stream cannot become a 502 — the headers are
          // already gone. Drop the connection instead; the browser retries.
          up.on('error', () => res.destroy());
          up.pipe(res);
        },
      );
      proxied.on('error', (e) => {
        // Name the real failure. "Vite is not running" is the common case and the
        // message says so rather than guessing at something more specific.
        // json() is now a no-op once headers are out, so this is safe either way.
        json(res, 502, {
          error: `dev server on port ${vitePort} did not answer: ${e.message}`,
        });
      });
      // The browser navigating away aborts the request. Without this the write
      // into a dead socket surfaces as an unhandled error.
      res.on('close', () => { if (!res.writableEnded) proxied.destroy(); });
      req.on('error', () => proxied.destroy());
      req.pipe(proxied);
    } catch (err) {
      // Surface the real error. Replacing it with a hardcoded guess is exactly the
      // misleading-error-message failure docs/error-message-standards.md forbids.
      json(res, 500, { error: String(err && err.message ? err.message : err) });
    }
  });

  // Vite's hot reload runs over a WebSocket, which arrives as an HTTP upgrade
  // rather than a normal request — without this the page loads but never
  // live-reloads while the dashboard is being worked on.
  server.on('upgrade', (req, socket, head) => {
    if (guardRequest(req)) { socket.destroy(); return; }
    const up = http.request({
      host: '127.0.0.1', port: vitePort, path: req.url,
      method: req.method, headers: req.headers,
    });
    up.on('upgrade', (upRes, upSocket, upHead) => {
      const headers = Object.entries(upRes.headers)
        .map(([k, v]) => `${k}: ${v}`).join('\r\n');
      socket.write(`HTTP/1.1 101 Switching Protocols\r\n${headers}\r\n\r\n`);
      if (upHead?.length) upSocket.unshift(upHead);
      upSocket.pipe(socket).pipe(upSocket);
    });
    up.on('error', () => socket.destroy());
    if (head?.length) up.write(head);
    up.end();
  });

  return server;
}
