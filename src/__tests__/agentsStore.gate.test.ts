import { describe, it, expect, vi } from 'vitest';
import { checkApproveGate, ApproveBlockedError, isDiffEmpty, isJudgeRejected } from '../components/agents/approveGate';
import { JUDGE_UNAVAILABLE_PROVIDER_REASON } from '../lib/agents/evaluator';
import type { JudgeVerdict } from '../lib/agents/types';

// ── Helpers ────────────────────────────────────────────────────────

function makeVerdict(passed: boolean, score = 80): JudgeVerdict {
  return {
    score,
    passed,
    risk: 'medium',
    reviewers: [],
    createdAt: new Date().toISOString(),
  };
}

/** A rejected verdict whose judge reviewer carries evaluator.ts's stable
 *  JUDGE_UNAVAILABLE_PROVIDER_REASON marker — the 2026-08-05 DeepSeek 402
 *  shape: the judge sub-agent's provider call failed outright, so the verdict
 *  settles `passed: false` even though no real code review ever happened. */
function makeUnavailableVerdict(score = 80): JudgeVerdict {
  return {
    score,
    passed: false,
    risk: 'medium',
    reviewers: [
      {
        role: 'judge',
        verdict: 'request_changes',
        summary: `${JUDGE_UNAVAILABLE_PROVIDER_REASON}: deepseek — 402 quota exceeded (provider error, not a code defect — the judge could not run).`,
        inconclusive: true,
      },
    ],
    createdAt: new Date().toISOString(),
  };
}

// ── Gate unit tests ────────────────────────────────────────────────

describe('checkApproveGate', () => {
  it('blocks when judgeVerdict is undefined and force is not set', () => {
    const result = checkApproveGate({ judgeVerdict: undefined });
    expect(result).toBeInstanceOf(ApproveBlockedError);
    expect(result!.name).toBe('ApproveBlockedError');
    expect(result!.reason).toMatch(/Évaluation manquante/);
  });

  it('blocks when judgeVerdict.passed === false and force is not set', () => {
    const result = checkApproveGate({ judgeVerdict: makeVerdict(false, 42) });
    expect(result).toBeInstanceOf(ApproveBlockedError);
    expect(result!.reason).toMatch(/rejeté/);
    expect(result!.reason).toMatch(/42/); // score in message
  });

  it('bridges the JUDGE_UNAVAILABLE_PROVIDER_REASON marker into the thrown reason when the judge reviewer could not run (2026-08-05 DeepSeek 402 bridge)', () => {
    const result = checkApproveGate({ judgeVerdict: makeUnavailableVerdict() });
    expect(result).toBeInstanceOf(ApproveBlockedError);
    expect(result!.reason).toContain(JUDGE_UNAVAILABLE_PROVIDER_REASON);
    expect(result!.reason).not.toMatch(/a rejeté/);
  });

  it('keeps the genuine-rejection message byte-identical when the judge reviewer carries no unavailable marker', () => {
    const result = checkApproveGate({ judgeVerdict: makeVerdict(false, 42) });
    expect(result).toBeInstanceOf(ApproveBlockedError);
    expect(result!.reason).toBe(
      'Le juge a rejeté cette mission (42/100). ' +
      'Corrigez les problèmes ou utilisez "Merger quand même" pour forcer.',
    );
    expect(result!.reason).not.toContain(JUDGE_UNAVAILABLE_PROVIDER_REASON);
  });

  it('allows when judgeVerdict.passed === true', () => {
    const result = checkApproveGate({ judgeVerdict: makeVerdict(true) });
    expect(result).toBeNull();
  });

  // ── R14 (this task, live repro): scoreUnavailable must never read as a
  // judge rejection. See approveGate.ts's checkApproveGate doc comment for
  // the full "manual approve mirrors the auto_green lazy floor" rationale.
  describe('scoreUnavailable (evaluator-rail failure, never a real rejection)', () => {
    function makeScoreUnavailableVerdict(): JudgeVerdict {
      return { score: 0, passed: false, risk: 'high', reviewers: [], createdAt: new Date().toISOString(), scoreUnavailable: true };
    }

    it('blocks with an honest "evaluation unavailable" reason (never "rejeté"/"rejected") when there is nothing real to merge (empty diff)', () => {
      const result = checkApproveGate({ judgeVerdict: makeScoreUnavailableVerdict(), diffAdded: 0, diffRemoved: 0 });
      expect(result).toBeInstanceOf(ApproveBlockedError);
      expect(result!.reason).not.toMatch(/rejeté|rejected/i);
      expect(result!.reason).toMatch(/indisponible|unavailable/i);
      expect(result!.judgeUnavailable).toBe(true);
    });

    it('allows directly (no force needed) when there IS a real, non-empty deliverable — mirrors evaluateAutoMerge\'s own lazy floor for auto_green/full_auto', () => {
      const result = checkApproveGate({ judgeVerdict: makeScoreUnavailableVerdict(), diffAdded: 12, diffRemoved: 3 });
      expect(result).toBeNull();
    });

    it('a GENUINE rejection (passed:false, scoreUnavailable NOT set) still blocks with the real score, even on a non-empty diff', () => {
      const result = checkApproveGate({ judgeVerdict: makeVerdict(false, 42), diffAdded: 12, diffRemoved: 3 });
      expect(result).toBeInstanceOf(ApproveBlockedError);
      expect(result!.reason).toMatch(/rejeté|rejected/i);
      expect(result!.reason).toMatch(/42/);
      expect(result!.judgeUnavailable).toBeUndefined();
    });

    it('threading a t() function routes the message through i18n instead of the hardcoded French fallback', () => {
      const t = (key: string) => (key === 'agents.approveGate.scoreUnavailableEmptyDiff' ? 'STUBBED_UNAVAILABLE' : key);
      const result = checkApproveGate(
        { judgeVerdict: makeScoreUnavailableVerdict(), diffAdded: 0, diffRemoved: 0 },
        { t },
      );
      expect(result!.reason).toBe('STUBBED_UNAVAILABLE');
    });
  });

  it('allows when force === true even if verdict is absent', () => {
    const result = checkApproveGate({ judgeVerdict: undefined }, { force: true });
    expect(result).toBeNull();
  });

  it('allows when force === true even if passed === false', () => {
    const result = checkApproveGate({ judgeVerdict: makeVerdict(false) }, { force: true });
    expect(result).toBeNull();
  });

  it('blocks when force is explicitly false and verdict is absent', () => {
    const result = checkApproveGate({ judgeVerdict: undefined }, { force: false });
    expect(result).toBeInstanceOf(ApproveBlockedError);
  });

  it('blocks when force is explicitly false and passed === false', () => {
    const result = checkApproveGate({ judgeVerdict: makeVerdict(false) }, { force: false });
    expect(result).toBeInstanceOf(ApproveBlockedError);
  });
});

