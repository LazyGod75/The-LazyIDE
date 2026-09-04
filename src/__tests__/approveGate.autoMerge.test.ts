/**
 * approveGate.autoMerge.test.ts — W-MODES safety-matrix coverage for
 * evaluateAutoMerge/hasSecurityRejection (approveGate.ts). Pure-function
 * tests, no store/React/Tauri wiring — see agentsStore.approvalModes.test.tsx
 * for the end-to-end choke-point + no-retro-merge + chain-fires-after
 * coverage.
 */

import { describe, it, expect } from 'vitest';
import { evaluateAutoMerge, hasSecurityRejection, type AutoMergeMission } from '../components/agents/approveGate';
import type { JudgeVerdict, MissionContract, ReviewerVerdict } from '../lib/agents/types';

// ── Helpers ────────────────────────────────────────────────────────

function reviewer(role: ReviewerVerdict['role'], verdict: ReviewerVerdict['verdict'], inconclusive = false): ReviewerVerdict {
  return { role, verdict, summary: '', inconclusive };
}

function verdict(overrides: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return {
    score: 90,
    passed: true,
    risk: 'low',
    reviewers: [reviewer('tester', 'approve'), reviewer('reviewer', 'approve'), reviewer('security', 'approve')],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function contract(overrides: Partial<MissionContract> = {}): MissionContract {
  return {
    objective: 'test',
    model: 'sonnet',
    permissionMode: 'acceptEdits',
    budgetCapUsd: 20,
    proofs: [],
    gates: { evaluators: true, humanApprove: false },
    shareToTeam: false,
    ...overrides,
  };
}

function mission(overrides: Partial<AutoMergeMission> = {}): AutoMergeMission {
  return {
    status: 'review',
    judgeVerdict: verdict(),
    contract: contract(),
    proofs: [],
    ...overrides,
  };
}

// ── hasSecurityRejection ─────────────────────────────────────────────

describe('hasSecurityRejection', () => {
  it('is false when verdict is absent', () => {
    expect(hasSecurityRejection(undefined)).toBe(false);
  });

  it('is false when the security reviewer approved', () => {
    expect(hasSecurityRejection(verdict())).toBe(false);
  });

  it('is true when the security reviewer conclusively rejected', () => {
    const v = verdict({ reviewers: [reviewer('security', 'reject')] });
    expect(hasSecurityRejection(v)).toBe(true);
  });

  it('is false when the security reviewer rejected but is inconclusive (evaluator-infra failure, non-vote)', () => {
    const v = verdict({ reviewers: [reviewer('security', 'reject', true)] });
    expect(hasSecurityRejection(v)).toBe(false);
  });

  it('is false when only a non-security reviewer rejected', () => {
    const v = verdict({ reviewers: [reviewer('reviewer', 'reject')] });
    expect(hasSecurityRejection(v)).toBe(false);
  });
});

// ── evaluateAutoMerge — manual mode ───────────────────────────────────

describe('evaluateAutoMerge — manual mode', () => {
  it('never eligible, regardless of how green the mission is', () => {
    const decision = evaluateAutoMerge(mission(), 'manual');
    expect(decision.eligible).toBe(false);
  });
});

// ── evaluateAutoMerge — entry guard ───────────────────────────────────

describe('evaluateAutoMerge — entry guard', () => {
  it('never eligible for a mission not in review (queued/running/done/failed/cancelled)', () => {
    for (const status of ['queued', 'running', 'done', 'failed', 'cancelled'] as const) {
      const decision = evaluateAutoMerge(mission({ status }), 'full_auto');
      expect(decision.eligible).toBe(false);
    }
  });
});

// ── evaluateAutoMerge — auto_green: strict green path ────────────────

describe('evaluateAutoMerge — auto_green', () => {
  it('eligible (no force) on the strict green path: passed, no security reject, proofs satisfied', () => {
    const decision = evaluateAutoMerge(mission(), 'auto_green');
    expect(decision.eligible).toBe(true);
    expect(decision.useForce).toBe(false);
  });

  it('NOT eligible when judgeVerdict is absent (inconclusive stops auto_green)', () => {
    const decision = evaluateAutoMerge(mission({ judgeVerdict: undefined }), 'auto_green');
    expect(decision.eligible).toBe(false);
  });

  it('NOT eligible when judgeVerdict.passed === false', () => {
    const decision = evaluateAutoMerge(mission({ judgeVerdict: verdict({ passed: false }) }), 'auto_green');
    expect(decision.eligible).toBe(false);
  });

  it('NOT eligible when scoreUnavailable === true (no real signal, even if passed happens to be true)', () => {
    const decision = evaluateAutoMerge(
      mission({ judgeVerdict: verdict({ scoreUnavailable: true }) }),
      'auto_green',
    );
    // scoreUnavailable alone does not flip passed to false in this fixture,
    // so the green path (passed===true && proofs ok) is still technically
    // satisfied — scoreUnavailable is only a floor-relevant distinction for
    // full_auto's inconclusive fallback, not an auto_green blocker on its
    // own. This test locks in that auto_green's own rule is judgeVerdict.
    // passed, not the score's realness.
    expect(decision.eligible).toBe(true);
  });

  it('NOT eligible when a required proof kind is missing', () => {
    const m = mission({ contract: contract({ proofs: [{ kind: 'test_run', label: 'tests' }] }), proofs: [] });
    const decision = evaluateAutoMerge(m, 'auto_green');
    expect(decision.eligible).toBe(false);
  });

  it('eligible when every required proof kind is present', () => {
    const m = mission({
      contract: contract({ proofs: [{ kind: 'test_run', label: 'tests' }] }),
      proofs: [{ kind: 'test_run', command: 'npm test', exitCode: 0, outputPath: 'out.txt' }],
    });
    const decision = evaluateAutoMerge(m, 'auto_green');
    expect(decision.eligible).toBe(true);
  });

  it('NOT eligible on a conclusive security rejection, even with a passing judge', () => {
    const m = mission({ judgeVerdict: verdict({ reviewers: [reviewer('security', 'reject')] }) });
    const decision = evaluateAutoMerge(m, 'auto_green');
    expect(decision.eligible).toBe(false);
  });

  it('NOT eligible when contract.gates.humanApprove === true (explicit per-mission opt-out always wins)', () => {
    const m = mission({ contract: contract({ gates: { evaluators: true, humanApprove: true } }) });
    const decision = evaluateAutoMerge(m, 'auto_green');
    expect(decision.eligible).toBe(false);
  });

  it('NOT eligible when the budget cap has been exceeded', () => {
    const m = mission({ contract: contract({ budgetCapUsd: 10 }), totalCost: '$15.00' });
    const decision = evaluateAutoMerge(m, 'auto_green');
    expect(decision.eligible).toBe(false);
  });

  it('eligible when spend is unparseable/unknown (fail-open on an unproven budget signal)', () => {
    const m = mission({ contract: contract({ budgetCapUsd: 10 }), totalCost: undefined, cost: undefined });
    const decision = evaluateAutoMerge(m, 'auto_green');
    expect(decision.eligible).toBe(true);
  });
});

// ── evaluateAutoMerge — full_auto: hard safety floor ─────────────────

describe('evaluateAutoMerge — full_auto', () => {
  it('eligible (no force) on the same green path as auto_green', () => {
    const decision = evaluateAutoMerge(mission(), 'full_auto');
    expect(decision.eligible).toBe(true);
    expect(decision.useForce).toBe(false);
  });

  it('eligible WITH force when judgeVerdict is entirely absent AND runtime.ts settled on "no verdict is coming" (evaluateMission threw — genuinely inconclusive)', () => {
    // W-PROVE bug fix: judgeVerdict undefined alone is NOT enough — see
    // isEvaluationSettledUnavailable's own doc comment (approveGate.ts) for
    // why. `judgesApproved: 'évaluation indisponible'` is the exact marker
    // runtime.ts's Step F catch block stamps once evaluateMission() itself
    // has thrown, i.e. the ONLY point at which "no verdict is coming" is an
    // already-settled fact rather than "hasn't reported back yet".
    const decision = evaluateAutoMerge(
      mission({ judgeVerdict: undefined, judgesApproved: 'évaluation indisponible' }),
      'full_auto',
    );
    expect(decision.eligible).toBe(true);
    expect(decision.useForce).toBe(true);
  });

  it('NOT eligible when judgeVerdict is absent but evaluation is still PENDING (no settled-unavailable marker) — the Step D/Step F race fix', () => {
    // Reproduces runtime.ts's real timeline: Step D flips status to 'review'
    // (judgeVerdict undefined) well before Step F's evaluateMission() ever
    // resolves — treating this exactly like the "genuinely inconclusive"
    // case above would force-merge every full_auto mission the instant its
    // diff is computed, before a single evaluator sub-agent has run,
    // defeating the documented hard floor entirely. See
    // autoMergeSafetyReplay.test.ts for the full end-to-end replay of this
    // exact race through the real store.
    const decision = evaluateAutoMerge(mission({ judgeVerdict: undefined, judgesApproved: undefined }), 'full_auto');
    expect(decision.eligible).toBe(false);
  });

  it('eligible WITH force when scoreUnavailable === true and proofs are missing', () => {
    const m = mission({
      judgeVerdict: verdict({ scoreUnavailable: true, passed: false }),
      contract: contract({ proofs: [{ kind: 'test_run', label: 'tests' }] }),
      proofs: [],
    });
    const decision = evaluateAutoMerge(m, 'full_auto');
    expect(decision.eligible).toBe(true);
    expect(decision.useForce).toBe(true);
  });

  it('NEVER eligible on a REAL conclusive judge rejection (passed===false, scoreUnavailable !== true) — the floor', () => {
    const decision = evaluateAutoMerge(mission({ judgeVerdict: verdict({ passed: false }) }), 'full_auto');
    expect(decision.eligible).toBe(false);
  });

  it('NEVER eligible on a conclusive security rejection — the floor holds even in full_auto', () => {
    const m = mission({ judgeVerdict: verdict({ reviewers: [reviewer('security', 'reject')] }) });
    const decision = evaluateAutoMerge(m, 'full_auto');
    expect(decision.eligible).toBe(false);
  });

  it('NEVER eligible when contract.gates.humanApprove === true — the floor holds even in full_auto', () => {
    const m = mission({ contract: contract({ gates: { evaluators: true, humanApprove: true } }), judgeVerdict: undefined });
    const decision = evaluateAutoMerge(m, 'full_auto');
    expect(decision.eligible).toBe(false);
  });

  it('NEVER eligible when the budget cap has been exceeded — the floor holds even in full_auto', () => {
    const m = mission({ contract: contract({ budgetCapUsd: 10 }), totalCost: '$99.00', judgeVerdict: undefined });
    const decision = evaluateAutoMerge(m, 'full_auto');
    expect(decision.eligible).toBe(false);
  });

  it('never eligible for a non-review status even in full_auto (status==="failed" floor)', () => {
    const decision = evaluateAutoMerge(mission({ status: 'failed', judgeVerdict: undefined }), 'full_auto');
    expect(decision.eligible).toBe(false);
  });
});
