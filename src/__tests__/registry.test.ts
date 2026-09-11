import { describe, it, expect } from 'vitest';
import {
  ALL_MODELS,
  MODELS_BY_PROVIDER,
  DEFAULT_MODEL,
  findModelById,
  OPENROUTER_MODELS,
  OPENROUTER_MODELS_BY_PROVIDER,
  DEFAULT_OPENROUTER_MODEL_ID,
  findOpenRouterModel,
  priceBadge,
} from '../lib/models/registry';
import { FREE_OPENROUTER_MODEL_ID } from '../lib/models/openrouterCatalog';

// ── Native CLI/BYOK registry (Anthropic only) ──────────────────────

describe('registry — native models (CLI / BYOK path)', () => {
  it('ALL_MODELS contains at least 3 models', () => {
    expect(ALL_MODELS.length).toBeGreaterThanOrEqual(3);
  });

  it('ALL_MODELS contains only Anthropic native ids', () => {
    const providers = new Set(ALL_MODELS.map(m => m.provider));
    expect(providers.has('anthropic')).toBe(true);
    // OpenAI and Google are now in the OpenRouter catalog — not in ALL_MODELS.
    expect(providers.has('openai')).toBe(false);
    expect(providers.has('google')).toBe(false);
  });

  it('DEFAULT_MODEL is Haiku (claude-haiku-4-5)', () => {
    expect(DEFAULT_MODEL.id).toBe('claude-haiku-4-5');
    expect(DEFAULT_MODEL.provider).toBe('anthropic');
  });

  it('DEFAULT_MODEL description mentions fast or default', () => {
    const desc = DEFAULT_MODEL.description?.toLowerCase() ?? '';
    expect(desc.includes('fast') || desc.includes('default')).toBe(true);
  });

  // v0.1.7 ("model picker fixes") deliberately added claude-fable-5 to the
  // native catalog (registry.ts) AND the OpenRouter catalog
  // (openrouterCatalog.ts) together, with matching UI updates in the same
  // commit — a real 4th model, not drift. 3 -> 4 here encodes that intent.
  it('MODELS_BY_PROVIDER.anthropic has 4 models', () => {
    expect(MODELS_BY_PROVIDER.anthropic).toHaveLength(4);
  });

  it('MODELS_BY_PROVIDER.anthropic contains Opus 5, Fable, Sonnet, Haiku', () => {
    const ids = MODELS_BY_PROVIDER.anthropic.map(m => m.id);
    expect(ids).toContain('claude-opus-5');
    expect(ids).toContain('claude-fable-5');
    expect(ids).toContain('claude-sonnet-5');
    expect(ids).toContain('claude-haiku-4-5');
  });

  it('findModelById returns the correct model', () => {
    const model = findModelById('claude-sonnet-5');
    expect(model).toBeDefined();
    expect(model?.provider).toBe('anthropic');
  });

  it('findModelById returns undefined for unknown id', () => {
    expect(findModelById('gpt-999-fake')).toBeUndefined();
  });

  it('every model has required fields', () => {
    for (const m of ALL_MODELS) {
      expect(m.id).toBeTruthy();
      expect(m.label).toBeTruthy();
      expect(m.provider).toBeTruthy();
    }
  });
});

// ── OpenRouter catalog (managed / Pro path) ────────────────────────