// ── Integration: mergeWorktree is NOT called when gate blocks ──────
// We test this by mocking the runtime module and verifying call count.

describe('approveMission gate integration', () => {
  // This describes the contract that must hold when the store is used.
  // Since approveMission is a hook callback (not directly importable),
  // we validate the contract through checkApproveGate which it delegates to.

  it('gate returns error → mergeWorktree must not be called', async () => {
    const mergeWorktreeMock = vi.fn().mockResolvedValue(undefined);

    const mission = { judgeVerdict: makeVerdict(false, 30) };
    const gateError = checkApproveGate(mission);

    // Simulate what approveMission does: if gate blocks, throw immediately
    const merge = async () => {
      if (gateError) throw gateError;
      await mergeWorktreeMock('.', 'branch');
    };

    await expect(merge()).rejects.toBeInstanceOf(ApproveBlockedError);
    expect(mergeWorktreeMock).not.toHaveBeenCalled();
  });

  it('gate returns null → mergeWorktree is called', async () => {
    const mergeWorktreeMock = vi.fn().mockResolvedValue(undefined);

    const mission = { judgeVerdict: makeVerdict(true) };
    const gateError = checkApproveGate(mission);

    const merge = async () => {
      if (gateError) throw gateError;
      await mergeWorktreeMock('.', 'branch');
    };

    await merge();
    expect(mergeWorktreeMock).toHaveBeenCalledOnce();
  });

  it('force=true + passed===false → mergeWorktree is called', async () => {
    const mergeWorktreeMock = vi.fn().mockResolvedValue(undefined);

    const mission = { judgeVerdict: makeVerdict(false) };
    const gateError = checkApproveGate(mission, { force: true });

    const merge = async () => {
      if (gateError) throw gateError;
      await mergeWorktreeMock('.', 'branch');
    };

    await merge();
    expect(mergeWorktreeMock).toHaveBeenCalledOnce();
  });

  it('force=true + verdict undefined → mergeWorktree is called', async () => {
    const mergeWorktreeMock = vi.fn().mockResolvedValue(undefined);

    const mission = { judgeVerdict: undefined };
    const gateError = checkApproveGate(mission, { force: true });

    const merge = async () => {
      if (gateError) throw gateError;
      await mergeWorktreeMock('.', 'branch');
    };

    await merge();
    expect(mergeWorktreeMock).toHaveBeenCalledOnce();
  });

  it('unverified mission (no judgeVerdict) blocks approve and allows force merge', async () => {
    const mergeWorktreeMock = vi.fn().mockResolvedValue(undefined);

    const mission = { judgeVerdict: undefined };

    // Step 1: normal approve → blocked
    const gateError = checkApproveGate(mission);
    expect(gateError).toBeInstanceOf(ApproveBlockedError);
    expect(gateError!.reason).toMatch(/Évaluation manquante/);

    // Step 2: force approve → allowed, mergeWorktree called
    const gateErrorForced = checkApproveGate(mission, { force: true });
    const forceApprove = async () => {
      if (gateErrorForced) throw gateErrorForced;
      await mergeWorktreeMock('.', 'branch');
    };

    await forceApprove();
    expect(mergeWorktreeMock).toHaveBeenCalledOnce();
  });

  it('unverified mission block reason differs from red-checks block reason', () => {
    const unverifiedError = checkApproveGate({ judgeVerdict: undefined });
    const redChecksError = checkApproveGate({ judgeVerdict: makeVerdict(false, 20) });

    expect(unverifiedError).toBeInstanceOf(ApproveBlockedError);
    expect(redChecksError).toBeInstanceOf(ApproveBlockedError);

    // The reasons must be non-empty strings and distinct from each other
    expect(unverifiedError!.reason).toBeTruthy();
    expect(redChecksError!.reason).toBeTruthy();
    expect(unverifiedError!.reason).not.toBe(redChecksError!.reason);

    // Unverified message should mention evaluation/verdict
    expect(unverifiedError!.reason).toMatch(/Évaluation manquante/);
    // Red-checks message should mention rejection/score
    expect(redChecksError!.reason).toMatch(/rejeté/);
  });
});

