/* openrouterCatalog — curated OpenRouter model catalog for the managed (Pro) backend.

   These ids are OpenRouter ids (e.g. 'anthropic/claude-sonnet-5'), distinct from
   the native Anthropic ids used by the CLI/BYOK path (e.g. 'claude-sonnet-5').
   Keep them separate — the Rust/CLI path must never receive OpenRouter ids.
*/

export type ModelTier = 'fast' | 'balanced' | 'max' | 'free';
export type ReasoningEffort = 'low' | 'medium' | 'high' | 'max';

export interface OpenRouterModel {
  /** Full OpenRouter routing id, e.g. 'anthropic/claude-sonnet-5' */
  id: string;
  /** Human-readable display label */
  label: string;
  /** Display name of the underlying provider */
  provider: string;
  /** Capability tier for UI grouping */
  tier: ModelTier;
  /** Whether this model supports reasoning.effort */
  reasoning: boolean;
  /** Whether the model supports the 'max' reasoning effort (beyond 'high'). */
  maxEffort?: boolean;
  /** USD per 1M input tokens */
  priceIn: number;
  /** USD per 1M output tokens */
  priceOut: number;
  /** Max output tokens for this model */
  maxTokens: number;
  /** Whether this model supports the web search plugin */
  webSearch: boolean;
  /** Whether this is a free model (zero cost) */
  isFree: boolean;
}

/** OpenRouter id of the free rail's default model. Retired aliases map here. */
export const FREE_OPENROUTER_MODEL_ID = 'z-ai/glm-5.2:free';

const RETIRED_OPENROUTER_IDS: ReadonlySet<string> = new Set([
  'stealth/ox-alpha',
  'z-ai/glm-5.3-flash',
]);

/** Rewrite a persisted / in-flight id that OpenRouter no longer serves. */
export function migrateRetiredOpenRouterId(id: string): string {
  return RETIRED_OPENROUTER_IDS.has(id) ? FREE_OPENROUTER_MODEL_ID : id;
}

