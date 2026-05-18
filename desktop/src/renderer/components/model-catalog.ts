// Curated catalog of recommended Ollama models for the Local Models settings
// panel, plus per-model reference detail (the (i) popup + Compare tab).
//
// Sizes are approximate Q4-quantized GGUF sizes (Ollama's default tag).
// Sized for ~8 GB VRAM (most modern laptop GPUs and entry desktop GPUs);
// models marked "tight" spill to system RAM on cards smaller than ~10 GB.
// Custom names go through the free-text input below the catalog so power
// users can pull anything from https://ollama.com/library.
//
// Catalog ordering is "default first, then alternatives, then niche/warned."
// The first entry is the recommended new-session default.
//
// Catalog only includes tool-capable models — OpenCode sends tool definitions
// on every prompt, so non-tool-capable models fail. Excluded: gemma3 (no
// tools), phi4-mini (Phi family weak on tools), llama3.2:3b (too small for
// reliable tool use), qwen2.5-coder (tool calling broken upstream — QwenLM
// #180), deepseek-r1 (tool calling fails — confirmed by the 2026-05-18 probe).
//
// Capability facts below were verified by the test-ollama/probe-model.mjs
// capability probe (2026-05-18) plus the model research pass. The probe
// confirmed: gemma4 has real working vision; qwen3.5 image input crashes the
// Ollama runner; qwen2.5-coder + deepseek-r1 tool calling is broken.

export interface OllamaCatalogEntry {
  /** Ollama model id, e.g. "qwen3:8b". Also the MODEL_DETAILS key. */
  name: string;
  /** Approximate on-disk size of the Q4 GGUF. */
  sizeLabel: string;
  /** One-line summary shown on the catalog row. */
  blurb: string;
  /** When set, the catalog row shows a yellow ⚠ chip with this text as the
   *  tooltip — known issues a user should weigh before installing. */
  warning?: string;
}

export const OLLAMA_MODEL_CATALOG: OllamaCatalogEntry[] = [
  // — Recommended default —
  { name: 'qwen3:8b',   sizeLabel: '4.9 GB', blurb: 'Strong tools, Apache 2.0, 32K context — recommended default' },

  // — Other strong options —
  { name: 'gemma4:e2b', sizeLabel: '7.2 GB', blurb: 'Gemma 4 — multimodal (text/image/audio), 128K context, thinking on/off' },
  { name: 'gemma4:e4b', sizeLabel: '9.6 GB', blurb: 'Larger Gemma 4 — better quality, tight on 8 GB VRAM' },

  // — Older general-purpose baseline —
  { name: 'qwen2.5:7b', sizeLabel: '4.4 GB', blurb: 'Older Qwen 2.5 — stable, reliable tool use, no thinking' },

  // — Larger context, known-flaky on Ollama —
  { name: 'qwen3.5:9b', sizeLabel: '6.6 GB', blurb: 'Qwen 3.5 — 256K context, multimodal',
    warning: 'Five open Ollama bugs against this exact model — may crash, hang, or leak tool-call text. Try qwen3:8b first.' },
  { name: 'qwen3.5:4b', sizeLabel: '3.4 GB', blurb: 'Smaller Qwen 3.5 — 256K context, fast',
    warning: 'Same family as qwen3.5:9b; inherits its Ollama bug surface, though smaller scale may mean fewer crashes.' },
];

/** Per-model reference detail. Powers the (i) popup and the Compare tab.
 *  Tone: factual and terse — no marketing. */
export interface ModelDetails {
  /** 1-2 sentence summary. */
  description: string;
  developer: string;
  released: string;
  parameters: string;
  contextWindow: string;
  /** Structured so the Compare tab can derive a Vision column and the popup
   *  can render a readable list. e.g. ['text'], ['text','image','audio']. */
  modalities: string[];
  /** 'On / Off' for binary-thinking models, 'None' otherwise. */
  thinking: string;
  /** Tool-calling reliability. Catalog only ships 'Reliable' models. */
  toolUse: string;
  strengths: string[];
  weaknesses: string[];
  /** One-line use-case summary. */
  bestFor: string;
  /** One-line hardware note (VRAM / RAM). */
  hardware: string;
  license: string;
}

