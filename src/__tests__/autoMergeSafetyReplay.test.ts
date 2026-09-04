/**
 * autoMergeSafetyReplay.test.ts — W-PROVE deterministic safety-matrix replay
 * for the auto-merge engine (approveGate.ts's evaluateAutoMerge, wired
 * through agentsStore.tsx's REAL triggerAutoMergeIfEligible/updateMission/
 * approveMission). Stands in for (and is stronger than) a single live run:
 * every scenario below drives the REAL store through the SAME multi-step
 * journal-event sequence runtime.ts's own native mission lifecycle produces
 * (see that file's own "Step D / Step F" comments), rather than a single
 * combined patch — so a premature-merge bug that only a REAL timeline gap
 * would expose cannot hide behind an artificially-collapsed test fixture.
 *
 * createElement (not JSX) — this file is .ts, matching this task's brief
 * (see recoveryReplay.test.ts for the established precedent in this repo).
 *
 * Minimal mocking, same convention as agentsStore.approvalModes.test.tsx
 * (the sibling end-to-end coverage file for this same engine):
 *   - captureAgentMission (brain) — irrelevant side effect, silenced.
 *   - runMission — the native/managed agent LOOP itself is not under test
 *     here (no real CLI/subprocess in a unit test); every status/verdict
 *     transition below is injected via updateMission, the exact same public
 *     choke point runMission's own onUpdate callback (applyRunUpdate) feeds.
 *   - mergeWorktree/discardWorktree — the actual git/filesystem side effect
 *     approveMission performs; asserting on this mock is how "approveMission
 *     was called" is observed without a real repo.
 * approveGate.ts's checkApproveGate/evaluateAutoMerge and agentsStore.tsx's
 * triggerAutoMergeIfEligible/approveMission themselves are the REAL,
 * unmocked code under test.
 *
 * BUG FOUND + FIXED by this replay (see approveGate.ts's
 * isEvaluationSettledUnavailable doc comment): full_auto's "inconclusive
 * evaluation" fallback used to treat ANY absent judgeVerdict as grounds to
 * force-merge — including the ordinary window between runtime.ts's Step D
 * (diff computed -> status 'review', verdict undefined) and Step F's own
 * verdict arriving (a real gap: Step F spawns tester/reviewer/security/
 * judge sub-agent runs). That collapsed "hasn't reported back yet" into
 * "genuinely inconclusive", which would force-merge EVERY full_auto mission
 * the instant its diff was computed — before a single evaluator sub-agent
 * had even run, making the documented hard floor (never a security reject,
 * never a real conclusive rejection) unreachable in the real timeline. Fixed
 * in approveGate.ts; the full_auto tests below replay the CORRECT sequence
 * (review with no verdict -> evaluation starts -> verdict/settled-outcome
 * lands) and prove the floor now actually holds across that gap.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React from 'react';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { mergeWorktree } from '../lib/agents/runtime';
import { emitBuffered } from '../lib/journal/journal';
import { setApprovalMode, _resetApprovalModesForTests } from '../lib/agents/approvalMode';
import type { JudgeVerdict, Mission, MissionContract, ReviewerVerdict } from '../lib/agents/types';

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
    mergeWorktree: vi.fn().mockResolvedValue(undefined),
    discardWorktree: vi.fn().mockResolvedValue(undefined),
  };
});

// emitBuffered wrapped in a spy over the REAL implementation — needed to
// assert the mission.approved journal payload's actor/mode fields for the
// "merges" case without disabling real journal buffering.
vi.mock('../lib/journal/journal', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/journal/journal')>();
  return {
    ...actual,
    emitBuffered: vi.fn(actual.emitBuffered),
  };
});

const mockedMergeWorktree = vi.mocked(mergeWorktree);

function simulateTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}
function clearTauriSimulation(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

function wrapper({ children }: { children: React.ReactNode }) {
  return React.createElement(
    I18nProvider,
    null,
    React.createElement(ToastProvider, null, React.createElement(AgentsStoreProvider, null, children)),
  );
}

// ── Fixture builders ─────────────────────────────────────────────────

function reviewer(role: ReviewerVerdict['role'], verdict: ReviewerVerdict['verdict'], summary = ''): ReviewerVerdict {
  return { role, verdict, summary };
}

function passingVerdict(overrides: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return {
    score: 93,
    passed: true,
    risk: 'low',
    reviewers: [reviewer('tester', 'approve'), reviewer('reviewer', 'approve'), reviewer('security', 'approve')],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function rejectedVerdict(overrides: Partial<JudgeVerdict> = {}): JudgeVerdict {
  return {
    score: 28,
    passed: false,
    risk: 'high',
    reviewers: [reviewer('tester', 'request_changes'), reviewer('reviewer', 'reject')],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function contract(overrides: Partial<MissionContract> = {}): MissionContract {
  return {
    objective: 'Replay safety-matrix fixture',
    model: 'sonnet',
    permissionMode: 'acceptEdits',
    budgetCapUsd: 50,
    proofs: [],
    gates: { evaluators: true, humanApprove: false },
    shareToTeam: false,
    ...overrides,
  };
}

// ── Real-store helpers — a realistic multi-step mission lifecycle ───────
//
// Mirrors runtime.ts's own documented status diagram (runMission's header):
//   queued -> running (Step A/B) -> review (Step D, diff computed, NO
//   verdict yet) -> [Step F starts: "Évaluation en cours…", still no
//   verdict] -> verdict lands (Step F resolves) OR judgesApproved:
//   'évaluation indisponible' (Step F's catch — evaluateMission() itself
//   threw) -> done (approveMission) | failed (agent error path).
//
// Every step below goes through the SAME public `updateMission` choke
// point applyRunUpdate (runMission's real onUpdate callback) also uses —
// see agentsStore.tsx's own doc comment on triggerAutoMergeIfEligible for
// why both choke points re-check eligibility on every such patch.

type StoreHandle = { current: ReturnType<typeof useAgentsStore> };

async function launchMission(
  result: StoreHandle,
  title: string,
  contractOverrides: Partial<MissionContract> = {},
): Promise<string> {
  await act(async () => {
    await result.current.addMission({
      title,
      repo: '.',
      worktree: `agent/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      modelLabel: 'claude-sonnet-5',
      mode: 'agent',
      orchestrator: false,
      contract: contract(contractOverrides),
    });
  });
  return result.current.missions[result.current.missions.length - 1].id;
}

async function patch(result: StoreHandle, missionId: string, fields: Partial<Mission>): Promise<void> {
  await act(async () => {
    result.current.updateMission({ id: missionId, patch: fields });
    // Let the auto-merge microtask chain (resolveProjectRoot().then(...))
    // drain before the next step / assertion.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/** Step A/B — agent loop running, real progress ticks. */
