// Mirrors RuntimeBinding.tsx's local ProviderRow / CatalogRow. Those are the
// shapes the runtime selector actually reads; `providers.list()` and
// `.catalog()` are typed `Promise<any[]>` in useIpc.ts, so the compiler cannot
// check this pair — keep them in step with RuntimeBinding.tsx by hand.
export interface ProviderRow { id: string; type: string; label: string; ready: boolean }
export interface CatalogRow { id: string; providerId: string; label: string }

export function providers(): ProviderRow[] {
  return [
    { id: 'pv-openrouter', type: 'openrouter', label: 'OpenRouter', ready: true },
    { id: 'local', type: 'local-engine', label: 'Local Models', ready: true },
    // Deliberately not ready: the runtime selector has a distinct disabled row
    // treatment, and a fixture where everything is ready never shows it.
    { id: 'pv-ollama', type: 'openai-compatible', label: 'Ollama', ready: false },
  ];
}

export function catalog(): CatalogRow[] {
  return [
    { id: 'anthropic/claude-sonnet-4-6', providerId: 'pv-openrouter', label: 'Claude Sonnet 4.6' },
    { id: 'openai/gpt-5', providerId: 'pv-openrouter', label: 'GPT-5' },
    { id: 'x-ai/grok-4', providerId: 'pv-openrouter', label: 'Grok 4' },  // site row-1 skit switches to it
    // Promo (model beat): two DeepSeek rows so the favourites list opens with
    // four different companies' models. Names + provider only — no prices,
    // costs or "free" tags anywhere in the picker (Destin: nothing faked there).
    { id: 'deepseek/deepseek-v3.2', providerId: 'pv-openrouter', label: 'DeepSeek V3.2' },
    { id: 'deepseek/deepseek-r1', providerId: 'pv-openrouter', label: 'DeepSeek R1' },
    { id: 'qwen2.5-coder:14b', providerId: 'local', label: 'Qwen2.5 Coder 14B' },
    { id: 'llama3.1:8b', providerId: 'local', label: 'Llama 3.1 8B' },
  ];
}
