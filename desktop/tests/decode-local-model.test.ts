import { describe, it, expect } from 'vitest';
import { decodeLocalModel } from '../src/renderer/components/ModelPickerPopup';

describe('decodeLocalModel', () => {
  it('returns base + none for a bare Ollama model id', () => {
    expect(decodeLocalModel('qwen3:8b')).toEqual({ baseModel: 'qwen3:8b', effort: 'none' });
  });

  it('decodes the @on suffix to base + on', () => {
    expect(decodeLocalModel('qwen3:8b@on')).toEqual({ baseModel: 'qwen3:8b', effort: 'on' });
    expect(decodeLocalModel('gemma4:e2b@on')).toEqual({ baseModel: 'gemma4:e2b', effort: 'on' });
  });

  it('maps legacy graduated suffixes (@low/@medium/@high) to on for display continuity', () => {
    // Sessions created before the 2026-05-12 binary collapse may still carry
    // graduated suffixes. They decode to `on` rather than falling through to
    // Off, so an old session's chip stays sensible.
    expect(decodeLocalModel('qwen3:8b@low')).toEqual({ baseModel: 'qwen3:8b', effort: 'on' });
    expect(decodeLocalModel('qwen3:8b@medium')).toEqual({ baseModel: 'qwen3:8b', effort: 'on' });
    expect(decodeLocalModel('qwen3:8b@high')).toEqual({ baseModel: 'qwen3:8b', effort: 'on' });
  });

  it('handles model names containing colons (Ollama tag separator) without confusion', () => {
    // Ollama uses `:` for the size tag — decoder must split on `@`, not `:`,
    // so a bare `model:tag` stays intact and a `model:tag@on` splits cleanly.
    expect(decodeLocalModel('llama3.1:70b')).toEqual({ baseModel: 'llama3.1:70b', effort: 'none' });
    expect(decodeLocalModel('llama3.1:70b@on')).toEqual({ baseModel: 'llama3.1:70b', effort: 'on' });
  });

  it('falls back to none for null/undefined/empty', () => {
    expect(decodeLocalModel(null)).toEqual({ baseModel: '', effort: 'none' });
    expect(decodeLocalModel(undefined)).toEqual({ baseModel: '', effort: 'none' });
    expect(decodeLocalModel('')).toEqual({ baseModel: '', effort: 'none' });
  });

  it('treats unrecognized suffix as part of the base model (defensive)', () => {
    // A user who hand-edits opencode.json with a bogus variant shouldn't
    // crash the chip. Treating unknown suffixes as opaque keeps the chip
    // showing whatever name the daemon will accept.
    expect(decodeLocalModel('qwen3:8b@experimental')).toEqual({
      baseModel: 'qwen3:8b@experimental',
      effort: 'none',
    });
  });
});