async function stepRunning(result: StoreHandle, missionId: string): Promise<void> {
  await patch(result, missionId, { status: 'running', progress: 40, liveAction: 'écrit les fichiers…' });
}

/** Step D — diff computed, transitions to 'review' with NO verdict yet
 *  (runtime.ts explicitly resets judgesApproved: undefined here too). */
async function stepReachReviewPendingVerdict(result: StoreHandle, missionId: string): Promise<void> {
  await patch(result, missionId, {
    status: 'review',
    progress: 100,
    liveAction: undefined,
    diffAdded: 58,
    diffRemoved: 11,
    judgesApproved: undefined,
  });
}

/** Step F (start) — evaluation pipeline begins; still no verdict. */
async function stepEvaluationStarts(result: StoreHandle, missionId: string): Promise<void> {
  await patch(result, missionId, { liveAction: 'Évaluation en cours…' });
}

/** Step F (resolves) — the real verdict lands. */
async function stepVerdictArrives(result: StoreHandle, missionId: string, verdict: JudgeVerdict, extra: Partial<Mission> = {}): Promise<void> {
  await patch(result, missionId, { judgeVerdict: verdict, liveAction: undefined, ...extra });
}

/** Step F (catch) — evaluateMission() itself threw; runtime.ts's own
 *  "no verdict is ever coming" marker, verbatim. */
