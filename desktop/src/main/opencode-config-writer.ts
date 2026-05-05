import * as fs from 'fs/promises';
import * as path from 'path';

export interface OllamaConfigOpts {
  /** Base URL of Ollama (without trailing /v1). Default: http://localhost:11434 */
  ollamaBaseUrl: string;
}

export class OpenCodeConfigWriter {
  private readonly configDir: string;

  constructor(homeDir: string) {
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
    cfg.provider.ollama = {
      npm: '@ai-sdk/openai-compatible',
      name: 'Ollama (local)',
      options: {
        baseURL: opts.ollamaBaseUrl.replace(/\/$/, '') + '/v1',
      },
    };
    // MVP simplification: allow all tool calls without per-call user approval.
    // Matches Claude's --dangerously-skip-permissions mode. Stage B integrates
    // OpenCode's permission events into our existing PERMISSION_REQUEST UI.
    // Top-level "permission": "allow" string shorthand (per Verified API Surface).
    cfg.permission = cfg.permission ?? 'allow';
    await fs.writeFile(cfgPath, JSON.stringify(cfg, null, 2), 'utf8');
  }
}
