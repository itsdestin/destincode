// Ollama / LM Studio detectors (spec §4.5): probe the default localhost ports;
// a hit becomes a one-click "add as endpoint" that creates a plain
// openai-compatible provider entry via the EXISTING provider:upsert IPC.
// Never required, never auto-added (ADR 007) — this module only DETECTS.
// Detector URLs are salvaged from the archived feat/opencode-mvp
// OllamaDetector (probe pattern only; the pull/streaming code is not needed —
// our downloader owns model installs).
import type { DetectedEndpoint } from '../../shared/model-manager-types';
import type { ProviderConfig } from '../../shared/provider-types';

const PROBE_TIMEOUT_MS = 1_500; // localhost — anything slower is "not running"

export async function detectEndpoints(
  fetchImpl: typeof fetch,
  existingProviders: ProviderConfig[]
): Promise<DetectedEndpoint[]> {
  const stripSlash = (u: string) => u.replace(/\/+$/, '');
  const added = new Set(
    existingProviders
      .filter((p) => p.type === 'openai-compatible' && typeof p.baseUrl === 'string')
      .map((p) => stripSlash(p.baseUrl!))
  );
  const out: DetectedEndpoint[] = [];

  // Ollama: /api/tags lists installed models — { models: [...] }.
  try {
    const res = await fetchImpl('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) {
      const json: any = await res.json();
      out.push({
        kind: 'ollama', label: 'Ollama (local)',
        baseUrl: 'http://localhost:11434/v1', // Ollama's OpenAI-compatible surface
        modelCount: Array.isArray(json?.models) ? json.models.length : null,
        alreadyAdded: added.has('http://localhost:11434/v1'),
      });
    }
  } catch { /* not running */ }

  // LM Studio: native OpenAI-compatible /v1/models — { data: [...] }.
  try {
    const res = await fetchImpl('http://localhost:1234/v1/models', {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (res.ok) {
      const json: any = await res.json();
      out.push({
        kind: 'lmstudio', label: 'LM Studio (local)',
        baseUrl: 'http://localhost:1234/v1',
        modelCount: Array.isArray(json?.data) ? json.data.length : null,
        alreadyAdded: added.has('http://localhost:1234/v1'),
      });
    }
  } catch { /* not running */ }

  return out;
}
