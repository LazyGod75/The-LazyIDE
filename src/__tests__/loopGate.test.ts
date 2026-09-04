/**
 * Tests for loopGate.ts — the generic trial/validated/autonomous state
 * machine (spec §4), operating on the canonical `LoopConfig.regimeState` /
 * `trialApprovedCount` / `trialPromotionThreshold` fields. Pure functions,
 * no I/O.
 */

import { describe, it, expect } from 'vitest';
import { recordApproval, recordFailure, type GatedLoopConfig } from '../lib/agents/loopGate';

function trialConfig(overrides: Partial<GatedLoopConfig> = {}): GatedLoopConfig {
  return { regimeState: 'trial', trialApprovedCount: 0, trialPromotionThreshold: 3, ...overrides };
}

describe('recordApproval — promotion after N validations, not before', () => {
  it('does NOT promote before the threshold is reached', () => {
    const config = trialConfig({ trialPromotionThreshold: 3 });
    const r1 = recordApproval(config);
    expect(r1.promoted).toBe(false);
    expect(r1.patch).toEqual({ trialApprovedCount: 1 });

    const r2 = recordApproval({ ...config, ...r1.patch });
    expect(r2.promoted).toBe(false);
    expect(r2.patch).toEqual({ trialApprovedCount: 2 });
  });

  it('promotes to validated exactly on the approval that reaches the threshold', () => {
    let config = trialConfig({ trialPromotionThreshold: 3 });
    let promoted = false;
    for (let i = 0; i < 3; i++) {
      const outcome = recordApproval(config);
      config = { ...config, ...outcome.patch };
      promoted = outcome.promoted;
    }
    expect(promoted).toBe(true);
    expect(config.regimeState).toBe('validated');
    expect(config.trialApprovedCount).toBe(3);
  });

  it('is a no-op (never counts, never promotes) once already validated/autonomous/self_improving', () => {
    for (const regimeState of ['validated', 'autonomous', 'self_improving'] as const) {
      const config = trialConfig({ regimeState, trialApprovedCount: 3 });
      const outcome = recordApproval(config);
      expect(outcome.promoted).toBe(false);
      expect(outcome.patch).toEqual({});
    }
  });

  it('is a no-op for a loop with no gated regime at all (regimeState absent)', () => {
    const outcome = recordApproval({});
    expect(outcome.promoted).toBe(false);
    expect(outcome.patch).toEqual({});
  });

  it('defaults an absent trialPromotionThreshold to 1 (promotes on the very first approval)', () => {
    const outcome = recordApproval({ regimeState: 'trial' });
    expect(outcome.promoted).toBe(true);
    expect(outcome.patch).toEqual({ regimeState: 'validated', trialApprovedCount: 1 });
  });

  it('never mutates the input config', () => {
    const config = trialConfig();
    const frozen = { ...config };
    recordApproval(config);
    expect(config).toEqual(frozen);
  });
});

describe('recordFailure — return to trial on failure', () => {
  it('demotes a validated regime back to trial, resetting the approval counter', () => {
    const config = trialConfig({ regimeState: 'validated', trialApprovedCount: 3, trialPromotionThreshold: 3 });
    const outcome = recordFailure(config);
    expect(outcome.demoted).toBe(true);
    expect(outcome.patch).toEqual({ regimeState: 'trial', trialApprovedCount: 0 });
  });

  it('demotes an autonomous or self_improving regime back to trial the same way', () => {
    for (const regimeState of ['autonomous', 'self_improving'] as const) {
      const config = trialConfig({ regimeState });
      const outcome = recordFailure(config);
      expect(outcome.demoted).toBe(true);
      expect(outcome.patch.regimeState).toBe('trial');
    }
  });

  it('does nothing further when already in trial (no state below trial)', () => {
    const config = trialConfig({ regimeState: 'trial' });
    const outcome = recordFailure(config);
    expect(outcome.demoted).toBe(false);
    expect(outcome.patch).toEqual({});
  });

  it('is a no-op for a loop with no gated regime at all', () => {
    const outcome = recordFailure({});
    expect(outcome.demoted).toBe(false);
    expect(outcome.patch).toEqual({});
  });

  it('never mutates the input config', () => {
    const config = trialConfig({ regimeState: 'validated', trialApprovedCount: 3 });
    const frozen = { ...config };
    recordFailure(config);
    expect(config).toEqual(frozen);
  });

  it('keeps the same trialPromotionThreshold after demotion — re-promotion needs the full count again', () => {
    const config = trialConfig({ regimeState: 'validated', trialApprovedCount: 5, trialPromotionThreshold: 5 });
    const outcome = recordFailure(config);
    const merged = { ...config, ...outcome.patch };
    expect(merged.trialPromotionThreshold).toBe(5);
    expect(merged.trialApprovedCount).toBe(0);
  });
});
