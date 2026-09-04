/**
 * runtimeEvalDiff.test.ts
 *
 * Regression test for the "evaluator sees an empty diff despite a real,
 * successful implementation" defect (2026-07 in-app QA, runs 8/9 on
 * feat/cockpit-v2): runMission's Step C (runtime.ts) computes the real
 * worktree diff into LOCAL variables (diffSnippet/diffAdded/diffRemoved/
 * diffFiles) and pushes them to the store via onUpdate() — but Step F used
 * to call evaluateMission() with the function's own ORIGINAL `mission`
 * parameter, which is never mutated and was never merged with those local
 * variables. evaluator.ts's diffContext falls back to `Mission: ${title}`
 * whenever mission.diffSnippet is falsy, so every evaluator sub-agent
 * (tester/reviewer/security/judge) saw only the mission title restated as
 * if it were the diff — and correctly reported "the diff contains no
 * actual code changes", even though the UI's own mission card showed the
 * real, correct diff (computed by this exact same Step C, just never
 * threaded through to evaluateMission's argument). Confirmed on-disk: the
 * mission's saved artifact (.lazy/artifacts/<id>.json) showed
 * `"diffSnippet": []` while missions.json's store-side copy of the same
 * mission had the real diff.
 *
 * This test proves evaluateMission is now called with a mission object
 * whose diffSnippet/diffAdded/diffFiles carry the REAL diff Step C computed
 * from the worktree, not the mission's pre-diff starting state.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mission } from '../lib/agents/types';
import type { evaluateMission, isVerificationMission } from '../lib/agents/evaluator';

let invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

const FAKE_DIFF =
  'diff --git a/README.md b/README.md\n' +
  'index 22e067e..91c36bd 100644\n' +
  '--- a/README.md\n' +
  '+++ b/README.md\n' +
  '@@ -1,3 +1,4 @@\n' +
  ' # alpha\n' +
  '+<!-- qa-check -->\n';

// M2 forensics — overridable so a test can simulate a mission whose
// worktree diff is genuinely empty (M2's exact shape: `git diff` returns
// nothing at all), instead of always resolving FAKE_DIFF. Reset to
// `undefined` (-> FAKE_DIFF) in beforeEach.
let worktreeDiffOverride: string | undefined;

function defaultInvokeImpl(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  invokeCalls.push({ cmd, args: args ?? {} });
  if (cmd === 'agent_create_worktree') return Promise.resolve(`/fake/wt/${(args?.branch as string) ?? 'x'}`);
  if (cmd === 'agent_worktree_diff') return Promise.resolve(worktreeDiffOverride ?? FAKE_DIFF);
  if (cmd === 'agent_merge_worktree') return Promise.resolve('fake-merge-sha');
  if (cmd === 'agent_discard_worktree') return Promise.resolve(undefined);
  if (cmd === 'agent_run') return Promise.resolve(undefined);
  if (cmd === 'agent_run_kill') return Promise.resolve(undefined);
  return Promise.resolve(undefined);
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => defaultInvokeImpl(cmd, args)),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((_event: string, callback: () => void) => {
    // Immediately invoke the callback so the child finished promise resolves
    // (mirrors orchestratorParallel.test.ts's event mock).
    callback();
    return Promise.resolve(() => undefined);
  }),
}));

vi.mock('../lib/platform', () => ({
  getPlatform: () => 'desktop',
  isTauri: () => true,
}));

vi.mock('../lib/journal/journal', () => ({
  emitEvent: vi.fn(() => Promise.resolve(0)),
  emitBuffered: vi.fn(() => Promise.resolve(0)),
}));

vi.mock('../lib/journal/projectId', () => ({
  projectIdFromRoot: vi.fn(() => 'test-project-id'),
}));

vi.mock('../lib/brain/context', () => ({
  buildPromptBrainContext: vi.fn(() => Promise.resolve('')),
  normalizeRecall: vi.fn(() => null),
}));

vi.mock('../lib/models/index', () => ({
  getProviderMode: vi.fn(() => 'native'),
  hasManagedCreditsActive: vi.fn(() => false),
  getProPlanState: vi.fn(() => ({ active: false, credits: 0 })),
  isCliBackendAvailable: vi.fn(() => true),
}));

vi.mock('../lib/models/systemPrompts', () => ({ RECALL_TEACHING: '' }));

vi.mock('../lib/models/brainSearchLoop', () => ({
  withTimeout: vi.fn(<T>(p: Promise<T>) => p),
  BRAIN_RECALL_TIMEOUT_MS: 5000,
}));

const evaluateMissionMock = vi.fn<typeof evaluateMission>(() =>
  Promise.resolve({
    score: 80,
    passed: true,
    risk: 'low' as const,
    reviewers: [],
    createdAt: new Date().toISOString(),
  }),
);
// Trust-critical defect #2 (M2 forensics) — a plain `vi.fn()` (not the real
// isVerificationMission) so individual tests below can control whether
// runtime.ts's Step C treats the mission as a legitimate diff-less
// verification/investigation task. Defaults to `false` (not a verification
// mission) so every EXISTING test in this file — none of which set a
// verification-flavored title — keeps exercising the "should have produced
// code" path unchanged.
const isVerificationMissionMock = vi.fn<typeof isVerificationMission>(() => false);
vi.mock('../lib/agents/evaluator', () => ({
  evaluateMission: (...args: Parameters<typeof evaluateMission>) => evaluateMissionMock(...args),
  deriveJudgesApproved: vi.fn(() => 'approved'),
  // R13 — see canvasMissionLearningCapture.test.ts's matching comment:
  // runtime.ts's action-timeline eval-completion line now calls
  // formatVerdictScoreLine (evaluator.ts) — a full mock replacement without
  // it throws mid-update.
  formatVerdictScoreLine: vi.fn((v: { score: number }) => `${v.score}/100`),
  isVerificationMission: (...args: Parameters<typeof isVerificationMission>) => isVerificationMissionMock(...args),
}));

vi.mock('../lib/agents/diffParse', () => ({
  parseDiffFiles: vi.fn(() => [{ filename: 'README.md', added: 1, removed: 0 }]),
}));
vi.mock('../lib/agents/stageContract', () => ({
  compilePlan: vi.fn(() => ({
    brainAdapted: false,
    adaptations: [],
    graph: { stages: [{ kind: 'implement', attemptCount: 0 }] },
  })),
  planToSteps: vi.fn(() => []),
}));
vi.mock('../lib/agents/learningLoop', () => ({
  runLearningLoop: vi.fn(() => Promise.resolve({ summary: '', insights: [] })),
}));
vi.mock('../lib/agents/artifacts', () => ({ saveArtifacts: vi.fn(() => Promise.resolve()) }));
vi.mock('../lib/agents/recovery', () => ({
  evaluateRecovery: vi.fn(() => ({ shouldRecover: false })),
  delayMs: vi.fn(() => 0),
}));
vi.mock('../lib/agents/managedAgent', () => ({ planAndActManaged: vi.fn() }));
vi.mock('../lib/agents/proofs', () => ({
  parseProofBlocks: vi.fn(() => []),
  buildProofContractBlock: vi.fn(() => ''),
  PROOF_KINDS: ['screenshot', 'test_run', 'e2e_recording', 'command_output', 'behavior_diff'],
}));
vi.mock('../lib/agents/launchLog', () => ({
  launchPhaseEnter: vi.fn(),
  launchPhaseExit: vi.fn(),
  launchPhaseError: vi.fn(),
}));
vi.mock('../lib/models/accessSettings', () => ({ loadAccessSettings: vi.fn(() => ({})) }));
vi.mock('../lib/models/openrouterCatalog', () => ({ DEFAULT_OPENROUTER_MODEL_ID: 'default/model', isOpenRouterFreeModel: vi.fn(() => false) }));
vi.mock('../lib/agents/agentSessionGate', () => ({ gateAgentSession: vi.fn(async () => ({ ok: true, rail: 'cli' })) }));

beforeEach(() => {
  invokeCalls = [];
  worktreeDiffOverride = undefined;
  evaluateMissionMock.mockClear();
  isVerificationMissionMock.mockReset().mockReturnValue(false);
});

const baseMission = (overrides: Partial<Mission>): Mission =>
  ({
    id: 'M-test',
    title: 'QA append README line',
    status: 'running',
    model: 'claude-sonnet',
    ...overrides,
  }) as Mission;

const baseContract = {
  objective: 'test',
  model: 'claude-sonnet',
  permissionMode: 'acceptEdits' as const,
  budgetCapUsd: 10,
  proofs: [],
  gates: { evaluators: false, humanApprove: false },
  shareToTeam: false,
  parentDepth: 0,
};

describe('runMission — Step F passes the real Step C diff to evaluateMission', () => {
  it('evaluateMission receives diffSnippet/diffAdded/diffFiles from the worktree diff, not the stale pre-diff mission', async () => {
    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({ contract: baseContract });

    await runMission(mission, '/fake/repo', { onUpdate: () => {}, stopSignal: () => false });

    expect(invokeCalls.some((c) => c.cmd === 'agent_worktree_diff')).toBe(true);
    expect(evaluateMissionMock).toHaveBeenCalledTimes(1);

    const missionArg = evaluateMissionMock.mock.calls[0]?.[0] as Mission;
    expect(missionArg.diffSnippet).toBeDefined();
    expect((missionArg.diffSnippet ?? []).join('\n')).toContain('+<!-- qa-check -->');
    expect(missionArg.diffAdded).toBe(1);
    expect(missionArg.diffFiles).toEqual([{ filename: 'README.md', added: 1, removed: 0 }]);
    // Real content on the diff -> never flagged as an empty deliverable.
    expect(missionArg.emptyDeliverable).toBe(false);
  });
});

// ── Trust-critical defect #2 (M2 forensics) — Step C's emptyDeliverable ────
//
// Mission M2 ("Consolider la base de code sur une branche de travail…")
// left a worktree with ZERO commits and a completely empty `git diff` — not
// merely a diff missing some files (diffIncompleteFiles' concern), but
// nothing at all. runtime.ts's Step C must flag this (mission.emptyDeliverable
// = true) so evaluator.ts's evaluateMission refuses to run the judge
// pipeline against it — UNLESS the mission reads as a legitimate diff-less
// verification/investigation task (isVerificationMission), in which case a
// diff-less mission is expected by design and must run normally.

describe('runMission — Step C computes emptyDeliverable (trust-critical defect #2, M2 forensics)', () => {
  it('flags a diff-less, non-verification mission as emptyDeliverable — M2 repro (worktree diff is entirely empty)', async () => {
    worktreeDiffOverride = '';
    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({
      title: 'Consolider la base de code sur une branche de travail : intégrer le scaffold de M40',
      contract: baseContract,
    });

    await runMission(mission, '/fake/repo', { onUpdate: () => {}, stopSignal: () => false });

    expect(evaluateMissionMock).toHaveBeenCalledTimes(1);
    const missionArg = evaluateMissionMock.mock.calls[0]?.[0] as Mission;
    expect(missionArg.diffFiles).toEqual([]);
    expect(missionArg.diffSnippet).toEqual([]);
    expect(missionArg.diffAdded).toBe(0);
    expect(missionArg.diffRemoved).toBe(0);
    expect(missionArg.emptyDeliverable).toBe(true);
  });

  it('does NOT flag a diff-less mission as emptyDeliverable when it reads as a legitimate verification/investigation task', async () => {
    worktreeDiffOverride = '';
    isVerificationMissionMock.mockReturnValue(true);
    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({
      title: 'Vérifier que le build passe',
      contract: baseContract,
    });

    await runMission(mission, '/fake/repo', { onUpdate: () => {}, stopSignal: () => false });

    const missionArg = evaluateMissionMock.mock.calls[0]?.[0] as Mission;
    expect(missionArg.diffFiles).toEqual([]);
    expect(missionArg.emptyDeliverable).toBe(false);
  });
});
