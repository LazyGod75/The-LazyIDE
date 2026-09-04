/* Model registry — selectable models grouped by provider.

   Two namespaces coexist:
   - Native Anthropic ids (e.g. 'claude-sonnet-5'): used by the CLI/BYOK Rust path.
   - OpenRouter ids (e.g. 'anthropic/claude-sonnet-5'): used by the managed Pro path.
   Never mix them — keep each path consuming its own id format.
*/

import type { ModelInfo } from './types.js';
export {
  OPENROUTER_MODELS,
  OPENROUTER_MODELS_BY_PROVIDER,
  DEFAULT_OPENROUTER_MODEL_ID,
  findOpenRouterModel,
  priceBadge,
} from './openrouterCatalog.js';
export type { OpenRouterModel, ModelTier, ReasoningEffort } from './openrouterCatalog.js';

// ── Native Anthropic ids (CLI / BYOK path only) ────────────────────
// These ids are consumed by anthropicProvider and claudeCodeProvider.
// Do NOT use them with the OpenRouter / managed proxy.
const ANTHROPIC_MODELS: ModelInfo[] = [
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    provider: 'anthropic',
    description: 'Deepest reasoning, complex tasks',
  },
  {
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    provider: 'anthropic',
    description: 'Mythos-class, autonomous long-horizon tasks',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    provider: 'anthropic',
    description: 'Best coding model, orchestration',
  },
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    provider: 'anthropic',
    description: 'Fast, cost-efficient (default)',
  },
];

// ── ALL_MODELS (CLI / BYOK registry — native ids only) ────────────
// The OpenAI and Google placeholder stubs are removed; the Pro path uses
// the OpenRouter catalog directly (see openrouterCatalog.ts).
export const ALL_MODELS: ModelInfo[] = [...ANTHROPIC_MODELS];

export const MODELS_BY_PROVIDER: Record<string, ModelInfo[]> = {
  anthropic: ANTHROPIC_MODELS,
};

// Default model — Haiku for dev/cost efficiency. Resolved by id, NOT array
// index: 'claude-fable-5' was inserted into ANTHROPIC_MODELS (v0.1.7, model
// picker fixes) between Opus and Sonnet, which silently shifted what a
// fixed index pointed at and broke this default (previously
// ANTHROPIC_MODELS[2] — see git history). Resolving by id means a future
// catalog insertion/reorder can never again change the default silently.
const DEFAULT_ANTHROPIC_MODEL_ID = 'claude-haiku-4-5';
export const DEFAULT_MODEL: ModelInfo =
  ANTHROPIC_MODELS.find(m => m.id === DEFAULT_ANTHROPIC_MODEL_ID) ?? ANTHROPIC_MODELS[ANTHROPIC_MODELS.length - 1];

export function findModelById(id: string): ModelInfo | undefined {
  return ALL_MODELS.find(m => m.id === id);
}