// ── QA fixes: merge — isDiffEmpty / isJudgeRejected ─────────────────

describe('isDiffEmpty', () => {
  it('is true when both diffAdded and diffRemoved are absent', () => {
    expect(isDiffEmpty({})).toBe(true);
  });

  it('is true when both diffAdded and diffRemoved are exactly 0', () => {
    expect(isDiffEmpty({ diffAdded: 0, diffRemoved: 0 })).toBe(true);
  });

  it('is false when diffAdded is non-zero', () => {
    expect(isDiffEmpty({ diffAdded: 5, diffRemoved: 0 })).toBe(false);
  });

  it('is false when diffRemoved is non-zero', () => {
    expect(isDiffEmpty({ diffAdded: 0, diffRemoved: 3 })).toBe(false);
  });
});

describe('isJudgeRejected', () => {
  it('is true for a review mission with passed === false', () => {
    expect(isJudgeRejected({ status: 'review', judgeVerdict: makeVerdict(false) })).toBe(true);
  });

  it('is false for a review mission with passed === true', () => {
    expect(isJudgeRejected({ status: 'review', judgeVerdict: makeVerdict(true) })).toBe(false);
  });

  it('is false for a review mission with no verdict yet (still evaluating)', () => {
    expect(isJudgeRejected({ status: 'review', judgeVerdict: undefined })).toBe(false);
  });

  it('is false for a failed mission even with a rejected verdict (different lifecycle stage)', () => {
    expect(isJudgeRejected({ status: 'failed', judgeVerdict: makeVerdict(false) })).toBe(false);
  });

  it('is false for done/cancelled/queued/running missions', () => {
    expect(isJudgeRejected({ status: 'done', judgeVerdict: makeVerdict(false) })).toBe(false);
    expect(isJudgeRejected({ status: 'cancelled', judgeVerdict: makeVerdict(false) })).toBe(false);
    expect(isJudgeRejected({ status: 'queued' })).toBe(false);
    expect(isJudgeRejected({ status: 'running' })).toBe(false);
  });
});
