import { describe, it, expect } from 'vitest';
import { OLLAMA_MODEL_CATALOG, MODEL_DETAILS, hasVision } from '../src/renderer/components/model-catalog';

describe('model-catalog', () => {
  it('every catalog model has a MODEL_DETAILS entry', () => {
    // The (i) popup and Compare tab look up MODEL_DETAILS[entry.name]. A
    // catalog model with no details record would render an empty popup row.
    for (const entry of OLLAMA_MODEL_CATALOG) {
      expect(MODEL_DETAILS[entry.name], `missing details for ${entry.name}`).toBeDefined();
    }
  });

  it('every MODEL_DETAILS entry is fully populated', () => {
    // Guards against a half-written record (e.g. an empty strengths array)
    // shipping a blank section in the popup.
    for (const [name, d] of Object.entries(MODEL_DETAILS)) {
      expect(d.description.length, `${name} description`).toBeGreaterThan(20);
      expect(d.developer, `${name} developer`).toBeTruthy();
      expect(d.released, `${name} released`).toBeTruthy();
      expect(d.parameters, `${name} parameters`).toBeTruthy();
      expect(d.contextWindow, `${name} contextWindow`).toBeTruthy();
      expect(d.modalities.length, `${name} modalities`).toBeGreaterThan(0);
      expect(d.thinking, `${name} thinking`).toBeTruthy();
      expect(d.toolUse, `${name} toolUse`).toBeTruthy();
      expect(d.strengths.length, `${name} strengths`).toBeGreaterThanOrEqual(2);
      expect(d.weaknesses.length, `${name} weaknesses`).toBeGreaterThanOrEqual(2);
      expect(d.bestFor, `${name} bestFor`).toBeTruthy();
      expect(d.hardware, `${name} hardware`).toBeTruthy();
      expect(d.license, `${name} license`).toBeTruthy();
    }
  });

  it('modalities always include text', () => {
    // Every LLM is at minimum a text model; the Compare tab derives the
    // Vision column from this list, so a missing 'text' would be a data bug.
    for (const [name, d] of Object.entries(MODEL_DETAILS)) {
      expect(d.modalities, `${name} modalities`).toContain('text');
    }
  });

  it('hasVision reflects the image modality', () => {
    // gemma4 has verified working vision; qwen3 / qwen2.5 are text-only.
    expect(hasVision(MODEL_DETAILS['gemma4:e2b'])).toBe(true);
    expect(hasVision(MODEL_DETAILS['qwen3:8b'])).toBe(false);
    expect(hasVision(MODEL_DETAILS['qwen2.5:7b'])).toBe(false);
  });

  it('the first catalog entry is the recommended default (qwen3:8b)', () => {
    expect(OLLAMA_MODEL_CATALOG[0].name).toBe('qwen3:8b');
  });

  it('dropped models are absent from the catalog', () => {
    // qwen2.5-coder (tools broken upstream) and deepseek-r1 (tools fail per
    // the 2026-05-18 probe) were deliberately removed — guard against a
    // re-add without a fresh capability check.
    const names = OLLAMA_MODEL_CATALOG.map((e) => e.name);
    expect(names).not.toContain('qwen2.5-coder:7b');
    expect(names).not.toContain('deepseek-r1:8b');
  });
});