// Provider groups ordered: Z.ai (free), Anthropic, OpenAI, Google, xAI, DeepSeek, Meta
export const OPENROUTER_MODELS: readonly OpenRouterModel[] = [
  // ── Free tier — genuine OpenRouter `:free` models (no credits needed) ──
  // Any authenticated user can call these: the ai-proxy serves them with a
  // zero credit reservation and zero charge (see pricing.ts's isFree path),
  // and every client gate below treats them as always-ready. The privacy
  // trade-off (upstream provider may train on submitted data) is surfaced by
  // FreeModelPrivacyNotice at the point of selection.
  {
    id: FREE_OPENROUTER_MODEL_ID,
    label: 'GLM 5.2 (free)',
    provider: 'Z.ai',
    tier: 'free',
    reasoning: true,
    priceIn: 0,
    priceOut: 0,
    maxTokens: 8192,
    webSearch: true,
    isFree: true,
  },
  {
    id: 'google/gemma-4-31b-it:free',
    label: 'Gemma 4 31B (free)',
    provider: 'Google',
    tier: 'free',
    reasoning: false,
    priceIn: 0,
    priceOut: 0,
    maxTokens: 8192,
    webSearch: false,
    isFree: true,
  },
  {
    id: 'minimax/minimax-m3:free',
    label: 'MiniMax M3 (free)',
    provider: 'MiniMax',
    tier: 'free',
    reasoning: true,
    priceIn: 0,
    priceOut: 0,
    maxTokens: 8192,
    webSearch: false,
    isFree: true,
  },
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    label: 'Nemotron 3 Ultra (free)',
    provider: 'NVIDIA',
    tier: 'free',
    reasoning: true,
    priceIn: 0,
    priceOut: 0,
    maxTokens: 8192,
    webSearch: false,
    isFree: true,
  },
  {
    id: 'poolside/laguna-s-2.1:free',
    label: 'Laguna S 2.1 (free)',
    provider: 'Poolside',
    tier: 'free',
    reasoning: false,
    priceIn: 0,
    priceOut: 0,
    maxTokens: 8192,
    webSearch: false,
    isFree: true,
  },
  {
    id: 'thinkingmachines/inkling:free',
    label: 'Inkling (free)',
    provider: 'Thinking Machines',
    tier: 'free',
    reasoning: false,
    priceIn: 0,
    priceOut: 0,
    maxTokens: 8192,
    webSearch: false,
    isFree: true,
  },
  {
    id: 'cohere/north-mini-code:free',
    label: 'North Mini Code (free)',
    provider: 'Cohere',
    tier: 'free',
    reasoning: false,
    priceIn: 0,
    priceOut: 0,
    maxTokens: 8192,
    webSearch: false,
    isFree: true,
  },
  // ── Z.ai — PAID (the bare `z-ai/glm-5.2` route requires credits; the free
  // route is the `:free` variant above) ───────────────────────────────
  {
    id: 'z-ai/glm-5.2',
    label: 'GLM 5.2',
    provider: 'Z.ai',
    tier: 'balanced',
    reasoning: true,
    priceIn: 0.15,
    priceOut: 0.6,
    maxTokens: 32768,
    webSearch: true,
    isFree: false,
  },
  // ── Anthropic ─────────────────────────────────────────────────────
  {
    id: 'anthropic/claude-haiku-4.5',
    label: 'Claude Haiku 4.5',
    provider: 'Anthropic',
    tier: 'fast',
    reasoning: true,
    priceIn: 1,
    priceOut: 5,
    maxTokens: 16384,
    webSearch: true,
    isFree: false,
  },
  {
    id: 'anthropic/claude-sonnet-5',
    label: 'Claude Sonnet 5',
    provider: 'Anthropic',
    tier: 'balanced',
    reasoning: true,
    maxEffort: true,
    priceIn: 2,
    priceOut: 10,
    maxTokens: 32768,
    webSearch: true,
    isFree: false,
  },
  {
    id: 'anthropic/claude-opus-5',
    label: 'Claude Opus 5',
    provider: 'Anthropic',
    tier: 'max',
    reasoning: true,
    maxEffort: true,
    priceIn: 5,
    priceOut: 25,
    maxTokens: 65536,
    webSearch: true,
    isFree: false,
  },
  {
    id: 'anthropic/claude-fable-5',
    label: 'Claude Fable 5',
    provider: 'Anthropic',
    tier: 'max',
    reasoning: true,
    maxEffort: true,
    priceIn: 10,
    priceOut: 50,
    maxTokens: 65536,
    webSearch: true,
    isFree: false,
  },
  // ── OpenAI ────────────────────────────────────────────────────────
  {
    id: 'openai/gpt-5.6-luna',
    label: 'GPT-5.6 Luna',
    provider: 'OpenAI',
    tier: 'fast',
    reasoning: true,
    priceIn: 0.1,
    priceOut: 0.6,
    maxTokens: 16384,
    webSearch: true,
    isFree: false,
  },
  {
    id: 'openai/gpt-5.6-terra',
    label: 'GPT-5.6 Terra',
    provider: 'OpenAI',
    tier: 'balanced',
    reasoning: true,
    maxEffort: true,
    priceIn: 1,
    priceOut: 6,
    maxTokens: 32768,
    webSearch: true,
    isFree: false,
  },
  {
    id: 'openai/gpt-5.6-sol',
    label: 'GPT-5.6 Sol',
    provider: 'OpenAI',
    tier: 'max',
    reasoning: true,
    maxEffort: true,
    priceIn: 5,
    priceOut: 30,
    maxTokens: 65536,
    webSearch: true,
    isFree: false,
  },
  // ── Google ────────────────────────────────────────────────────────
  {
    id: 'google/gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash Lite',
    provider: 'Google',
    tier: 'fast',
    reasoning: true,
    priceIn: 0.3,
    priceOut: 2.5,
    maxTokens: 16384,
    webSearch: true,
    isFree: false,
  },
  {
    id: 'google/gemini-3.6-flash',
    label: 'Gemini 3.6 Flash',
    provider: 'Google',
    tier: 'balanced',
    reasoning: true,
    maxEffort: true,
    priceIn: 1.5,
    priceOut: 7.5,
    maxTokens: 32768,
    webSearch: true,
    isFree: false,
  },
  // ── xAI ───────────────────────────────────────────────────────────
  {
    id: 'x-ai/grok-4.3',
    label: 'Grok 4.3',
    provider: 'xAI',
    tier: 'balanced',
    reasoning: true,
    priceIn: 1.25,
    priceOut: 2.5,
    maxTokens: 32768,
    webSearch: true,
    isFree: false,
  },
  {
    id: 'x-ai/grok-4.5',
    label: 'Grok 4.5',
    provider: 'xAI',
    tier: 'balanced',
    reasoning: true,
    maxEffort: true,
    priceIn: 2,
    priceOut: 6,
    maxTokens: 32768,
    webSearch: true,
    isFree: false,
  },
  // ── DeepSeek ──────────────────────────────────────────────────────
  {
    id: 'deepseek/deepseek-v4-flash',
    label: 'DeepSeek V4 Flash',
    provider: 'DeepSeek',
    tier: 'fast',
    reasoning: true,
    priceIn: 0.14,
    priceOut: 0.28,
    maxTokens: 16384,
    webSearch: true,
    isFree: false,
  },
  {
    id: 'deepseek/deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    provider: 'DeepSeek',
    tier: 'fast',
    reasoning: true,
    priceIn: 0.435,
    priceOut: 0.87,
    maxTokens: 16384,
    webSearch: true,
    isFree: false,
  },
  // ── Meta ──────────────────────────────────────────────────────────
  {
    id: 'meta-llama/llama-4-maverick',
    label: 'Llama 4 Maverick',
    provider: 'Meta',
    tier: 'fast',
    reasoning: false,
    priceIn: 0.2,
    priceOut: 0.8,
    maxTokens: 16384,
    webSearch: true,
    isFree: false,
  },
  // ── Moonshot ──────────────────────────────────────────────────────
  {
    id: 'moonshotai/kimi-k2.7-code',
    label: 'Kimi K2.7 Code',
    provider: 'Moonshot',
    tier: 'fast',
    reasoning: true,
    priceIn: 0.7,
    priceOut: 3.5,
    maxTokens: 16384,
    webSearch: true,
    isFree: false,
  },
  {
    id: 'moonshotai/kimi-k3',
    label: 'Kimi K3',
    provider: 'Moonshot',
    tier: 'max',
    reasoning: true,
    maxEffort: true,
    priceIn: 3,
    priceOut: 15,
    maxTokens: 65536,
    webSearch: true,
    isFree: false,
  },
  // ── Qwen ──────────────────────────────────────────────────────────
  {
    id: 'qwen/qwen3.7-flash',
    label: 'Qwen3.7 Flash',
    provider: 'Qwen',
    tier: 'fast',
    reasoning: true,
    priceIn: 0.03,
    priceOut: 0.13,
    maxTokens: 16384,
    webSearch: true,
    isFree: false,
  },
  {
    id: 'qwen/qwen3.8-max',
    label: 'Qwen3.8 Max',
    provider: 'Qwen',
    tier: 'balanced',
    reasoning: true,
    maxEffort: true,
    priceIn: 2,
    priceOut: 6,
    maxTokens: 32768,
    webSearch: true,
    isFree: false,
  },
  // ── Mistral ───────────────────────────────────────────────────────
  {
    id: 'mistralai/mistral-medium-3-5',
    label: 'Mistral Medium 3.5',
    provider: 'Mistral',
    tier: 'balanced',
    reasoning: true,
    priceIn: 1.5,
    priceOut: 7.5,
    maxTokens: 32768,
    webSearch: true,
    isFree: false,
  },
] as const;

