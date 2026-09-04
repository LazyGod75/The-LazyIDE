/**
 * canvasMissionLearningCapture.test.ts — brain-integration wave, point 3:
 * "POST-MISSION LEARNING CAPTURE for canvas missions" — verify
 * learningLoop.runLearningLoop still triggers on a TERMINAL mission launched
 * via a canvas path (chain-fired / manager draft-launch), not just a
 * user-launched one.
 *
 * Audit finding: runtime.ts's runMission is ONE function shared by every
 * launch path (agentsStore.tsx's addMission is the sole caller of
 * runMission for a fresh launch, and chainEngine.ts/draftLaunch.ts/the
 * manager's launch_mission executor all funnel through addMission — see
 * chainEngine.ts's attemptFire, draftLaunch.ts's launchDraft). Step G
 * (learning loop, right after Step F's evaluation) runs unconditionally at
 * the end of runMission's own control flow — there is no branch anywhere in
 * runtime.ts keyed on "how was this mission created". This test proves that
 * concretely for a mission whose `agentTask` carries the chain-fired
 * "## CONTEXTE AMONT" marker (chainEngine.ts's buildContextBlock), i.e. a
 * chain-fired-style launch — the same harness as runtimeEvalDiff.test.ts's
 * existing Step-F regression coverage, reused here for Step G.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mission } from '../lib/agents/types';
import type { evaluateMission } from '../lib/agents/evaluator';
import type { runLearningLoop } from '../lib/agents/learningLoop';

let invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

const FAKE_DIFF =
  'diff --git a/README.md b/README.md\n' +
  'index 22e067e..91c36bd 100644\n' +
  '--- a/README.md\n' +
  '+++ b/README.md\n' +
  '@@ -1,3 +1,4 @@\n' +
  ' # alpha\n' +
  '+<!-- canvas-mission-qa -->\n';

function defaultInvokeImpl(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  invokeCalls.push({ cmd, args: args ?? {} });
  if (cmd === 'agent_create_worktree') return Promise.resolve(`/fake/wt/${(args?.branch as string) ?? 'x'}`);
  if (cmd === 'agent_worktree_diff') return Promise.resolve(FAKE_DIFF);
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
  buildPromptBrainContext: vi.fn(() => ''),
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
vi.mock('../lib/agents/evaluator', () => ({
  evaluateMission: (...args: Parameters<typeof evaluateMission>) => evaluateMissionMock(...args),
  deriveJudgesApproved: vi.fn(() => 'approved'),
  // Trust-critical defect #2 (M2 forensics) — runtime.ts's Step C now also
  // imports isVerificationMission to compute mission.emptyDeliverable; a
  // full mock replacement without it makes that call throw `undefined is
  // not a function`, same class of gap formatVerdictScoreLine's own
  // adjacent comment already documents for this file.
  isVerificationMission: vi.fn(() => false),
  // R13 — runtime.ts's action-timeline eval-completion line now calls
  // formatVerdictScoreLine (evaluator.ts); a full mock replacement without
  // it made that call site throw `undefined is not a function` mid-way
  // through the post-evaluation update, before judgeVerdict ever got
  // attached to the mission — which is what made this suite's own
  // `learnedMission.judgeVerdict` assertion fail.
  formatVerdictScoreLine: vi.fn((v: { score: number }) => `${v.score}/100`),
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
  isLearningReady: vi.fn(() => false),
  completeStage: vi.fn((plan: unknown) => plan),
  markExecutionStagesDone: vi.fn((plan: unknown) => plan),
}));

// The one mock that differs from runtimeEvalDiff.test.ts's harness: a real
// spy (not just a resolved-value stub) so this suite can assert Step G
// actually CALLED runLearningLoop, and inspect the mission it was handed.
const runLearningLoopMock = vi.fn<typeof runLearningLoop>(() =>
  Promise.resolve({ summary: 'learned', insights: [], brainCaptured: false }),
);
vi.mock('../lib/agents/learningLoop', () => ({
  runLearningLoop: (...args: Parameters<typeof runLearningLoop>) => runLearningLoopMock(...args),
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
  evaluateMissionMock.mockClear();
  runLearningLoopMock.mockClear();
});

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

// The exact upstream-context marker chainEngine.ts's buildContextBlock
// appends to a fired draft's task — reproduced verbatim so this mission
// looks exactly like one launched through the chain-fire path (agentsStore's
// addMission receives `agentTask: \`${draft.task}${contextBlock}\``).
const CHAIN_FIRED_AGENT_TASK =
  'review the diff' +
  '\n\n## CONTEXTE AMONT\nMission « Implement feature » terminée (done).\nsome timeline text';

describe('runMission — Step G (learning loop) relocated to approve time (Phase 4)', () => {
  it('does NOT call runLearningLoop during runMission (review status) — learning now fires at approve time', async () => {
    const { runMission } = await import('../lib/agents/runtime');
    const mission: Mission = {
      id: 'M-canvas-1',
      title: 'Chain-fired mission',
      status: 'running',
      model: 'claude-sonnet',
      agentTask: CHAIN_FIRED_AGENT_TASK,
      contract: baseContract,
    } as Mission;

    await runMission(mission, '/fake/repo', { onUpdate: () => {}, stopSignal: () => false });

    expect(invokeCalls.some((c) => c.cmd === 'agent_worktree_diff')).toBe(true);
    expect(evaluateMissionMock).toHaveBeenCalledTimes(1);
    // Phase 4: runLearningLoop is NOT called during runMission anymore —
    // it was relocated to approveMission in agentsStore.tsx. The review
    // state means "awaiting human decision" — capturing lessons before
    // the human has decided is premature.
    expect(runLearningLoopMock).toHaveBeenCalledTimes(0);
  });

  it('does NOT call runLearningLoop when evaluateMission itself rejects either (Phase 4 — learning fires at approve time only)', async () => {
    evaluateMissionMock.mockRejectedValueOnce(new Error('evaluator crashed'));
    const { runMission } = await import('../lib/agents/runtime');
    const mission: Mission = {
      id: 'M-canvas-2',
      title: 'Chain-fired mission (eval failure)',
      status: 'running',
      model: 'claude-sonnet',
      agentTask: CHAIN_FIRED_AGENT_TASK,
      contract: baseContract,
    } as Mission;

    await runMission(mission, '/fake/repo', { onUpdate: () => {}, stopSignal: () => false });

    // Phase 4: runLearningLoop is NOT called during runMission even when
    // evaluateMission rejects — learning fires at approveMission only.
    expect(runLearningLoopMock).toHaveBeenCalledTimes(0);
  });
});