describe('registry — OpenRouter catalog (managed Pro path)', () => {
  // 12 -> 13 was the v0.1.7 claude-fable-5 addition (real model, documented).
  // 13 -> 20: commit e2c6f37 ("self-improvement, reasoning blocks, codegraph,
  // MCP, browser, compression, canvas") added 7 more distinct real models
  // (Groq x2, Mistral x2, Qwen x1, free-tier x2).
  // 20 -> 23: a later wave added Moonshot's kimi-k3 plus one more Google
  // (gemini-3.5-pro) and one more DeepSeek (deepseek-r1) model, again without
  // updating this test. Verified against openrouterCatalog.ts: all 23 ids are
  // unique and resolvable, so this was stale test drift, not a catalog bug —
  // count corrected to match.
  // 23 -> 20: the catalog was rebuilt against the LIVE OpenRouter /models API
  // (2026-08-08). 8 of the 23 ids did not exist there at all — gemini-3.5-pro,
  // both Groq entries, both Mistral entries, qwen-3-235b-a22b and the two
  // ":free" ones — so they could only ever return 400 invalid_model. The rest
  // were bumped to current versions (gpt-5.4/5.5 -> the gpt-5.6 family,
  // gemini-3.5-flash -> 3.6, +grok-4.5) and Z.ai replaced Groq.
  // 20 -> 21: the free-tier wave added a curated isFree listing.
  // 21 -> 20: stealth/ox-alpha was retired (OpenRouter 502); GLM 5.2 is the
  //           free rail, not a second Z.ai paid entry.
  // 20 -> 27: free-tier wave expanded to seven verified :free ids (2026-09).
  // 27 -> 24: free rail rebuilt around verified-working entries only —
  //           MiniMax M3 became the default free id (GLM 5.2 kept but its
  //           provider errors were confirmed in real-app testing), and
  //           Fable 5.1 / GPT-6 Astra joined the paid tiers.
  // 24 -> 25: BOTH free ids were pulled upstream (verified live via
  //           /api/v1/models 2026-09-11 — every free turn 404'd); the rail
  //           rebuilt around Nemotron 3 Super 120B (new default), Gemma 4
  //           31B (back online) and Nemotron 3 Nano Omni (reasoning).
  // 25 -> 26: endpoint-level verification the same day — nemotron-super's
  //           free route 404'd on a real send (zero free-serving endpoints)
  //           and nano-omni reports 0 endpoints; the rail rebuilt around
  //           four entries whose :free routes are actually routable:
  //           Gemma 4 31B (default, 14 endpoints), Nemotron Ultra 550B,
  //           Inkling, Nemotron 3.5 Lightning.
  it('OPENROUTER_MODELS contains 26 entries', () => {
    expect(OPENROUTER_MODELS.length).toBe(26);
  });

  it('has no duplicate model ids', () => {
    const ids = OPENROUTER_MODELS.map(m => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every model id resolves via findOpenRouterModel', () => {
    for (const m of OPENROUTER_MODELS) {
      expect(findOpenRouterModel(m.id)?.id).toBe(m.id);
    }
  });

  // Free-tier models keep their real vendor (Meta, Qwen) as `provider`; there
  // is no separate "Free" provider — `tier: 'free'` is what marks them.
  it('contains models from all 10 expected providers', () => {
    const providers = new Set(OPENROUTER_MODELS.map(m => m.provider));
    expect(providers.has('Anthropic')).toBe(true);
    expect(providers.has('OpenAI')).toBe(true);
    expect(providers.has('Google')).toBe(true);
    expect(providers.has('Moonshot')).toBe(true);
    expect(providers.has('xAI')).toBe(true);
    expect(providers.has('DeepSeek')).toBe(true);
    expect(providers.has('Meta')).toBe(true);
    expect(providers.has('Mistral')).toBe(true);
    expect(providers.has('Qwen')).toBe(true);
    expect(providers.has('Z.ai')).toBe(true);
    expect(providers.has('NVIDIA')).toBe(true);
    expect(providers.has('Free')).toBe(false);
    // Groq's two ids do not exist on OpenRouter — see the count note above.
    expect(providers.has('Groq')).toBe(false);
  });

  it('DEFAULT_OPENROUTER_MODEL_ID resolves in the catalog', () => {
    const m = findOpenRouterModel(DEFAULT_OPENROUTER_MODEL_ID);
    expect(m).toBeDefined();
    expect(m?.id).toBe('anthropic/claude-sonnet-5');
  });

  it('OPENROUTER_MODELS_BY_PROVIDER groups correctly', () => {
    expect(OPENROUTER_MODELS_BY_PROVIDER['Anthropic']).toHaveLength(5);
    expect(OPENROUTER_MODELS_BY_PROVIDER['OpenAI']).toHaveLength(4);
    expect(OPENROUTER_MODELS_BY_PROVIDER['Google']).toHaveLength(3);
    expect(OPENROUTER_MODELS_BY_PROVIDER['Moonshot']).toHaveLength(2);
    expect(OPENROUTER_MODELS_BY_PROVIDER['xAI']).toHaveLength(2);
    expect(OPENROUTER_MODELS_BY_PROVIDER['DeepSeek']).toHaveLength(2);
    expect(OPENROUTER_MODELS_BY_PROVIDER['Meta']).toHaveLength(1);
    expect(OPENROUTER_MODELS_BY_PROVIDER['Mistral']).toHaveLength(1);
    expect(OPENROUTER_MODELS_BY_PROVIDER['Qwen']).toHaveLength(2);
    expect(OPENROUTER_MODELS_BY_PROVIDER['Z.ai']).toHaveLength(1);
    expect(OPENROUTER_MODELS_BY_PROVIDER['NVIDIA']).toHaveLength(2);
    expect(OPENROUTER_MODELS_BY_PROVIDER['Thinking Machines']).toHaveLength(1);
    expect(OPENROUTER_MODELS_BY_PROVIDER['MiniMax']).toBeUndefined();
    expect(OPENROUTER_MODELS_BY_PROVIDER['Groq']).toBeUndefined();
    expect(OPENROUTER_MODELS_BY_PROVIDER['Free']).toBeUndefined();
  });

  it('findOpenRouterModel returns undefined for native ids', () => {
    // Native Anthropic ids must NOT match OpenRouter ids.
    expect(findOpenRouterModel('claude-sonnet-5')).toBeUndefined();
  });

  it('priceBadge returns $ for cheap models', () => {
    const cheap = findOpenRouterModel('deepseek/deepseek-v4-flash');
    expect(cheap).toBeDefined();
    expect(priceBadge(cheap!)).toBe('$');
  });

  it('priceBadge returns $$ for mid-range models', () => {
    const mid = findOpenRouterModel('anthropic/claude-sonnet-5');
    expect(mid).toBeDefined();
    expect(priceBadge(mid!)).toBe('$$');
  });

  it('every isFree catalog entry uses tier free and includes the default free id', () => {
    const freeModels = OPENROUTER_MODELS.filter(m => m.isFree);
    expect(freeModels).toHaveLength(4);
    expect(freeModels.some(m => m.id === FREE_OPENROUTER_MODEL_ID)).toBe(true);
    expect(OPENROUTER_MODELS.filter(m => m.tier === 'free')).toHaveLength(4);
    for (const m of freeModels) {
      expect(m.tier).toBe('free');
      expect(m.id.endsWith(':free') || m.id === FREE_OPENROUTER_MODEL_ID).toBe(true);
    }
  });

  it('priceBadge returns FREE for a synthetic free model', () => {
    // Keep a catalog-independent check too, so this logic stays covered even
    // if the catalog's free-tier entries are ever removed again.
    const syntheticFree = {
      id: 'test/free-model',
      label: 'Test Free',
      provider: 'Test',
      tier: 'free' as const,
      reasoning: false,
      priceIn: 0,
      priceOut: 0,
      maxTokens: 2048,
      webSearch: false,
      isFree: true,
    };
    expect(priceBadge(syntheticFree)).toBe('FREE');
  });

  it('priceBadge returns $$$ for premium models', () => {
    const premium = findOpenRouterModel('openai/gpt-5.6-sol');
    expect(premium).toBeDefined();
    expect(priceBadge(premium!)).toBe('$$$');
  });

  it('every OpenRouter model has required fields', () => {
    for (const m of OPENROUTER_MODELS) {
      expect(m.id).toBeTruthy();
      expect(m.label).toBeTruthy();
      expect(m.provider).toBeTruthy();
      expect(['fast', 'balanced', 'max', 'free']).toContain(m.tier);
      expect(typeof m.reasoning).toBe('boolean');
      // Free models have priceIn/priceOut = 0; paid models > 0
      if (m.isFree) {
        expect(m.priceIn).toBe(0);
        expect(m.priceOut).toBe(0);
      } else {
        expect(m.priceIn).toBeGreaterThan(0);
        expect(m.priceOut).toBeGreaterThan(0);
      }
    }
  });

  it('Llama 4 Maverick does not support reasoning', () => {
    const llama = findOpenRouterModel('meta-llama/llama-4-maverick');
    expect(llama?.reasoning).toBe(false);
  });
});