export const MODEL_DETAILS: Record<string, ModelDetails> = {
  'qwen3:8b': {
    description:
      "Alibaba's general-purpose 8B model with on/off thinking control. The default for new local sessions — the strongest tool caller in the catalog and the lightest footprint of the recommended options.",
    developer: 'Alibaba (Qwen team)',
    released: 'April 2025',
    parameters: '8B',
    contextWindow: '32K tokens',
    modalities: ['text'],
    thinking: 'On / Off',
    toolUse: 'Reliable',
    strengths: [
      'Reliable tool calling — verified clean by the capability probe',
      'On/off thinking control for reasoning-heavy prompts',
      'Small footprint — fits 6 GB VRAM with headroom',
      'Apache 2.0 license — no usage restrictions',
    ],
    weaknesses: [
      '32K context is modest by 2026 standards',
      'Text only — cannot read images or screenshots',
      'Older training cutoff than Qwen 3.5',
    ],
    bestFor: 'Daily-driver coding chat, tool-heavy agent work, general Q&A.',
    hardware: '6 GB VRAM comfortable; usable CPU-only on a modern machine.',
    license: 'Apache 2.0',
  },

  'gemma4:e2b': {
    description:
      "Google's compact Gemma 4 — multimodal (text, image, audio) and the most robust model in the catalog. Per-Layer Embeddings keep its runtime memory footprint far below its on-disk size.",
    developer: 'Google DeepMind',
    released: 'April 2026',
    parameters: '~2B effective (Per-Layer Embeddings)',
    contextWindow: '128K tokens',
    modalities: ['text', 'image', 'audio'],
    thinking: 'On / Off',
    toolUse: 'Reliable',
    strengths: [
      'Only catalog model with verified working vision (probe described a test image)',
      'Accepts audio input as well as images',
      'Handled every capability probe cleanly, including reasoning',
      'Small runtime memory footprint despite the 7 GB download',
    ],
    weaknesses: [
      'Gemma license is a custom Google license, not OSI-approved',
      'Thinking is on/off only — depth does not scale',
      'Newer architecture — occasional rough edges in Ollama integration',
    ],
    bestFor: 'Image- and text-aware tasks, reasoning on modest hardware, the most reliable all-rounder.',
    hardware: '4 GB VRAM works; 6 GB comfortable. ~7 GB on disk.',
    license: 'Gemma Terms (custom)',
  },

  'gemma4:e4b': {
    description:
      'The larger Gemma 4 variant — the same multimodal and reasoning capabilities as e2b at higher answer quality. The strongest Gemma 4 that fits on a 12 GB consumer GPU.',
    developer: 'Google DeepMind',
    released: 'April 2026',
    parameters: '~4B effective (Per-Layer Embeddings)',
    contextWindow: '128K tokens',
    modalities: ['text', 'image', 'audio'],
    thinking: 'On / Off',
    toolUse: 'Reliable',
    strengths: [
      'Higher answer quality than e2b at a similar runtime memory profile',
      'Multimodal — image and audio input',
      'Strong reasoning in thinking mode',
    ],
    weaknesses: [
      '9.6 GB on disk — tight on 8 GB VRAM, expect partial CPU offload',
      'Slower than e2b and qwen3:8b',
      'Same custom Gemma license as e2b',
    ],
    bestFor: 'Users with 12+ GB VRAM who want Gemma multimodal + reasoning at a serious quality tier.',
    hardware: '8 GB VRAM tight (CPU offload); 12 GB comfortable.',
    license: 'Gemma Terms (custom)',
  },

  'qwen2.5:7b': {
    description:
      "Alibaba's previous-generation general-purpose model. No thinking mode, but stable, fast, and well-tested with Ollama and OpenCode — a no-surprises baseline.",
    developer: 'Alibaba (Qwen team)',
    released: 'September 2024',
    parameters: '7B',
    contextWindow: '32K tokens',
    modalities: ['text'],
    thinking: 'None',
    toolUse: 'Reliable',
    strengths: [
      'Reliable tool calling — community baseline for tool-capable 7B',
      'Fast — no thinking overhead',
      'Mature and stable with Ollama and OpenCode',
    ],
    weaknesses: [
      'No thinking mode',
      '32K context is small for 2026',
      'Outclassed on reasoning-heavy tasks by Qwen 3',
    ],
    bestFor: 'Tool-heavy workflows where speed matters, simple coding tasks, a predictable baseline.',
    hardware: '6 GB VRAM comfortable; fast on CPU.',
    license: 'Apache 2.0',
  },

  'qwen3.5:9b': {
    description:
      "Alibaba's newest model — 256K context and multimodal input. The most capable model in the catalog when it works, but Ollama has several open bugs against this specific model that can cause crashes and hangs.",
    developer: 'Alibaba (Qwen team)',
    released: 'Early 2026',
    parameters: '~9B',
    contextWindow: '256K tokens',
    modalities: ['text', 'image'],
    thinking: 'None',
    toolUse: 'Reliable',
    strengths: [
      'Massive 256K context — paste an entire codebase',
      'Newest training data in the catalog',
      'Reliable tool calling when the model is stable',
    ],
    weaknesses: [
      'Five-plus open Ollama bugs against this exact model — runner crashes and hangs',
      'Image input crashed the Ollama runner in our capability probe',
      'Thinking is gated off until the upstream bugs settle',
      "Won't fit alongside other apps on an 8 GB VRAM card",
    ],
    bestFor: 'Long-context tasks when you accept the stability risk; users on 12+ GB VRAM.',
    hardware: '8 GB VRAM minimum, 12 GB comfortable.',
    license: 'Apache 2.0',
  },

  'qwen3.5:4b': {
    description:
      'The smaller Qwen 3.5 — the same 256K context at half the size and faster. Inherits the family’s Ollama bug surface, though the smaller scale may mean fewer crashes.',
    developer: 'Alibaba (Qwen team)',
    released: 'Early 2026',
    parameters: '~4B',
    contextWindow: '256K tokens',
    modalities: ['text', 'image'],
    thinking: 'None',
    toolUse: 'Reliable',
    strengths: [
      '256K context at a small, fast size',
      'Reliable tool calling',
      '3.4 GB — fits comfortably almost anywhere',
    ],
    weaknesses: [
      'Same Ollama bug family as 9b — image input crashed our probe',
      'Quality gap versus 9b on complex reasoning',
      'Thinking is gated off until the upstream bugs settle',
    ],
    bestFor: 'Long-context summarization on modest hardware, quick tasks where speed beats depth.',
    hardware: '4 GB VRAM comfortable; a strong CPU-fallback candidate.',
    license: 'Apache 2.0',
  },
};

/** Whether a model accepts image input — derived from its modality list.
 *  Used by the Compare tab's Vision column. */
export function hasVision(details: ModelDetails): boolean {
  return details.modalities.includes('image');
}
