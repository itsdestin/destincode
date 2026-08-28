// The workbench's stand-in for the WeCoded Worker (the Cloudflare backend
// behind install counts, ratings, thumbs and comments).
//
// WHY: the stats/ratings code talks to the Worker with plain `fetch`, not
// through `window.claude`, so the mock shim could not intercept it — every
// workbench session hit the PRODUCTION Worker for numbers, which made the
// review rig's Before/After diffs drift whenever a real install landed, and
// meant the marketplace overhaul design (thumbs + comments, 2026-08-27)
// could not be shown at all since those routes don't exist yet. Answering
// from fixtures here makes the numbers deterministic and keeps the
// workbench offline, like the rest of the fake backend.
//
// Routes with NO real backend yet (the backend to-do once the design is
// approved — the Worker equivalent of mock-only.ts):
//   GET  /comments/:plugin_id   → { comments: [...] }
//   POST /comments              → { id }
//   POST /thumbs                → { ok: true }
//   GET  /stats                 → plugins[id] gains thumbs_up / thumbs_down
import { MARKETPLACE_API_HOST } from '../../../../state/marketplace-api-client';
import { FAKE_COMMENTS, FAKE_STATS, type FakeComment } from './catalog';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function installWorkerApiMock(): void {
  // jsdom test runs have no fetch; the unit suite only checks the bridge.
  if (typeof window.fetch !== 'function') return;
  const realFetch = window.fetch.bind(window);
  // Per-session mutable copies so posting a comment or a thumb shows up
  // immediately, the way the real Worker would echo it back.
  const comments: Record<string, FakeComment[]> = JSON.parse(JSON.stringify(FAKE_COMMENTS));
  const stats = JSON.parse(JSON.stringify(FAKE_STATS)) as typeof FAKE_STATS;

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith(MARKETPLACE_API_HOST)) return realFetch(input, init);
    const path = url.slice(MARKETPLACE_API_HOST.length).split('?')[0];
    const method = (init?.method ?? 'GET').toUpperCase();

    if (path === '/stats' && method === 'GET') {
      return json({ generated_at: Math.floor(Date.now() / 1000), plugins: stats, themes: { 'golden-sunbreak': { likes: 41 }, 'meadow-mist': { likes: 88 }, 'halftone-dimension': { likes: 120 } } });
    }
    if (path.startsWith('/ratings/') && method === 'GET') return json({ ratings: [] });
    if (path.startsWith('/comments/') && method === 'GET') {
      const id = decodeURIComponent(path.slice('/comments/'.length));
      return json({ comments: comments[id] ?? [] });
    }
    if (path === '/comments' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { plugin_id: string; text: string };
      const row: FakeComment = { id: `c${Date.now()}`, user_id: 'github:you', user_login: 'you', user_avatar_url: '', text: body.text, created_at: Math.floor(Date.now() / 1000) };
      (comments[body.plugin_id] ??= []).unshift(row);
      return json({ id: row.id });
    }
    if (path === '/thumbs' && method === 'POST') {
      const body = JSON.parse(String(init?.body ?? '{}')) as { plugin_id: string; value: 'up' | 'down' | null };
      const s = (stats[body.plugin_id] ??= { installs: 0, review_count: 0, rating: 0, thumbs_up: 0, thumbs_down: 0 });
      if (body.value === 'up') s.thumbs_up += 1;
      if (body.value === 'down') s.thumbs_down += 1;
      return json({ ok: true });
    }
    if (path === '/installs' && method === 'POST') return json({ ok: true });
    if (path === '/health') return json({ ok: true });
    return json({ error: `workbench: no fake for ${method} ${path}` }, 404);
  };
}
