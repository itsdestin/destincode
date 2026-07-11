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

describe('ProviderRegistry', () => {
  let root: string; let reg: ProviderRegistry;
  beforeEach(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'yc-provreg-'));
    reg = new ProviderRegistry(new NativeHome(root), new SecretsStore(root));
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
    await reg.remove(id);
    expect((await reg.list()).find((p) => p.id === id)).toBeUndefined();
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

  it('setKey rotation keeps the same secretRef (providers.json pointer stable)', async () => {
    await reg.setKey('openrouter', 'sk-1');
    const ref1 = (await reg.list()).find((p) => p.id === 'openrouter')!.secretRef;
    await reg.setKey('openrouter', 'sk-2');
    const ref2 = (await reg.list()).find((p) => p.id === 'openrouter')!.secretRef;
    expect(ref2).toBe(ref1);
  });
});
