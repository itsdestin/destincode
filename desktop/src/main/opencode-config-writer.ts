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
    // Each installed Ollama model expands into TWO entries — canonical
    // (effort=none / "off") and an `@on` variant (effort=medium, but
    // semantically "thinking on"). Both share the canonical Ollama model
    // via the variant's `id:` field. Switched from 4 variants (low/med/high)
    // to 2 on 2026-05-11 after research confirmed Ollama collapses all
    // non-none reasoning_effort tiers to a single `think: true` upstream —
    // only `gpt-oss` honors graduated tiers. Keeping low/med/high in the
    // wire format added confusion without any behavioral payoff.
    //
    //   - qwen3:8b    → effort=none (canonical, IS the off variant)
    //   - qwen3:8b@on → id=qwen3:8b, effort=medium (semantically "thinking on")
    //
    // `medium` is the chosen "on" tier because Ollama's translation maps any
    // of low/medium/high to think:true identically — picking the middle is
    // an arbitrary defensive choice.
    type ModelEntry = { id?: string; name: string; options: Record<string, unknown> };
    const modelsMap: Record<string, ModelEntry> = {};
    for (const id of opts.models ?? []) {
      const baseName = humanizeModelId(id);
      // Canonical entry — no `id:` field (the map key IS the id).
      modelsMap[id] = {
        name: baseName,
        options: { reasoningEffort: 'none' },
      };
      // `@on` variant — explicit `id:` redirects to the canonical model.
      modelsMap[`${id}@on`] = {
        id,
        name: `${baseName} (thinking)`,
        options: { reasoningEffort: 'medium' },
      };
    }
    // Defensive: a renderer caller passing undefined here used to crash with
    // a TypeError ("Cannot read properties of undefined (reading 'replace')")
    // which the renderer's silent catch then swallowed — the on-disk config
    // never got written, the daemon never restarted, and freshly-pulled models
    // returned ProviderModelNotFoundError. Coerce instead so the writer is
    // robust to undefined/empty endpoint values regardless of caller hygiene.
    const baseUrl = (opts.ollamaBaseUrl && opts.ollamaBaseUrl.trim().length > 0)
      ? opts.ollamaBaseUrl
      : 'http://localhost:11434';
    cfg.provider.ollama = {
      npm: '@ai-sdk/openai-compatible',
      name: 'Ollama (local)',
      options: {
        baseURL: baseUrl.replace(/\/$/, '') + '/v1',
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
