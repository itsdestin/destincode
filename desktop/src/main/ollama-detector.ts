export interface OllamaModelInfo {
  name: string;
  sizeBytes: number;
  modifiedAt: string;
}

export type PullEvent =
  | { kind: 'status'; status: string }
  | { kind: 'progress'; status: string; completedBytes: number; totalBytes: number }
  | { kind: 'done' }
  | { kind: 'error'; message: string };

/** Probes a running Ollama server. Does not install Ollama itself. */
export class OllamaDetector {
  constructor(
    private readonly baseUrl: string = 'http://localhost:11434',
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async isReachable(): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/version`, { method: 'GET' });
      return res.ok;
    } catch { return false; }
  }

  async listModels(): Promise<OllamaModelInfo[]> {
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/api/tags`, { method: 'GET' });
      if (!res.ok) return [];
      const json = await res.json() as { models?: Array<{ name: string; size: number; modified_at: string }> };
      return (json.models ?? []).map(m => ({ name: m.name, sizeBytes: m.size, modifiedAt: m.modified_at }));
    } catch { return []; }
  }

  /** Pull a model from the registry. Streams NDJSON chunks; calls onEvent for each parsed entry. */
  async pullModel(name: string, onEvent: (ev: PullEvent) => void): Promise<void> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, stream: true }),
      });
    } catch (e: any) {
      onEvent({ kind: 'error', message: String(e?.message ?? e) });
      return;
    }
    if (!res.ok || !res.body) {
      onEvent({ kind: 'error', message: `pull failed: HTTP ${res.status}` });
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!line) continue;
        try {
          const parsed = JSON.parse(line) as { status?: string; completed?: number; total?: number; error?: string };
          if (parsed.error) { onEvent({ kind: 'error', message: parsed.error }); return; }
          if (parsed.status === 'success') { onEvent({ kind: 'done' }); return; }
          if (typeof parsed.completed === 'number' && typeof parsed.total === 'number') {
            onEvent({ kind: 'progress', status: parsed.status ?? 'downloading', completedBytes: parsed.completed, totalBytes: parsed.total });
          } else if (parsed.status) {
            onEvent({ kind: 'status', status: parsed.status });
          }
        } catch { /* skip unparseable lines */ }
      }
    }
    onEvent({ kind: 'done' });
  }
}
