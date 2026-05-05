import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OllamaDetector } from '../src/main/ollama-detector';

describe('OllamaDetector', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let detector: OllamaDetector;

  beforeEach(() => {
    fetchMock = vi.fn();
    detector = new OllamaDetector('http://localhost:11434', fetchMock as any);
  });

  it('isReachable() returns true when /api/version 200s', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ version: '0.5.0' }) });
    expect(await detector.isReachable()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:11434/api/version',
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('isReachable() returns false on network error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await detector.isReachable()).toBe(false);
  });

  it('isReachable() returns false on non-2xx', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, json: async () => ({}) });
    expect(await detector.isReachable()).toBe(false);
  });

  it('listModels() returns model names from /api/tags', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        models: [
          { name: 'qwen3:8b', size: 4_900_000_000, modified_at: '2026-05-01T00:00:00Z' },
          { name: 'llama3.2:3b', size: 2_000_000_000, modified_at: '2026-04-15T00:00:00Z' },
        ],
      }),
    });
    expect(await detector.listModels()).toEqual([
      { name: 'qwen3:8b', sizeBytes: 4_900_000_000, modifiedAt: '2026-05-01T00:00:00Z' },
      { name: 'llama3.2:3b', sizeBytes: 2_000_000_000, modifiedAt: '2026-04-15T00:00:00Z' },
    ]);
  });

  it('listModels() returns [] when Ollama is unreachable', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    expect(await detector.listModels()).toEqual([]);
  });

  it('pullModel() streams progress events from NDJSON response body', async () => {
    const chunks = [
      '{"status":"pulling manifest"}\n',
      '{"status":"downloading","completed":1024,"total":4096}\n',
      '{"status":"downloading","completed":4096,"total":4096}\n',
      '{"status":"success"}\n',
    ];
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(c));
        controller.close();
      },
    });
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, body: stream });

    const events: any[] = [];
    await detector.pullModel('qwen3:8b', (ev) => events.push(ev));
    expect(events).toEqual([
      { kind: 'status', status: 'pulling manifest' },
      { kind: 'progress', status: 'downloading', completedBytes: 1024, totalBytes: 4096 },
      { kind: 'progress', status: 'downloading', completedBytes: 4096, totalBytes: 4096 },
      { kind: 'done' },
    ]);
  });
});
