/* devinCatalog — the model catalog for the Devin CLI backend.

   Why a separate module: unlike claude (Anthropic ids in registry.ts) and
   codex (no in-app catalog — the CLI manages its own model), the Devin ACP
   backend exposes its REAL, account-specific model list through the
   `config_option_update` session notification — ~80 entries verified live
   (SWE-2/SWE-1.x plus Claude/GPT/Gemini/Grok/DeepSeek/GLM/Kimi families).
   The Rust side (`devin_list_models` in commands/chat.rs) harvests that
   list; this module caches it in localStorage and ships a curated static
   fallback so the picker works before the first successful refresh (or on
   an older CLI).

   Id shape note: devin ids are bare slugs like `swe-2-medium` or
   `claude-opus-5-medium` — no vendor prefix, no ':free' suffix. They never
   collide with ALL_MODELS (Anthropic bare ids are `claude-<name>-<ver>`)
   or with OpenRouter ids (`vendor/model`), which is what makes the
   model-driven routing short-circuits in index.ts / entitlement.ts /
   managerStreamCompletion.ts safe.
*/

import { invoke } from '@tauri-apps/api/core';
import type { ModelInfo } from './types.js';
import { isTauri as isTauriRuntime } from '../platform/index.js';

/** Default model when the Devin backend is selected — SWE-2 Medium is the
 *  free-tier SWE-2 variant in the current catalog. */
export const DEFAULT_DEVIN_MODEL_ID = 'swe-2-medium';

/** Static fallback — a hand-picked subset of the live catalog (verified
 *  against `config_option_update` on devin 3000.x, 2026-09). Deliberately
 *  small: the dynamic refresh replaces this wholesale on success, so this
 *  list only needs to cover the models a user is most likely to pick before
 *  the first refresh lands. */
export const DEVIN_MODELS_FALLBACK: readonly ModelInfo[] = [
  { id: 'swe-2-medium', label: 'SWE-2 Medium', provider: 'devin' },
  { id: 'swe-2-high', label: 'SWE-2 High', provider: 'devin' },
  { id: 'swe-2-max', label: 'SWE-2 Max', provider: 'devin' },
  { id: 'swe-1-7', label: 'SWE-1.7 Max', provider: 'devin' },
  { id: 'swe-1-7-medium', label: 'SWE-1.7 Medium', provider: 'devin' },
  { id: 'swe-1-6', label: 'SWE-1.6', provider: 'devin' },
  { id: 'swe-1-6-fast', label: 'SWE-1.6 Fast', provider: 'devin' },
  { id: 'claude-opus-5-medium', label: 'Claude Opus 5 Medium', provider: 'devin' },
  { id: 'claude-sonnet-5-medium', label: 'Claude Sonnet 5 Medium', provider: 'devin' },
  { id: 'gpt-5-6-sol-medium', label: 'GPT-5.6 Sol Medium', provider: 'devin' },
  { id: 'gemini-3-8-flash-medium', label: 'Gemini 3.8 Flash Medium', provider: 'devin' },
  { id: 'kimi-k2-7', label: 'Kimi K2.7', provider: 'devin' },
];

const LS_DEVIN_CATALOG = 'lazy.devin.catalog';

interface CachedDevinCatalog {
  ts: number;
  models: Array<{ id: string; label: string }>;
}

let liveCatalog: readonly ModelInfo[] | null = null;

function readCachedCatalog(): readonly ModelInfo[] | null {
  if (liveCatalog) return liveCatalog;
  try {
    const raw = localStorage.getItem(LS_DEVIN_CATALOG);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CachedDevinCatalog;
    if (!Array.isArray(parsed.models) || parsed.models.length === 0) return null;
    liveCatalog = parsed.models
      .filter((m) => typeof m.id === 'string' && typeof m.label === 'string')
      .map((m) => ({ id: m.id, label: m.label, provider: 'devin' }));
    return liveCatalog;
  } catch {
    return null;
  }
}

/** The catalog pickers should render: the live ACP-harvested list when a
 *  refresh has succeeded, else the static fallback. */
export function devinModelInfos(): readonly ModelInfo[] {
  return readCachedCatalog() ?? DEVIN_MODELS_FALLBACK;
}

/** True when `id` is a known Devin-backend model. Used by the model-driven
 *  routing short-circuits (index.ts getProvider, entitlement.ts
 *  getEngineReadiness, managerStreamCompletion.ts) so a picked Devin id
 *  always reaches the Devin CLI regardless of the ambient accessMode —
 *  same contract as the free-OpenRouter-model short-circuit. */
export function isDevinModel(id: string | undefined | null): boolean {
  if (!id) return false;
  return devinModelInfos().some((m) => m.id === id);
}

export function findDevinModel(id: string | undefined | null): ModelInfo | undefined {
  if (!id) return undefined;
  return devinModelInfos().find((m) => m.id === id);
}

/** Fetches the live catalog from `devin acp` (one short-lived process,
 *  ~400ms) and caches it in memory + localStorage. Best-effort: failures
 *  (CLI absent, not authenticated, offline) keep the previous catalog —
 *  callers never need to handle the error. Called once at startup from
 *  initProviderMode's detection sweep, and refreshable on demand. */
export async function refreshDevinCatalog(): Promise<readonly ModelInfo[]> {
  if (!isTauriRuntime()) return devinModelInfos();
  try {
    const rows = await invoke<Array<{ id: string; label: string }>>('devin_list_models');
    if (Array.isArray(rows) && rows.length > 0) {
      liveCatalog = rows.map((m) => ({ id: m.id, label: m.label, provider: 'devin' }));
      try {
        localStorage.setItem(LS_DEVIN_CATALOG, JSON.stringify({ ts: Date.now(), models: rows }));
      } catch {
        // localStorage unavailable — memory cache still updated
      }
    }
  } catch {
    // keep previous catalog / fallback
  }
  return devinModelInfos();
}

/** True when the Devin CLI has a stored credential the ACP backend can
 *  authenticate with — drives the "not logged in" affordance in Settings. */
export async function devinAuthStatus(): Promise<boolean> {
  if (!isTauriRuntime()) return false;
  try {
    return await invoke<boolean>('devin_auth_status');
  } catch {
    return false;
  }
}
