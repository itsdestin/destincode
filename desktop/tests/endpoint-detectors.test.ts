import { describe, it, expect, vi } from 'vitest';
import { detectEndpoints } from '../src/main/models/endpoint-detectors';

describe('detectEndpoints', () => {
  it('reports a reachable Ollama with model count and the /v1 baseUrl to add', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url) === 'http://localhost:11434/api/tags') {
        return { ok: true, json: async () => ({ models: [{ name: 'a' }, { name: 'b' }] }) } as any;
      }
      throw new Error('ECONNREFUSED'); // LM Studio not running
    });
    const found = await detectEndpoints(fetchMock as any, []);
    expect(found).toEqual([{
      kind: 'ollama', label: 'Ollama (local)',
      baseUrl: 'http://localhost:11434/v1', modelCount: 2, alreadyAdded: false,
    }]);
  });

  it('reports LM Studio via /v1/models', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url) === 'http://localhost:1234/v1/models') {
        return { ok: true, json: async () => ({ data: [{ id: 'x' }] }) } as any;
      }
      throw new Error('ECONNREFUSED');
    });
    const found = await detectEndpoints(fetchMock as any, []);
    expect(found).toEqual([{
      kind: 'lmstudio', label: 'LM Studio (local)',
      baseUrl: 'http://localhost:1234/v1', modelCount: 1, alreadyAdded: false,
    }]);
  });

  it('marks alreadyAdded when an openai-compatible provider has that baseUrl', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes('11434')) return { ok: true, json: async () => ({ models: [] }) } as any;
      throw new Error('ECONNREFUSED');
    });
    const found = await detectEndpoints(fetchMock as any, [
      { type: 'openai-compatible', baseUrl: 'http://localhost:11434/v1' } as any,
    ]);
    expect(found[0].alreadyAdded).toBe(true);
  });

  it('nothing running → empty list (never throws)', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    expect(await detectEndpoints(fetchMock as any, [])).toEqual([]);
  });
});
