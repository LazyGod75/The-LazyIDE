/**
 * legacyHumanApproveMigration.test.ts — retroactive fix for missions
 * created BEFORE 1acd6bb ("stop hardcoding humanApprove:true on default
 * mission contracts"). That commit only changed what NEW missions get;
 * every mission already sitting in 'review' with the old baked-in
 * `contract.gates.humanApprove: true` stays permanently opted out of
 * auto-merge (evaluateAutoMerge rule #2 always wins), regardless of the
 * project's auto_green/full_auto mode. planLegacyHumanApproveMigration
 * (approveGate.ts) is the targeted, safety-preserving re-evaluation: only
 * ever proposes unblocking the STRICT green path, never manual mode, never
 * a rejected/pending verdict.
 */

import { describe, it, expect } from 'vitest';
import { evaluateAutoMerge, planLegacyHumanApproveMigration, type LegacyReviewMission } from '../components/agents/approveGate';
import type { JudgeVerdict, MissionContract, ReviewerVerdict } from '../lib/agents/types';

function reviewer(role: ReviewerVerdict['role'], verdict: ReviewerVerdict['verdict']): ReviewerVerdict {
  return { role, verdict, summary: '' };
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

function legacyContract(overrides: Partial<MissionContract> = {}): MissionContract {
  return {
    objective: 'test',
    model: 'sonnet',
    permissionMode: 'acceptEdits',
    budgetCapUsd: 20,
    proofs: [],
    // The pre-1acd6bb bug: every mission created before that fix carries
    // this baked-in true forever.
    gates: { evaluators: true, humanApprove: true },
    shareToTeam: false,
    ...overrides,
  };
}

function legacyMission(overrides: Partial<LegacyReviewMission> = {}): LegacyReviewMission {
  return {
    id: 'm-1',
    status: 'review',
    judgeVerdict: verdict(),
    contract: legacyContract(),
    proofs: [],
    ...overrides,
  };
}

describe('RED: the pre-existing bug this migration fixes', () => {
  it('a green-verdict legacy mission is (correctly, by existing design) NOT eligible under evaluateAutoMerge alone, because of the baked-in humanApprove:true floor — this is exactly why 38 real missions never resolve', () => {
    const mission = legacyMission();
    const decision = evaluateAutoMerge(mission, 'auto_green');
    expect(decision.eligible).toBe(false);
    expect(decision.reason).toBe('contract.gates.humanApprove opts this mission out');
  });
});

describe('GREEN: planLegacyHumanApproveMigration', () => {
  it('proposes unblocking a legacy mission on the strict green path in auto_green', () => {
    const plan = planLegacyHumanApproveMigration([legacyMission({ id: 'm-1' })], 'auto_green');
    expect(plan).toEqual([{ missionId: 'm-1', eligible: true }]);
  });

  it('proposes unblocking a legacy mission on the strict green path in full_auto too', () => {
    const plan = planLegacyHumanApproveMigration([legacyMission({ id: 'm-2' })], 'full_auto');
    expect(plan).toEqual([{ missionId: 'm-2', eligible: true }]);
  });

  it('never proposes unblocking anything in manual mode (manual stays strictly manual)', () => {
    const plan = planLegacyHumanApproveMigration([legacyMission({ id: 'm-3' })], 'manual');
    expect(plan).toEqual([{ missionId: 'm-3', eligible: false }]);
  });

  it('does NOT unblock a rejected verdict — a real security decision is never silently overturned', () => {
    const rejected = legacyMission({
      id: 'm-4',
      judgeVerdict: verdict({ passed: false, reviewers: [reviewer('tester', 'reject'), reviewer('reviewer', 'approve'), reviewer('security', 'approve')] }),
    });
    const plan = planLegacyHumanApproveMigration([rejected], 'auto_green');
    expect(plan).toEqual([{ missionId: 'm-4', eligible: false }]);
  });

  it('does NOT unblock a missing/inconclusive verdict even in full_auto — batch migration never force-merges an evaluation a human never saw', () => {
    const pending = legacyMission({ id: 'm-5', judgeVerdict: undefined });
    const plan = planLegacyHumanApproveMigration([pending], 'full_auto');
    expect(plan).toEqual([{ missionId: 'm-5', eligible: false }]);
  });

  it('does NOT unblock a mission missing required proofs', () => {
    const missingProof = legacyMission({
      id: 'm-6',
      contract: legacyContract({ proofs: [{ kind: 'test_run' }] }),
      proofs: [],
    });
    const plan = planLegacyHumanApproveMigration([missingProof], 'auto_green');
    expect(plan).toEqual([{ missionId: 'm-6', eligible: false }]);
  });

  it('ignores missions that already carry the fixed default humanApprove:false — nothing to migrate', () => {
    const alreadyFixed = legacyMission({ id: 'm-7', contract: legacyContract({ gates: { evaluators: true, humanApprove: false } }) });
    const plan = planLegacyHumanApproveMigration([alreadyFixed], 'auto_green');
    expect(plan).toEqual([]);
  });

  it('ignores missions not in review (e.g. already done/failed)', () => {
    const done = legacyMission({ id: 'm-8', status: 'done' });
    const plan = planLegacyHumanApproveMigration([done], 'auto_green');
    expect(plan).toEqual([]);
  });
});
