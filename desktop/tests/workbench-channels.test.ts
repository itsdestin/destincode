import { describe, it, expect } from 'vitest';
import { createStore } from '../src/renderer/dev/workbench/mock-store';
import { createMockShim, setLatency } from '../src/renderer/dev/workbench/mock-shim';
import { validateTheme } from '../src/renderer/themes/theme-validator';

// Latency is real, so it would add 150ms to every awaited call in this file.
// The default is asserted in workbench-shim-semantics.test.ts instead.
setLatency(0);

const shim = (scenario: Parameters<typeof createStore>[0] = 'default') =>
  createMockShim(createStore(scenario)) as any;

describe('workbench channels', () => {
  it('session.browse returns the seeded past sessions', async () => {
    expect((await shim().session.browse()).length).toBeGreaterThan(0);
  });

  it('session.create adds a row that session.list then returns', async () => {
    const c = shim();
    const before = (await c.session.list()).length;
    await c.session.create({ name: 'new one', cwd: '/tmp', skipPermissions: false });
    expect((await c.session.list()).length).toBe(before + 1);
  });

  it('session.setTag persists and is readable back', async () => {
    const c = shim();
    const id = (await c.session.browse())[0].sessionId;
    await c.session.setTag(id, 'tag_idea', true);
    const row = (await c.session.browse()).find((s: any) => s.sessionId === id);
    expect(row.tags).toContain('tag_idea');
  });

  // The refused scenario is what makes ResumeBrowser.tsx:428's revert visible.
  it('writes resolve {ok:false} under the refused scenario', async () => {
    const c = shim('refused');
    const id = (await c.session.browse())[0].sessionId;
    expect(await c.session.setTag(id, 'tag_idea', true)).toEqual({ ok: false });
  });

  it('providers.list reflects the scenario', async () => {
    expect((await shim('no-providers').providers.list())
      .every((p: any) => !p.ready)).toBe(true);
  });

  // The renderer does not poll — it re-fetches on these events. A mock that
  // mutates the store without emitting them leaves the UI showing stale data,
  // and "I created a session and nothing appeared" reads as a bug in the
  // surface under design rather than a hole in the mock. Spec §3.3.
  it('session.create fires sessionCreated', async () => {
    const c = shim();
    const seen: any[] = [];
    c.on.sessionCreated((s: any) => seen.push(s));
    await c.session.create({ name: 'n', cwd: '/tmp', skipPermissions: false });
    expect(seen).toHaveLength(1);
    expect(seen[0].name).toBe('n');
  });

  it('session.destroy fires sessionDestroyed', async () => {
    const c = shim();
    const seen: string[] = [];
    c.on.sessionDestroyed((id: string) => seen.push(id));
    await c.session.destroy('wb-1');
    expect(seen).toEqual(['wb-1']);
  });

  it('session.setTag fires sessionMetaChanged', async () => {
    const c = shim();
    let fired = 0;
    c.on.sessionMetaChanged(() => { fired += 1; });
    await c.session.setTag('wb-past-0', 'tag_idea', true);
    expect(fired).toBe(1);
  });

  // session.destroy is typed `Promise<boolean>` in useIpc.ts, NOT {ok}. Getting
  // this wrong would have the caller treat a refusal as success.
  it('session.destroy resolves a boolean, and false when refused', async () => {
    expect(await shim().session.destroy('wb-1')).toBe(true);
    const refused = shim('refused');
    const before = (await refused.session.list()).length;
    expect(await refused.session.destroy('wb-1')).toBe(false);
    expect((await refused.session.list()).length).toBe(before);
  });

  // Every write honours `refused`, not just the tag/flag/note trio. A write
  // that quietly succeeds under this scenario is worse than no scenario at
  // all — it teaches the reviewer the revert path is fine when it never ran.
  it('defaults.set is refused too', async () => {
    const c = shim('refused');
    expect(await c.defaults.set({ model: 'opus' })).toEqual({ ok: false });
    expect((await c.defaults.get()).model).not.toBe('opus');
  });

  it('defaults.set persists when allowed', async () => {
    const c = shim();
    await c.defaults.set({ model: 'opus' });
    expect((await c.defaults.get()).model).toBe('opus');
  });

  // Browser-only mode has no Electron, but detachAvailable gates the "Launch in
  // New Window" toggle in BOTH new-session forms (SessionStrip.tsx:191,
  // ResumeBrowser.tsx:242) — omitting it deletes a control under redesign.
  it('detach.openDetached exists so the new-window toggle renders', () => {
    expect(typeof shim().detach.openDetached).toBe('function');
  });

  it('native.supported is true so the runtime selector renders', () => {
    expect(shim().native.supported).toBe(true);
  });

  // preload.ts names this `delete`, not `remove`. The contract test catches a
  // wrong name; this one catches a wrong behaviour.
  it('tags.delete removes the tag', async () => {
    const c = shim();
    const before = (await c.tags.list()).length;
    await c.tags.delete('tag_bug');
    const after = await c.tags.list();
    expect(after.length).toBe(before - 1);
    expect(after.find((t: any) => t.id === 'tag_bug')).toBeUndefined();
  });

  it('tags.create returns a well-formed record', async () => {
    const tag = await shim().tags.create('newtag', 'tag-teal');
    expect(tag.id.startsWith('tag_')).toBe(true);
    expect(tag).toMatchObject({ label: 'newtag', color: 'tag-teal', archived: false });
    expect(typeof tag.createdAt).toBe('string');
  });

  it('models.memoryCheck returns a verdict from the real union', async () => {
    const res = await shim().models.memoryCheck('qwen2.5-coder:14b');
    expect(['ok', 'tight', 'too-large']).toContain(res.verdict);
  });

  // theme-context.tsx does `validateTheme(JSON.parse(raw))` and swallows the
  // failure with a console.warn — so a corrupt vendored pack would just quietly
  // never appear in the picker. Catch it here instead.
  it('serves a vendored community theme that parses and validates', async () => {
    const c = shim();
    const slugs = await c.theme.list();
    expect(slugs).toContain('halftone-dimension');

    const raw = await c.theme.readFile('halftone-dimension');
    const parsed = JSON.parse(raw);
    expect(parsed.slug).toBe('halftone-dimension');
    expect(parsed.source).toBe('community');
    expect(validateTheme(parsed)).toBeTruthy();
  });

  it('an unknown theme slug returns parseable JSON rather than undefined', async () => {
    const raw = await shim().theme.readFile('nope');
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  it('ships more than one community theme so the picker has real choices', async () => {
    const slugs = await shim().theme.list();
    expect(slugs).toEqual(expect.arrayContaining(['halftone-dimension', 'meadow-mist']));
    expect(slugs.length).toBeGreaterThanOrEqual(2);
  });

  // The gap this closes: a pack references its assets relatively
  // ("assets/pattern.svg"), theme-asset-resolver turns that into a
  // theme-asset:// URI, and a browser tab has no such scheme — so every
  // pattern, mascot and wallpaper rendered broken. The mock rewrites them to
  // Vite URLs first. If this regresses the themes still "work", just without
  // their artwork, which is exactly the kind of silent degradation the
  // workbench is supposed to make impossible.
  it.each(['halftone-dimension', 'meadow-mist'])(
    '%s has every asset reference rewritten to a servable URL',
    async (slug) => {
      const raw = await shim().theme.readFile(slug);
      expect(() => JSON.parse(raw)).not.toThrow();

      // No bare relative reference may survive: `"assets/x.svg"` or
      // `url(assets/x.svg)` would both resolve to theme-asset:// at render time.
      const leftovers = raw.match(/["(]assets\//g) ?? [];
      expect(leftovers).toEqual([]);
    },
  );

  // Vite inlines assets under its 4KB limit as `data:` URIs and serves larger
  // ones as paths, so a rewritten manifest legitimately contains BOTH shapes —
  // which is why theme-asset-resolver has to pass through both. Asserting on a
  // filename would be wrong: pattern.svg is inlined, so its name is gone.
  // The real invariant is "the resolver will leave every one of these alone".
  it.each(['halftone-dimension', 'meadow-mist'])(
    '%s asset values are all shapes resolveAssetPath passes through',
    async (slug) => {
      const parsed = JSON.parse(await shim().theme.readFile(slug));
      const values: string[] = [];
      const walk = (v: unknown) => {
        if (typeof v === 'string') values.push(v);
        else if (Array.isArray(v)) v.forEach(walk);
        else if (v && typeof v === 'object') Object.values(v).forEach(walk);
      };
      walk(parsed);

      // Anything that still looks like a bare relative asset path would become
      // a theme-asset:// URI and render as a broken image.
      const unresolved = values.filter((v) => /^assets\//.test(v));
      expect(unresolved).toEqual([]);

      // And at least one asset actually resolved, or this passes vacuously on a
      // manifest that references no assets at all.
      const resolved = values.filter(
        (v) => v.startsWith('data:') || (v.startsWith('/') && /\.(svg|jpg|webp|png)$/.test(v)),
      );
      expect(resolved.length).toBeGreaterThan(0);
    },
  );
});
