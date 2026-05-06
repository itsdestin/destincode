import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs/promises';
import { OpenCodeConfigWriter } from '../src/main/opencode-config-writer';

describe('OpenCodeConfigWriter', () => {
  let tmpHome: string;
  let writer: OpenCodeConfigWriter;

  beforeEach(async () => {
    tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), 'oc-cfg-'));
    writer = new OpenCodeConfigWriter(tmpHome);
  });

  afterEach(async () => { await fs.rm(tmpHome, { recursive: true, force: true }); });

  it('writeOllamaConfig() creates opencode.json with the Ollama provider declared', async () => {
    await writer.writeOllamaConfig({ ollamaBaseUrl: 'http://localhost:11434' });
    const text = await fs.readFile(path.join(tmpHome, '.config', 'opencode', 'opencode.json'), 'utf8');
    const cfg = JSON.parse(text);
    expect(cfg.provider).toBeDefined();
    expect(cfg.provider.ollama).toBeDefined();
    expect(cfg.provider.ollama.options.baseURL).toBe('http://localhost:11434/v1');
    expect(cfg.provider.ollama.npm).toBe('@ai-sdk/openai-compatible');
  });

  it('writeOllamaConfig() does NOT write auth.json (Ollama via OpenAI-compat needs no auth)', async () => {
    // Verified API Surface confirms: for local Ollama (no auth), auth.json is
    // not required by OpenCode. Don't write a file users will be confused by.
    await writer.writeOllamaConfig({ ollamaBaseUrl: 'http://localhost:11434' });
    await expect(fs.access(path.join(tmpHome, '.config', 'opencode', 'auth.json'))).rejects.toThrow();
  });

  it('writeOllamaConfig() preserves user-modified fields outside provider/ollama', async () => {
    // Pre-seed an existing config with custom fields
    await fs.mkdir(path.join(tmpHome, '.config', 'opencode'), { recursive: true });
    await fs.writeFile(
      path.join(tmpHome, '.config', 'opencode', 'opencode.json'),
      JSON.stringify({ theme: 'dracula', model: 'somethingelse', custom: 'field' }),
      'utf8',
    );
    await writer.writeOllamaConfig({ ollamaBaseUrl: 'http://localhost:11434' });
    const cfg = JSON.parse(await fs.readFile(path.join(tmpHome, '.config', 'opencode', 'opencode.json'), 'utf8'));
    expect(cfg.theme).toBe('dracula');
    expect(cfg.custom).toBe('field');
    expect(cfg.provider.ollama).toBeDefined();
  });

  it('writeOllamaConfig() accepts non-default endpoint (e.g. LM Studio)', async () => {
    await writer.writeOllamaConfig({ ollamaBaseUrl: 'http://localhost:1234' });
    const cfg = JSON.parse(await fs.readFile(path.join(tmpHome, '.config', 'opencode', 'opencode.json'), 'utf8'));
    expect(cfg.provider.ollama.options.baseURL).toBe('http://localhost:1234/v1');
  });

  it('writeOllamaConfig() sets permission policy to allow-all (MVP simplification)', async () => {
    // Without this, OpenCode's permission system would prompt on every tool
    // call and the prompts have no UI listener in MVP — tools would hang.
    // Per "Verified API Surface": top-level "permission": "allow" string
    // shorthand (NOT permission.default).
    await writer.writeOllamaConfig({ ollamaBaseUrl: 'http://localhost:11434' });
    const cfg = JSON.parse(await fs.readFile(path.join(tmpHome, '.config', 'opencode', 'opencode.json'), 'utf8'));
    expect(cfg.permission).toBe('allow');
  });

  it('writeOllamaConfig() populates the models map from the installed-models list', async () => {
    // Empirically confirmed (OpenCode 1.14.39 daemon log): without this map,
    // `prompt_async` fails with ProviderModelNotFoundError even though the
    // provider adapter loaded. The OpenAI-compat adapter is config-driven,
    // not /api/tags-discovery-driven.
    await writer.writeOllamaConfig({
      ollamaBaseUrl: 'http://localhost:11434',
      models: ['qwen3:8b', 'llama3.1:70b'],
    });
    const cfg = JSON.parse(await fs.readFile(path.join(tmpHome, '.config', 'opencode', 'opencode.json'), 'utf8'));
    expect(cfg.provider.ollama.models).toBeDefined();
    expect(cfg.provider.ollama.models['qwen3:8b'].name).toBe('Qwen3 8B');
    expect(cfg.provider.ollama.models['llama3.1:70b'].name).toBe('Llama3.1 70B');
  });

  it('writeOllamaConfig() writes an empty models map when no models are passed', async () => {
    // Better than a missing key — keeps the schema consistent and signals
    // "the writer ran but no models were available" (e.g. Ollama unreachable).
    await writer.writeOllamaConfig({ ollamaBaseUrl: 'http://localhost:11434' });
    const cfg = JSON.parse(await fs.readFile(path.join(tmpHome, '.config', 'opencode', 'opencode.json'), 'utf8'));
    expect(cfg.provider.ollama.models).toEqual({});
  });

  it('writeOllamaConfig() defaults reasoningEffort to "none" on every model', async () => {
    // Required for thinking models (qwen3, deepseek-r1, etc.). Without "none",
    // they emit all tokens into the `reasoning` field, leaving `content` empty,
    // and OpenCode hangs forever waiting for content. Verified end-to-end
    // against qwen3:8b. Non-thinking models simply ignore the option.
    await writer.writeOllamaConfig({
      ollamaBaseUrl: 'http://localhost:11434',
      models: ['qwen3:8b'],
    });
    const cfg = JSON.parse(await fs.readFile(path.join(tmpHome, '.config', 'opencode', 'opencode.json'), 'utf8'));
    expect(cfg.provider.ollama.models['qwen3:8b'].options).toEqual({ reasoningEffort: 'none' });
  });
});
