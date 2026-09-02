// SendUserLink — the link mirror of SendUserFile (spec 2026-09-02, slice A).
// Stateless: validates URLs, reports, and leaves the one-open-per-reply rule
// to the renderer (deliverable-auto-open.ts, which today stays file-only — the
// card renders links, the auto-open rule does not open browser tabs
// uninvited). Errors name every bad URL WITH its reason — an unsupported
// scheme failing as "not a URL" would be a lie
// (docs/error-message-standards.md).
import { describe, it, expect } from 'vitest';
import { SendUserLinkTool } from '../src/main/harness/tools/send-user-link';
import type { ToolContext } from '../src/main/harness/tools/types';

const ctx: ToolContext = { sessionId: 'test', cwd: '/tmp', signal: new AbortController().signal, readRegistry: new Map(), todos: [] };

describe('SendUserLink', () => {
  it('sends one http link', async () => {
    const r = await SendUserLinkTool.execute({ links: [{ url: 'https://example.com' }] }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe('Sent 1 link to the user.');
  });

  it('sends several links; label/display/caption do not change the text', async () => {
    const r = await SendUserLinkTool.execute(
      { links: [{ url: 'https://a.com' }, { url: 'http://localhost:5173', label: 'dev server' }], caption: 'both', display: 'render', status: 'normal' },
      ctx,
    );
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe('Sent 2 links to the user.');
  });

  it('accepts localhost and LAN IPs with explicit http(s)', async () => {
    const r = await SendUserLinkTool.execute({ links: [{ url: 'http://localhost:5173' }, { url: 'http://192.168.1.20:8080' }] }, ctx);
    expect(r.isError).toBeFalsy();
    expect(r.text).toBe('Sent 2 links to the user.');
  });

  it('a bad link fails the WHOLE call and names every bad URL with its own reason', async () => {
    const r = await SendUserLinkTool.execute({ links: [{ url: 'https://good.com' }, { url: 'not a url' }] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('nothing was sent');
    expect(r.text).toContain('not a url');
    expect(r.text).not.toContain('good.com');
  });

  it('an unsupported scheme is named as unsupported, never as malformed', async () => {
    const r = await SendUserLinkTool.execute({ links: [{ url: 'file:///etc/passwd' }] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('file:///etc/passwd: only http:// and https:// URLs can be sent');
    expect(r.text).not.toContain('not a URL');
  });

  it('a bare host:port is NOT accepted — no explicit http(s) scheme means it cannot be opened safely', async () => {
    // new URL('localhost:5173') parses as a scheme-less URL; the tool's
    // http(s)-only scheme check must reject it (never send, never open).
    const r = await SendUserLinkTool.execute({ links: [{ url: 'localhost:5173' }] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('localhost:5173');
    expect(r.text).not.toContain('Sent 1 link');
  });

  it('a javascript: URL is rejected — never openable, never rendered as a link', async () => {
    const r = await SendUserLinkTool.execute({ links: [{ url: 'javascript:alert(1)' }] }, ctx);
    expect(r.isError).toBe(true);
    expect(r.text).toContain('only http:// and https:// URLs can be sent');
  });

  it('lists every bad URL paired with ITS OWN reason, in the shared "url: reason" shape', async () => {
    const r = await SendUserLinkTool.execute({ links: [{ url: 'not a url' }, { url: 'ftp://x' }] }, ctx);
    const lines = r.text.split('\n').filter((l) => l.startsWith('- '));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('not a url');
    expect(lines[1]).toBe('- ftp://x: only http:// and https:// URLs can be sent');
  });

  it('has no permission subject (a link is not a path — nothing to jail)', () => {
    expect(SendUserLinkTool.permissionSubject({ links: [{ url: 'https://example.com' }] })).toBeUndefined();
  });

  it('tells the model that localhost/LAN is allowed and only http/https is', () => {
    expect(SendUserLinkTool.description).toMatch(/localhost/i);
    expect(SendUserLinkTool.description).toMatch(/https?:\/\//i);
  });
});