// Live prefill progress from llama.cpp (spec: M3 follow-up, Destin 2026-07-26).
//
// With `return_progress: true`, llama-server streams progress objects DURING
// prompt processing, before any token is generated:
//
//   {"total": 5519, "cache": 0, "processed": 2048, "time_ms": 5838}
//
// Verified empirically against llama.cpp b9992 on /v1/chat/completions: six
// updates for a 5,519-token prompt, roughly one per 2,048-token batch. `cache`
// is broken out so tokens served from the KV cache — which cost nothing — don't
// pollute the estimate.
//
// WHY A TEE, AND NOT THE SDK:
// The chunks reach @ai-sdk/openai-compatible intact — they carry a real
// `delta: {role:'assistant', content:null}` so they pass its `choice?.delta ==
// null` guard, and its `looseObject` chunk schema preserves the extra key. But
// the transform only ever reads known fields, so `prompt_progress` is discarded
// one line later. There is no hook and no providerMetadata path for it.
//
// The provider DOES accept a custom `fetch`, so we wrap that instead: tee the
// response body, parse one branch for progress, hand the untouched original to
// the SDK. No fork, no patch — a supported seam. This is the same shape the
// existing `transformRequestBody` hook uses to inject parallel_tool_calls.

/** One progress reading, exactly as llama-server reports it. */
export interface PrefillProgress {
  /** Prompt tokens that must be processed in total. */
  total: number;
  /** Of those, how many were served from the KV cache (free). */
  cache: number;
  /** How many have been processed so far. */
  processed: number;
  /** Milliseconds elapsed processing them. */
  timeMs: number;
}

/** Progress plus a projected remaining time, when one can be computed. */
export interface PrefillProgressReport extends PrefillProgress {
  /** 0..1 across the whole prompt. */
  fraction: number;
  /**
   * Projected milliseconds remaining, or null when there is nothing to project
   * from (no elapsed time, or nothing processed yet).
   *
   * DELIBERATELY COARSE and known to run OPTIMISTIC: prefill slows as context
   * grows (attention cost is not linear), so a rate measured over the first half
   * under-predicts the second. Measured error against llama.cpp b9992 was ~7% at
   * a third of the way through and ~22% at two thirds. Good enough for "about 10
   * seconds left", not good enough to render a precise number — round it before
   * showing it to anyone.
   */
  etaMs: number | null;
}

export function toReport(p: PrefillProgress): PrefillProgressReport {
  const fraction = p.total > 0 ? Math.min(1, p.processed / p.total) : 0;
  const rate = p.timeMs > 0 && p.processed > 0 ? p.processed / p.timeMs : null;
  const remaining = Math.max(0, p.total - p.processed);
  return { ...p, fraction, etaMs: rate ? Math.round(remaining / rate) : null };
}

/** Pull a progress reading out of one parsed SSE payload, if it carries one. */
export function parseProgressChunk(json: unknown): PrefillProgress | null {
  const pp = (json as any)?.prompt_progress;
  if (!pp || typeof pp !== 'object') return null;
  const total = Number(pp.total);
  const processed = Number(pp.processed);
  // A reading with no total tells us nothing and would divide by zero downstream.
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(processed)) return null;
  return {
    total,
    processed,
    cache: Number.isFinite(Number(pp.cache)) ? Number(pp.cache) : 0,
    timeMs: Number.isFinite(Number(pp.time_ms)) ? Number(pp.time_ms) : 0,
  };
}

/**
 * Scan a raw SSE byte stream for `prompt_progress` readings.
 *
 * Deliberately tolerant: this runs on a COPY of a response the SDK is also
 * consuming, so anything it fails to understand must be skipped silently. A
 * malformed line, a non-llama.cpp server that never sends progress, or a body
 * that isn't SSE at all must all end in "no progress reported" — never an error
 * that could surface as a failed turn. The user's actual request is unaffected
 * by anything that happens in here.
 */
export async function scanPrefillProgress(
  body: ReadableStream<Uint8Array>,
  onProgress: (p: PrefillProgress) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // SSE frames are newline-delimited; keep the trailing partial line.
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const progress = parseProgressChunk(JSON.parse(payload));
          if (progress) onProgress(progress);
        } catch {
          // Not JSON, or not a shape we know — skip. See tolerance note above.
        }
      }
    }
  } catch {
    // The stream aborted (user interrupt, network drop). The SDK's branch owns
    // reporting that; ours just stops.
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}

/**
 * Wrap a fetch so llama.cpp prefill progress is reported as it streams.
 *
 * Returns a fetch with identical semantics: the caller receives a response whose
 * body is untouched. We only ever read a TEE'd copy.
 */
export function withPrefillProgress(
  base: typeof fetch,
  onProgress: (p: PrefillProgress) => void,
): typeof fetch {
  return async (input: any, init?: any) => {
    const res = await base(input, init);
    // Non-streaming replies (errors, /models) have nothing to watch.
    if (!res.body || !res.ok) return res;
    const [forSdk, forUs] = res.body.tee();
    // Fire-and-forget: the SDK's branch must never wait on ours.
    void scanPrefillProgress(forUs, onProgress);
    return new Response(forSdk, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  };
}