/** Default OpenRouter model id used when the Pro user has not selected one yet. */
export const DEFAULT_OPENROUTER_MODEL_ID = 'anthropic/claude-sonnet-5';

/** Catalog grouped by provider display name. */
export const OPENROUTER_MODELS_BY_PROVIDER: Readonly<Record<string, OpenRouterModel[]>> =
  OPENROUTER_MODELS.reduce<Record<string, OpenRouterModel[]>>((acc, model) => {
    const group = acc[model.provider] ?? [];
    return { ...acc, [model.provider]: [...group, model] };
  }, {});

/** Look up a model by its full OpenRouter id. Returns undefined if not found. */
export function findOpenRouterModel(id: string): OpenRouterModel | undefined {
  return OPENROUTER_MODELS.find(m => m.id === id);
}

/**
 * True when the given OpenRouter id is a FREE model — usable by ANY
 * authenticated user without a Lazy Pro subscription (the ai-proxy serves
 * free models with zero reservation and zero charge). Undefined/unknown
 * ids are never free. Every client-side gate that would otherwise demand
 * an active Pro plan (picker groups, engine readiness, mission dispatch)
 * consults this so the free tier stays genuinely free end-to-end.
 */
export function isOpenRouterFreeModel(id: string | undefined): boolean {
  return !!id && (findOpenRouterModel(id)?.isFree === true);
}

/**
 * Returns a cost badge based on the model's output price per 1M tokens.
 *  - '$'   : priceOut < 2
 *  - '$$'  : priceOut < 20
 *  - '$$$' : priceOut >= 20
 */
export function priceBadge(m: OpenRouterModel): '$' | '$$' | '$$$' | 'FREE' {
  if (m.isFree) return 'FREE';
  if (m.priceOut < 2) return '$';
  if (m.priceOut < 20) return '$$';
  return '$$$';
}
