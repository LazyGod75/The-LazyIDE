/**
 * freeModelTier.test.ts — end-to-end contract of the FREE model tier
 * (GLM 5.2): any authenticated user can pick and run it with NO Lazy Pro
 * plan, NO credits and NO API key. One test per client gate that could
 * regress and quietly re-paywall it:
 *   1. catalog     — GLM 5.2 is in the OpenRouter catalog, flagged free
 *   2. parity      — covered by catalogParity.test.ts (same fields both sides)
 *   3. picker      — the free group is offered FIRST with zero entitlements
 *   4. readiness   — getEngineReadiness(modelId) is ready without a plan
 *   5. dispatch    — classifyMissionModel routes it to the managed engine
 */

import { describe, it, expect } from 'vitest';
import {
  OPENROUTER_MODELS,
  findOpenRouterModel,
  isOpenRouterFreeModel,
  FREE_OPENROUTER_MODEL_ID,
  migrateRetiredOpenRouterId,
} from '../openrouterCatalog';
import { buildModelPickerOptions } from '../modelPickerOptions';
import { getEngineReadiness } from '../entitlement';
import { classifyMissionModel } from '../../agents/runtime';

describe('free model tier (GLM 5.2)', () => {
  it('catalog: GLM 5.2 exists, is free, zero-priced', () => {
    const m = findOpenRouterModel(FREE_OPENROUTER_MODEL_ID);
    expect(m).toBeDefined();
    expect(m!.isFree).toBe(true);
    expect(m!.priceIn).toBe(0);
    expect(m!.priceOut).toBe(0);
    expect(m!.tier).toBe('free');
    // Every isFree catalog entry (GLM 5.2 + the OpenRouter `:free` models).
    expect(OPENROUTER_MODELS.filter((x) => x.isFree).map((x) => x.id)).toContain(FREE_OPENROUTER_MODEL_ID);
  });

  it('retired ox-alpha / glm-5.3-flash ids migrate to GLM 5.2', () => {
    expect(migrateRetiredOpenRouterId('stealth/ox-alpha')).toBe(FREE_OPENROUTER_MODEL_ID);
    expect(migrateRetiredOpenRouterId('z-ai/glm-5.3-flash')).toBe(FREE_OPENROUTER_MODEL_ID);
    expect(migrateRetiredOpenRouterId(FREE_OPENROUTER_MODEL_ID)).toBe(FREE_OPENROUTER_MODEL_ID);
  });

  it('isOpenRouterFreeModel: true for GLM 5.2, false for paid/unknown/undefined ids', () => {
    expect(isOpenRouterFreeModel(FREE_OPENROUTER_MODEL_ID)).toBe(true);
    expect(isOpenRouterFreeModel('stealth/ox-alpha')).toBe(false);
    expect(isOpenRouterFreeModel('anthropic/claude-sonnet-5')).toBe(false);
    expect(isOpenRouterFreeModel('nope/not-a-model')).toBe(false);
    expect(isOpenRouterFreeModel(undefined)).toBe(false);
  });

  it('picker: the free group is present FIRST even with zero entitlements', () => {
    const result = buildModelPickerOptions({ claudeSub: false, pro: 'inactive', codexManaged: false });
    expect(result.groups[0].id).toBe('free');
    // The free group offers EVERY isFree catalog entry (GLM 5.2 + the
    // OpenRouter `:free` models), never just one hardcoded id.
    const expectedFreeIds = OPENROUTER_MODELS.filter((m) => m.isFree).map((m) => m.id);
    expect(result.groups[0].models.map((m) => m.id)).toEqual(expectedFreeIds);
    expect(result.hasOptions).toBe(true);
  });

  it('picker: zero entitlements -> defaultModelId is the free model AND a member of the offered groups', () => {
    const result = buildModelPickerOptions({ claudeSub: false, pro: 'inactive', codexManaged: false });
    expect(result.defaultModelId).toBe(FREE_OPENROUTER_MODEL_ID);
    expect(result.groups.flatMap((g) => g.models.map((m) => m.id))).toContain(result.defaultModelId);
  });

  it('readiness: an explicitly chosen GLM 5.2 passes the launch preflight with NO plan', () => {
    const readiness = getEngineReadiness(undefined, FREE_OPENROUTER_MODEL_ID);
    expect(readiness.ready).toBe(true);
  });

  it('readiness: a PAID managed model still demands an active plan (no accidental free-for-all)', () => {
    const readiness = getEngineReadiness('pro');
    if (!readiness.ready) {
      expect(readiness.reason).toMatch(/pro-/);
    }
  });

  it('dispatch: classifyMissionModel routes GLM 5.2 to the managed engine (id contains "/")', () => {
    expect(classifyMissionModel(FREE_OPENROUTER_MODEL_ID)).toBe('managed');
  });
});
