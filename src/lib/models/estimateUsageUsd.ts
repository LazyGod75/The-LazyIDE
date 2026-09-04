/* estimateUsageUsd — per-model estimate when the backend did not settle costUsd.

   Catalog rates come from OPENROUTER_MODELS (same table catalogParity locks
   to ai-proxy). Unknown / CLI-only ids fall back to the historical Haiku
   0.80/4.00 constants — never invent a third price table.
*/

import { OPENROUTER_MODELS } from './openrouterCatalog.js';

/** USD / 1M tokens — only used when the model is not in the catalog. */
export const FALLBACK_PRICE_INPUT_PER_M = 0.80;
export const FALLBACK_PRICE_OUTPUT_PER_M = 4.00;

function normalizeModelKey(model: string): string {
  let key = model.trim().toLowerCase().replace(/_/g, '-');
  key = key.replace(/(\d)-(\d)/g, '$1.$2');
  return key;
}

// eslint-disable-next-line complexity -- rate catalog lookup is inherently branchy
export function catalogRatesFor(model: string): { priceIn: number; priceOut: number } | null {
  const key = normalizeModelKey(model);
  if (!key) return null;

  let exact: (typeof OPENROUTER_MODELS)[number] | undefined;
  let shortFree: (typeof OPENROUTER_MODELS)[number] | undefined;
  let shortPaid: (typeof OPENROUTER_MODELS)[number] | undefined;

  for (const entry of OPENROUTER_MODELS) {
    const id = normalizeModelKey(entry.id);
    if (id === key) {
      exact = entry;
      break;
    }
    const slash = id.lastIndexOf('/');
    const short = slash >= 0 ? id.slice(slash + 1) : id;
    const shortBase = short.replace(/:free$/, '');
    if (short === key || shortBase === key) {
      if (entry.isFree) shortFree ??= entry;
      else shortPaid ??= entry;
    }
  }

  const chosen = exact ?? shortFree ?? shortPaid;
  if (!chosen) return null;

  if (!chosen.isFree) {
    const freeSibling = OPENROUTER_MODELS.find(
      (m) => m.isFree && (normalizeModelKey(m.id) === `${normalizeModelKey(chosen.id)}:free`
        || normalizeModelKey(m.id) === `${key}:free`),
    );
    if (freeSibling) {
      return { priceIn: freeSibling.priceIn, priceOut: freeSibling.priceOut };
    }
  }

  return { priceIn: chosen.priceIn, priceOut: chosen.priceOut };
}

export function estimateUsageUsd(model: string, inputTokens: number, outputTokens: number): number {
  const rates = catalogRatesFor(model) ?? {
    priceIn: FALLBACK_PRICE_INPUT_PER_M,
    priceOut: FALLBACK_PRICE_OUTPUT_PER_M,
  };
  return (inputTokens / 1_000_000) * rates.priceIn + (outputTokens / 1_000_000) * rates.priceOut;
}
