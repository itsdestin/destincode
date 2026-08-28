// ProviderRegistry — the contract for provider CRUD + key management + the
// languageModel() factory the native harness calls. Key pins: built-ins seed
// idempotently, upsert never persists derived status fields (the ProviderStatus
// doc warning), list() never leaks key material, and rotation keeps secretRef
// stable so providers.json pointers never need rewriting.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs'; import * as path from 'path'; import * as os from 'os';
import { NativeHome } from '../src/main/native-home';
import { SecretsStore } from '../src/main/providers/secrets-store';
import { ProviderRegistry } from '../src/main/providers/provider-registry';
import { openRouterCostExtractor } from '../src/main/harness/pricing';
import type { LocalEngineHook } from '../src/main/engine/engine-manager';

describe('ProviderRegistry', () => {
  let root: string; let reg: ProviderRegistry; let secrets: SecretsStore;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-provreg-'));
    secrets = new SecretsStore(root);
    reg = new ProviderRegistry(new NativeHome(root), secrets);
    await reg.init();
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it('seeds the two built-ins on first init and is idempotent', async () => {
    const list = await reg.list();
    expect(list.map((p) => p.id).sort()).toEqual(['local', 'openrouter']);
    expect(list.every((p) => p.builtIn)).toBe(true);
    await reg.init(); // second init must not duplicate
    expect((await reg.list())).toHaveLength(2);
  });

  it('local is not ready in Plan A; openrouter becomes ready once a key is set', async () => {
    let list = await reg.list();
    expect(list.find((p) => p.id === 'local')!.ready).toBe(false);
    expect(list.find((p) => p.id === 'openrouter')!.ready).toBe(false);
    await reg.setKey('openrouter', 'sk-or-abc');
    list = await reg.list();
    expect(list.find((p) => p.id === 'openrouter')!.ready).toBe(true);
  });

  it('refuses to remove built-ins; removes user entries and their secret', async () => {
    await expect(reg.remove('openrouter')).rejects.toThrow(/built-in/);
    const id = await reg.upsert({ type: 'openai-compatible', label: 'My LM Studio', baseUrl: 'http://localhost:1234/v1', enabled: true });
    await reg.setKey(id, 'whatever');
    const ref = (await reg.list()).find((p) => p.id === id)!.secretRef!;
    expect(secrets.has(ref)).toBe(true); // sanity: the secret exists before remove
    await reg.remove(id);
    expect((await reg.list()).find((p) => p.id === id)).toBeUndefined();
    expect(secrets.has(ref)).toBe(false); // ...and its secret was deleted too
  });

  it('upsert never persists derived status fields (builtIn/hasKey/ready)', async () => {
    const rows = await reg.list();
    // Simulate the renderer bug the ProviderStatus doc warns about: passing a status row back.
    await reg.upsert({ ...rows.find((p) => p.id === 'openrouter')!, enabled: false } as any);
    const onDisk = JSON.parse(fs.readFileSync(path.join(root, '.youcoded', 'providers.json'), 'utf8'));
    const entry = onDisk.providers.find((p: any) => p.id === 'openrouter');
    expect(entry.enabled).toBe(false);           // the real change persisted
    expect(entry.builtIn).toBeUndefined();       // derived fields did NOT
    expect(entry.hasKey).toBeUndefined();
    expect(entry.ready).toBeUndefined();
  });

  it('list() never exposes key material', async () => {
    await reg.setKey('openrouter', 'sk-or-secret');
    const json = JSON.stringify(await reg.list());
    expect(json).not.toContain('sk-or-secret');
  });

  it('languageModel() throws a plain-language error for an unready provider', async () => {
    await expect(reg.languageModel({ providerId: 'openrouter', modelId: 'meta-llama/llama-3-8b' }))
      .rejects.toThrow(/key/i);
    await expect(reg.languageModel({ providerId: 'local', modelId: 'x' }))
      .rejects.toThrow(/not available yet/i);
    await expect(reg.languageModel({ providerId: 'ghost', modelId: 'x' }))
      .rejects.toThrow(/not configured/i);
  });

  it('languageModel() returns an AI SDK handle for a keyed openrouter binding', async () => {
    await reg.setKey('openrouter', 'sk-or-abc');
    const model = await reg.languageModel({ providerId: 'openrouter', modelId: 'meta-llama/llama-3-8b' });
    expect(model).toBeTruthy();
    expect(typeof (model as any).modelId).toBe('string');
  });

  // Plan Task 27. OpenRouter reports the real dollar figure it charged on every
  // response; nothing else this app can talk to does. The hook that reads it is
  // attached to THIS branch only, and pricing.ts is emphatic that a provider
  // which reports nothing must read as nothing rather than as $0 — so a stray
  // extractor on a provider that never fills it in would be worse than none.
  it('openrouter asks the SDK to read the provider’s own cost off the wire', async () => {
    await reg.setKey('openrouter', 'sk-or-abc');
    const model = await reg.languageModel({ providerId: 'openrouter', modelId: 'openai/gpt-4o' });
    expect((model as any).config.metadataExtractor).toBe(openRouterCostExtractor);
  });

  it('no other provider claims to report a cost', async () => {
    const id = await reg.upsert({ type: 'openai-compatible', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', enabled: true });
    const model = await reg.languageModel({ providerId: id, modelId: 'llama3' });
    expect((model as any).config.metadataExtractor).toBeUndefined();
  });

  // The plan expected a `usage: { include: true }` request body alongside the
  // extractor. OpenRouter's own Usage Accounting docs (fetched 2026-08-27) say
  // that parameter — and `stream_options: { include_usage: true }` — are
  // "deprecated and have no effect", because full usage details are now always
  // included automatically. Sending it would be code that claims to ask for
  // something it cannot ask for, so the body stays exactly as the SDK builds it.
  // NAME NARROWED (plan Task 30 item 3): this asserts one specific thing — that
  // no body-rewriting hook is installed — and the old name claimed it proved
  // the whole body asks for nothing, which it did not: the body still carried
  // `stream_options: { include_usage: true }` while this passed. The claim
  // about the BODY is now guarded by reading the real captured body, in
  // provider-cost-check.test.ts ("asks for the cost in NO request-body
  // parameter"). Both are kept: this one is the cheap structural check.
  it('installs no request-body rewriting hook on the OpenRouter branch', async () => {
    await reg.setKey('openrouter', 'sk-or-abc');
    const model = await reg.languageModel({ providerId: 'openrouter', modelId: 'openai/gpt-4o' });
    expect((model as any).config.transformRequestBody).toBeUndefined();
  });

  it('setKey rotation keeps the same secretRef (providers.json pointer stable)', async () => {
    await reg.setKey('openrouter', 'sk-1');
    const ref1 = (await reg.list()).find((p) => p.id === 'openrouter')!.secretRef;
    await reg.setKey('openrouter', 'sk-2');
    const ref2 = (await reg.list()).find((p) => p.id === 'openrouter')!.secretRef;
    expect(ref2).toBe(ref1);
  });

  it('languageModel() throws when the provider is disabled', async () => {
    await reg.setKey('openrouter', 'sk-or-abc'); // keyed, so ONLY the disable can be the reason
    await reg.upsert({ id: 'openrouter', type: 'openrouter', label: 'OpenRouter', enabled: false });
    await expect(reg.languageModel({ providerId: 'openrouter', modelId: 'x' }))
      .rejects.toThrow(/disabled/i);
  });

  it('openai-compatible without a key is ready and returns a handle (Ollama/LM Studio)', async () => {
    const id = await reg.upsert({ type: 'openai-compatible', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', enabled: true });
    expect((await reg.list()).find((p) => p.id === id)!.ready).toBe(true);
    const model = await reg.languageModel({ providerId: id, modelId: 'llama3' });
    expect(typeof (model as any).modelId).toBe('string');
  });

  // Same bug as the local-engine pin below, on the branch that serves Ollama,
  // LM Studio and every custom endpoint: @ai-sdk/openai-compatible only sends
  // `stream_options:{include_usage:true}` when includeUsage is configured, and
  // a STREAMING response without it carries no usage block at all — so every
  // turn records inputTokens:0 and falls back to a chars/4 guess, starving both
  // the context gauge and the compaction trigger that read the same number.
  // This branch had no test of its own: deleting the flag here left the whole
  // desktop suite green (found reviewing 51e8b80e), and it is the same defect
  // the local branch actually shipped on 2026-07-28.
  it('openai-compatible: asks the server for real token counts', async () => {
    const id = await reg.upsert({ type: 'openai-compatible', label: 'Ollama', baseUrl: 'http://localhost:11434/v1', enabled: true });
    const model = await reg.languageModel({ providerId: id, modelId: 'llama3' });
    expect((model as any).config.includeUsage).toBe(true);
  });

  it('upsert partial update keeps omitted fields (baseUrl survives a label-only edit)', async () => {
    const id = await reg.upsert({ type: 'openai-compatible', label: 'Before', baseUrl: 'http://localhost:1234/v1', enabled: true });
    // Omit baseUrl entirely — the on-disk value must survive the merge.
    await reg.upsert({ id, type: 'openai-compatible', label: 'After', enabled: true } as any);
    const row = (await reg.list()).find((p) => p.id === id)!;
    expect(row.label).toBe('After');
    expect(row.baseUrl).toBe('http://localhost:1234/v1');
  });

  describe('local-engine hook (Plan B)', () => {
    function makeHook(overrides: Partial<LocalEngineHook> = {}): LocalEngineHook {
      return {
        installed: () => true,
        ensureRunning: async () => 'http://127.0.0.1:9999/v1',
        fetchImpl: () => fetch,
        ensureServable: async () => true, // fails OPEN in production too
        ...overrides,
      };
    }

    it('list(): local provider ready tracks hook.installed()', async () => {
      const withEngine = new ProviderRegistry(new NativeHome(root), secrets, makeHook());
      await withEngine.init();
      expect((await withEngine.list()).find((p) => p.id === 'local')?.ready).toBe(true);

      const without = new ProviderRegistry(new NativeHome(root), secrets, makeHook({ installed: () => false }));
      expect((await without.list()).find((p) => p.id === 'local')?.ready).toBe(false);
    });

    it('languageModel(local): awaits ensureRunning before returning a handle', async () => {
      const ensure = vi.fn(async () => 'http://127.0.0.1:9999/v1');
      const reg = new ProviderRegistry(new NativeHome(root), secrets, makeHook({ ensureRunning: ensure }));
      await reg.init();
      await reg.languageModel({ providerId: 'local', modelId: 'tiny-Q4_K_M' });
      expect(ensure).toHaveBeenCalledTimes(1);
    });

    it('languageModel(local): surfaces the hook install-guidance error verbatim', async () => {
      const reg = new ProviderRegistry(new NativeHome(root), secrets, makeHook({
        ensureRunning: async () => { throw new Error('Local models need a one-time engine install — open Settings → Providers and press Install.'); },
      }));
      await reg.init();
      await expect(reg.languageModel({ providerId: 'local', modelId: 'x' }))
        .rejects.toThrow(/one-time engine install/);
    });

    // The router discovers GGUFs at boot and re-scans only when asked, so a model
    // downloaded since is a selectable picker row it has never heard of. This is
    // the chokepoint every local send crosses — create, mid-session swap, remote.
    it('languageModel(local): asks whether the router can actually serve the model', async () => {
      const servable = vi.fn(async () => true);
      const reg = new ProviderRegistry(new NativeHome(root), secrets, makeHook({ ensureServable: servable }));
      await reg.init();
      await reg.languageModel({ providerId: 'local', modelId: 'tiny-Q4_K_M' });
      expect(servable).toHaveBeenCalledWith('tiny-Q4_K_M');
    });

    it('languageModel(local): an unservable model fails with the REAL cause, not the router 400', async () => {
      const reg = new ProviderRegistry(new NativeHome(root), secrets, makeHook({ ensureServable: async () => false }));
      await reg.init();
      // The raw router error is `model 'X' not found (provider error 400)`, which
      // reads as "your 29 GB download is corrupt" and invites a needless
      // re-download. Name the model, name the real cause, name the remedy.
      await expect(reg.languageModel({ providerId: 'local', modelId: 'gone-Q4_K_M' }))
        .rejects.toThrow(/could not find the model file for 'gone-Q4_K_M'.*re-download/s);
    });

    it('languageModel(local): with NO hook, keeps Plan A behavior (not-available error)', async () => {
      const reg = new ProviderRegistry(new NativeHome(root), secrets);
      await reg.init();
      await expect(reg.languageModel({ providerId: 'local', modelId: 'x' }))
        .rejects.toThrow(/not available yet/);
    });

    // Serial-only constraint (Task 10 / spec §4.2): small local models can't handle
    // parallel tool calls, so when the harness asks for serialToolCalls the
    // local-engine model must inject `parallel_tool_calls:false` into the request
    // body. We assert on the createOpenAICompatible config's transformRequestBody
    // hook (verified against @ai-sdk/openai-compatible@3.0.7: the config object,
    // incl. our hook, is stored on the model instance as `.config`).
    it('languageModel(local): serialToolCalls injects parallel_tool_calls:false via transformRequestBody', async () => {
      const reg = new ProviderRegistry(new NativeHome(root), secrets, makeHook());
      await reg.init();
      const model = await reg.languageModel({ providerId: 'local', modelId: 'm' }, { serialToolCalls: true });
      const body = (model as any).config.transformRequestBody({ messages: [], model: 'm' });
      expect(body.parallel_tool_calls).toBe(false);
      // The hook is additive — it must not drop the rest of the request body.
      expect(body.model).toBe('m');
    });

    it('languageModel(local): WITHOUT serialToolCalls attaches no transformRequestBody hook', async () => {
      const reg = new ProviderRegistry(new NativeHome(root), secrets, makeHook());
      await reg.init();
      const model = await reg.languageModel({ providerId: 'local', modelId: 'm' });
      // No hook configured → the SDK leaves the body untouched (default parallel).
      expect((model as any).config.transformRequestBody).toBeUndefined();
    });

    // The bug this pins: @ai-sdk/openai-compatible only sends
    // `stream_options:{include_usage:true}` when includeUsage is configured, and
    // a STREAMING OpenAI-compatible response without it carries no usage block at
    // all. We shipped without it, so every native turn recorded inputTokens:0 and
    // fell back to a chars/4 guess for output — starving both the context gauge
    // and the compaction trigger, which reads the same number. Nothing asserted
    // token counts were real, which is exactly why it survived to dogfooding
    // (Destin, 2026-07-28).
    it('languageModel(local): asks the server for real token counts', async () => {
      const reg = new ProviderRegistry(new NativeHome(root), secrets, makeHook());
      await reg.init();
      const model = await reg.languageModel({ providerId: 'local', modelId: 'm' });
      expect((model as any).config.includeUsage).toBe(true);
    });
  });
});
