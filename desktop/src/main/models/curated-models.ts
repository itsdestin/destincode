// The shipped curated model list (spec §4.1). A same-shaped copy lives at the
// youcoded repo root as curated-models.json and is fetched at runtime
// (announcements pattern) so recommendations can update WITHOUT an app
// release; this in-app copy is the offline/fetch-failure fallback. unsloth-first
// (spec §0 decision 3). The list is RECOMMENDATIONS only — any HF GGUF is
// runnable via the "Add from Hugging Face" flow (Amendment C).
import type { CuratedModel } from '../../shared/model-manager-types';

export const CURATED_SCHEMA_VERSION = 1;

export const SHIPPED_CURATED: CuratedModel[] = [
  // ---- small (runs on ~8GB machines) ----
  { id: 'qwen35-2b', label: 'Qwen3.5 2B', tier: 'small', hfRepo: 'unsloth/Qwen3.5-2B-GGUF', quantDefault: 'UD-Q4_K_XL', notes: 'Tiny and fast — great on low-memory machines.' },
  { id: 'qwen35-4b', label: 'Qwen3.5 4B', tier: 'small', hfRepo: 'unsloth/Qwen3.5-4B-GGUF', quantDefault: 'UD-Q4_K_XL', notes: 'Fast all-rounder for chat and quick questions.' },
  { id: 'gemma4-e4b', label: 'Gemma 4 E4B', tier: 'small', hfRepo: 'unsloth/gemma-4-E4B-it-GGUF', quantDefault: 'UD-Q4_K_XL', notes: 'Strong small model from Google.' },
  // ---- everyday (runs on ~16-32GB machines) ----
  { id: 'qwen35-9b', label: 'Qwen3.5 9B', tier: 'everyday', hfRepo: 'unsloth/Qwen3.5-9B-GGUF', quantDefault: 'UD-Q4_K_XL', notes: 'Noticeably smarter than the small tier; still light.' },
  { id: 'gemma4-12b', label: 'Gemma 4 12B', tier: 'everyday', hfRepo: 'unsloth/gemma-4-12b-it-GGUF', quantDefault: 'UD-Q4_K_XL', notes: 'Capable Google model with vision.' },
  { id: 'gpt-oss-20b', label: 'GPT-OSS 20B', tier: 'everyday', hfRepo: 'unsloth/gpt-oss-20b-GGUF', quantDefault: 'UD-Q4_K_XL', notes: 'OpenAI open-weights model — great general assistant.' },
  { id: 'gemma4-26b-a4b', label: 'Gemma 4 26B-A4B', tier: 'everyday', hfRepo: 'unsloth/gemma-4-26B-A4B-it-GGUF', quantDefault: 'UD-Q4_K_XL', notes: 'Mixture-of-experts — 26B quality at roughly 4B speed.' },
  { id: 'qwen36-27b', label: 'Qwen3.6 27B', tier: 'everyday', hfRepo: 'unsloth/Qwen3.6-27B-GGUF', quantDefault: 'UD-Q4_K_XL', notes: 'Newest Qwen — top everyday pick if it fits.' },
  // ---- large (runs on 32GB+ / workstations) ----
  { id: 'qwen35-35b-a3b', label: 'Qwen3.5 35B-A3B', tier: 'large', hfRepo: 'unsloth/Qwen3.5-35B-A3B-GGUF', quantDefault: 'UD-Q4_K_XL', notes: 'Mixture-of-experts — big-model quality on a strong machine.' },
  { id: 'gpt-oss-120b', label: 'GPT-OSS 120B', tier: 'large', hfRepo: 'unsloth/gpt-oss-120b-GGUF', quantDefault: 'UD-Q4_K_XL', notes: 'OpenAI open-weights flagship — needs a workstation.' },
  { id: 'qwen35-122b-a10b', label: 'Qwen3.5 122B-A10B', tier: 'large', hfRepo: 'unsloth/Qwen3.5-122B-A10B-GGUF', quantDefault: 'UD-Q4_K_XL', notes: 'Frontier open model — for high-memory machines.' },
];