async function stepEvaluationSettledUnavailable(result: StoreHandle, missionId: string): Promise<void> {
  await patch(result, missionId, { judgesApproved: 'évaluation indisponible', liveAction: undefined });
}

function currentMission(result: StoreHandle, missionId: string): Mission {
  const found = result.current.missions.find((m) => m.id === missionId);
  if (!found) throw new Error(`mission ${missionId} not found`);
  return found;
}

beforeEach(() => {
  _resetApprovalModesForTests();
  localStorage.clear();
  simulateTauri();
  mockedMergeWorktree.mockReset().mockResolvedValue('mock-merge-sha');
  vi.mocked(emitBuffered).mockClear();
});

afterEach(() => {
  clearTauriSimulation();
  _resetApprovalModesForTests();
  localStorage.clear();
});

// ── The matrix ────────────────────────────────────────────────────────

describe('W-PROVE — auto-merge safety replay matrix', () => {
  describe('auto_green', () => {
    it('reaches review with judge PASSED -> merges (approveMission called, actor "auto")', async () => {
      await setApprovalMode('auto_green');
      const { result } = renderHook(() => useAgentsStore(), { wrapper });
      const missionId = await launchMission(result, 'auto_green happy path');

      await stepRunning(result, missionId);
      await stepReachReviewPendingVerdict(result, missionId);
      // No verdict yet — must NOT merge prematurely.
      expect(currentMission(result, missionId).status).toBe('review');
      expect(mockedMergeWorktree).not.toHaveBeenCalled();

      await stepEvaluationStarts(result, missionId);
      expect(currentMission(result, missionId).status).toBe('review');
      expect(mockedMergeWorktree).not.toHaveBeenCalled();

      await stepVerdictArrives(result, missionId, passingVerdict());

      const mission = currentMission(result, missionId);
      expect(mission.status).toBe('done');
      expect(mission.merged).toBe(true);
      expect(mockedMergeWorktree).toHaveBeenCalledTimes(1);

      const approvedCall = vi.mocked(emitBuffered).mock.calls.find(
        ([evt]) => evt.type === 'mission.approved' && evt.missionId === missionId,
      );
      expect(approvedCall).toBeDefined();
      const payload = approvedCall![0].payload as { actor?: string; mode?: string };
      expect(payload.actor).toBe('auto');
      expect(payload.mode).toBe('auto_green');
    });

    it('judge REJECTED (passed:false, real score) -> NEVER merges', async () => {
      await setApprovalMode('auto_green');
      const { result } = renderHook(() => useAgentsStore(), { wrapper });
      const missionId = await launchMission(result, 'auto_green judge rejected');

      await stepRunning(result, missionId);
      await stepReachReviewPendingVerdict(result, missionId);
      await stepEvaluationStarts(result, missionId);
      await stepVerdictArrives(result, missionId, rejectedVerdict());

      const mission = currentMission(result, missionId);
      expect(mission.status).toBe('review');
      expect(mission.merged).not.toBe(true);
      expect(mockedMergeWorktree).not.toHaveBeenCalled();
    });

    it('security-reviewer conclusive reject -> NEVER merges, even though the overall verdict says passed', async () => {
      await setApprovalMode('auto_green');
      const { result } = renderHook(() => useAgentsStore(), { wrapper });
      const missionId = await launchMission(result, 'auto_green security reject');

      await stepRunning(result, missionId);
      await stepReachReviewPendingVerdict(result, missionId);
      await stepEvaluationStarts(result, missionId);
      await stepVerdictArrives(
        result,
        missionId,
        passingVerdict({ reviewers: [reviewer('security', 'reject', 'Secret AWS en dur détecté dans le diff.')] }),
      );

      const mission = currentMission(result, missionId);
      expect(mission.status).toBe('review');
      expect(mockedMergeWorktree).not.toHaveBeenCalled();
    });

    it('required proof (test_run) missing -> NEVER merges', async () => {
      await setApprovalMode('auto_green');
      const { result } = renderHook(() => useAgentsStore(), { wrapper });
      const missionId = await launchMission(result, 'auto_green missing proof', {
        proofs: [{ kind: 'test_run', label: 'Suite de tests' }],
      });

      await stepRunning(result, missionId);
      await stepReachReviewPendingVerdict(result, missionId);
      await stepEvaluationStarts(result, missionId);
      // Verdict lands clean, but the agent never attached the required
      // test_run proof (mission.proofs stays empty) — the Done gate blocks.
      await stepVerdictArrives(result, missionId, passingVerdict());

      const mission = currentMission(result, missionId);
      expect(mission.proofs ?? []).toHaveLength(0);
      expect(mission.status).toBe('review');
      expect(mockedMergeWorktree).not.toHaveBeenCalled();
    });
  });

  describe('full_auto', () => {
    it('evaluation pipeline genuinely unavailable (evaluateMission threw) -> merges WITH force', async () => {
      await setApprovalMode('full_auto');
      const { result } = renderHook(() => useAgentsStore(), { wrapper });
      const missionId = await launchMission(result, 'full_auto inconclusive');

      await stepRunning(result, missionId);
      await stepReachReviewPendingVerdict(result, missionId);
      // Pending — must NOT merge yet (the Step D/Step F race fix).
      expect(currentMission(result, missionId).status).toBe('review');
      expect(mockedMergeWorktree).not.toHaveBeenCalled();

      await stepEvaluationStarts(result, missionId);
      expect(currentMission(result, missionId).status).toBe('review');
      expect(mockedMergeWorktree).not.toHaveBeenCalled();

      await stepEvaluationSettledUnavailable(result, missionId);

      const mission = currentMission(result, missionId);
      expect(mission.status).toBe('done');
      expect(mission.merged).toBe(true);
      expect(mockedMergeWorktree).toHaveBeenCalledTimes(1);
    });

    it('status FAILED (a genuine run failure) -> NEVER merges — the hard floor', async () => {
      await setApprovalMode('full_auto');
      const { result } = renderHook(() => useAgentsStore(), { wrapper });
      const missionId = await launchMission(result, 'full_auto failed run');

      await stepRunning(result, missionId);
      await patch(result, missionId, { status: 'failed', statusReason: 'Build échoué — 3 tentatives épuisées.' });

      const mission = currentMission(result, missionId);
      expect(mission.status).toBe('failed');
      expect(mission.merged).not.toBe(true);
      expect(mockedMergeWorktree).not.toHaveBeenCalled();
    });

    it('security-reviewer conclusive reject -> NEVER merges — the floor holds even in full_auto', async () => {
      await setApprovalMode('full_auto');
      const { result } = renderHook(() => useAgentsStore(), { wrapper });
      const missionId = await launchMission(result, 'full_auto security floor');

      await stepRunning(result, missionId);
      await stepReachReviewPendingVerdict(result, missionId);
      await stepEvaluationStarts(result, missionId);
      await stepVerdictArrives(
        result,
        missionId,
        passingVerdict({ reviewers: [reviewer('security', 'reject', 'Injection SQL non paramétrée.')] }),
      );

      const mission = currentMission(result, missionId);
      expect(mission.status).toBe('review');
      expect(mockedMergeWorktree).not.toHaveBeenCalled();
    });

    it('contract.gates.humanApprove === true -> NEVER merges, even with a clean passing verdict — per-mission opt-out always wins', async () => {
      await setApprovalMode('full_auto');
      const { result } = renderHook(() => useAgentsStore(), { wrapper });
      const missionId = await launchMission(result, 'full_auto human-approve opt-out', {
        gates: { evaluators: true, humanApprove: true },
      });

      await stepRunning(result, missionId);
      await stepReachReviewPendingVerdict(result, missionId);
      // Even the "pending" state must stay blocked by the opt-out, not just
      // eventually.
      expect(currentMission(result, missionId).status).toBe('review');
      expect(mockedMergeWorktree).not.toHaveBeenCalled();

      await stepEvaluationStarts(result, missionId);
      await stepVerdictArrives(result, missionId, passingVerdict()); // would otherwise be a clean green-path merge

      const mission = currentMission(result, missionId);
      expect(mission.status).toBe('review');
      expect(mockedMergeWorktree).not.toHaveBeenCalled();
    });
  });

  describe('budget cap — hard floor in every auto mode', () => {
    it('auto_green never merges once spend crosses budgetCapUsd, even with a clean passing verdict', async () => {
      await setApprovalMode('auto_green');
      const { result } = renderHook(() => useAgentsStore(), { wrapper });
      const missionId = await launchMission(result, 'auto_green budget exceeded', { budgetCapUsd: 10 });

      await stepRunning(result, missionId);
      // Cost accumulates live during the run, same as a real mission's
      // totalCost ticks upward across progress updates.
      await patch(result, missionId, { totalCost: '$14.50' });
      await stepReachReviewPendingVerdict(result, missionId);
      await stepEvaluationStarts(result, missionId);
      await stepVerdictArrives(result, missionId, passingVerdict());

      const mission = currentMission(result, missionId);
      expect(mission.status).toBe('review');
      expect(mockedMergeWorktree).not.toHaveBeenCalled();
    });

    it('full_auto never merges once spend crosses budgetCapUsd — the floor holds even in full_auto', async () => {
      await setApprovalMode('full_auto');
      const { result } = renderHook(() => useAgentsStore(), { wrapper });
      const missionId = await launchMission(result, 'full_auto budget exceeded', { budgetCapUsd: 10 });

      await stepRunning(result, missionId);
      await patch(result, missionId, { totalCost: '$25.00' });
      await stepReachReviewPendingVerdict(result, missionId);
      // Budget alone must block even the "pending, no verdict" state — it's
      // checked before the verdict-shaped branches in evaluateAutoMerge.
      expect(currentMission(result, missionId).status).toBe('review');
      expect(mockedMergeWorktree).not.toHaveBeenCalled();

      await stepEvaluationStarts(result, missionId);
      await stepVerdictArrives(result, missionId, passingVerdict());

      const mission = currentMission(result, missionId);
      expect(mission.status).toBe('review');
      expect(mockedMergeWorktree).not.toHaveBeenCalled();
    });
  });

  describe('mode flip mid-review — no retroactive merge', () => {
    it('a mission already waiting in review when the mode flips to auto is NOT retroactively merged by the flip alone', async () => {
      // Starts in the default 'manual' mode — no setApprovalMode call yet.
      const { result } = renderHook(() => useAgentsStore(), { wrapper });
      const missionId = await launchMission(result, 'mode flip no retro-merge');

      await stepRunning(result, missionId);
      await stepReachReviewPendingVerdict(result, missionId);
      await stepEvaluationStarts(result, missionId);
      await stepVerdictArrives(result, missionId, passingVerdict());

      // Manual mode: a clean passing verdict alone never auto-merges.
      expect(currentMission(result, missionId).status).toBe('review');
      expect(mockedMergeWorktree).not.toHaveBeenCalled();

      // The flip itself must not touch this already-waiting mission.
      await act(async () => {
        await setApprovalMode('auto_green');
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(currentMission(result, missionId).status).toBe('review');
      expect(mockedMergeWorktree).not.toHaveBeenCalled();

      // A LATER real patch to the SAME mission re-checks eligibility and
      // merges — this is the only path that's allowed to.
      await patch(result, missionId, { liveAction: undefined });

      const mission = currentMission(result, missionId);
      expect(mission.status).toBe('done');
      expect(mission.merged).toBe(true);
      expect(mockedMergeWorktree).toHaveBeenCalledTimes(1);
    });
  });
});
