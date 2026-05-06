import * as fs from 'fs/promises';
import * as path from 'path';

export interface OllamaConfigOpts {
  /** Base URL of Ollama (without trailing /v1). Default: http://localhost:11434 */
  ollamaBaseUrl: string;
  /**
   * Names of installed Ollama models (as returned by /api/tags, e.g. "qwen3:8b").
   * REQUIRED — without an entry here, OpenCode rejects prompts for that model
   * with ProviderModelNotFoundError. The OpenAI-compatible adapter does NOT
   * auto-discover from /api/tags; model registration is config-driven.
   */
  models?: string[];
}

export class OpenCodeConfigWriter {
  private readonly configDir: string;

  constructor(homeDir: string) {
    // OpenCode reads from ~/.config/opencode/ on every platform (verified empirically
    // on Windows 11 — the daemon's startup log lists this exact path, NOT %APPDATA%).
    this.configDir = path.join(homeDir, '.config', 'opencode');
  }

  /** Declare an Ollama-via-OpenAI-compat provider in opencode.json. No auth.json — Ollama has no API key. */
  async writeOllamaConfig(opts: OllamaConfigOpts): Promise<void> {
    await fs.mkdir(this.configDir, { recursive: true });
    const cfgPath = path.join(this.configDir, 'opencode.json');

    // Merge into existing opencode.json if present (preserve user fields)
    let cfg: any = {};
    try {
      cfg = JSON.parse(await fs.readFile(cfgPath, 'utf8'));
    } catch (e: any) {
      if (e?.code !== 'ENOENT') throw e;
    }
    cfg.provider = cfg.provider ?? {};
    // Build the models map. Without this, OpenCode raises
    // ProviderModelNotFoundError on every prompt — even though the provider
    // adapter itself loaded successfully and Ollama has the model. The map
    // also lets us give human-readable display names per model.
    //
    // Per-model `options.reasoningEffort: "none"` is critical for thinking
    // models (qwen3, deepseek-r1, gemini-2.5, etc.). Without it, those models
    // dump every token into a `reasoning` field, leaving `content` empty —
    // OpenCode reads `content`, sees nothing, and the chat hangs forever.
    // "none" is documented (Ollama #14820, ai-sdk openai-compatible) and
    // verified end-to-end against qwen3:8b. The Model Options chip overrides
    // this per-session when the user wants to enable thinking.
    const modelsMap: Record<string, { name: string; options: Record<string, unknown> }> = {};
    for (const id of opts.models ?? []) {
      modelsMap[id] = {
        name: humanizeModelId(id),
        options: { reasoningEffort: 'none' },
      };
    }
    cfg.provider.ollama = {
      npm: '@ai-sdk/openai-compatible',
      name: 'Ollama (local)',
      options: {
        baseURL: opts.ollamaBaseUrl.replace(/\/$/, '') + '/v1',
      },
      models: modelsMap,
    };
    // MVP simplification: allow all tool calls without per-call user approval.
    // Matches Claude's --dangerously-skip-permissions mode. Stage B integrates
    // OpenCode's permission events into our existing PERMISSION_REQUEST UI.
    // Top-level "permission": "allow" string shorthand (per Verified API Surface).
    cfg.permission = cfg.permission ?? 'allow';
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  }
}

/** "qwen3:8b" → "Qwen3 8B"; "llama3.1:70b" → "Llama3.1 70B". Best-effort cosmetic. */
function humanizeModelId(id: string): string {
  const [base, tag] = id.split(':');
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const baseLabel = cap(base ?? id);
  if (!tag) return baseLabel;
  return `${baseLabel} ${tag.toUpperCase()}`;
}
