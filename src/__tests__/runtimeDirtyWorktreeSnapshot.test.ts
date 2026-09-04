/**
 * runtimeDirtyWorktreeSnapshot.test.ts
 *
 * Regression test for the "worktree diff is genuinely empty" defect (M3
 * forensics): an implementer that writes real files but never commits them
 * inside its own worktree leaves them untracked/modified — invisible to any
 * git operation that assumes a clean commit exists, and easy to lose to a
 * later discard/checkout/crash. runtime.ts's Step C now stages and commits a
 * dirty worktree (excluding Lazy's own .lazy/.lazybrain infra paths) via the
 * existing git_stage/git_commit Tauri primitives right after the mission
 * diff is computed, so the deliverable is durably captured before Step F's
 * evaluation runs. A clean worktree (implementer already committed, or
 * genuinely produced nothing) is untouched — no git.stage/git.commit call at
 * all, same as before this fix.
 *
 * Mirrors runtimeEvalDiff.test.ts's mock setup (kept in its own file rather
 * than added there so this test's getPlatform() mock — which needs a real
 * `git` sub-object — never leaks into that file's unrelated tests).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mission } from '../lib/agents/types';
import type { evaluateMission } from '../lib/agents/evaluator';
import type { GitFile, Git } from '../lib/platform';
import { planAndActManaged } from '../lib/agents/managedAgent';
import type { PlanAndActManagedOpts } from '../lib/agents/managedAgent';
import { hasManagedCreditsActive } from '../lib/models/index';

let invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

const FAKE_DIFF =
  'diff --git a/README.md b/README.md\n' +
  'index 22e067e..91c36bd 100644\n' +
  '--- a/README.md\n' +
  '+++ b/README.md\n' +
  '@@ -1,3 +1,4 @@\n' +
  ' # alpha\n' +
  '+<!-- qa-check -->\n';

// Overridable per-test (mirrors runtimeEvalDiff.test.ts) — lets the
// max-steps-graceful-fallthrough tests below simulate a worktree whose real
// `git diff` is genuinely empty, instead of always resolving FAKE_DIFF.
// Reset to `undefined` (-> FAKE_DIFF) in beforeEach.
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
  // Only the `agent://done/…` listener fires, with a well-formed
  // AgentDoneEvent payload (mirrors evaluator.test.ts's mockAgentRunDone) —
  // the step/error listeners are registered but never invoked, since a
  // bare no-arg callback() would crash stepHandler/errorHandler's own
  // `event.payload` destructuring (they expect a real event object, not
  // undefined).
  listen: vi.fn((eventName: string, callback: (event: { payload: unknown }) => void) => {
    if (eventName.startsWith('agent://done/')) {
      Promise.resolve().then(() => callback({ payload: { result: '', exit_code: 0 } }));
    }
    return Promise.resolve(() => undefined);
  }),
}));

// Overridable per-test — set before calling runMission.
let statusFiles: GitFile[] = [];
const gitStatusMock = vi.fn<Git['status']>(() =>
  Promise.resolve({ branch: 'agent/m-test', ahead: 0, behind: 0, files: statusFiles }),
);
const gitStageMock = vi.fn<Git['stage']>(() => Promise.resolve(undefined));
const gitCommitMock = vi.fn<Git['commit']>(() => Promise.resolve(undefined));

vi.mock('../lib/platform', () => ({
  getPlatform: () => ({
    git: { status: gitStatusMock, stage: gitStageMock, commit: gitCommitMock },
  }),
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
vi.mock('../lib/agents/evaluator', () => ({
  evaluateMission: (...args: Parameters<typeof evaluateMission>) => evaluateMissionMock(...args),
  deriveJudgesApproved: vi.fn(() => 'approved'),
  formatVerdictScoreLine: vi.fn((v: { score: number }) => `${v.score}/100`),
  isVerificationMission: vi.fn(() => false),
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

/** Toggle the global flag runtime.ts's own isTauriRuntime() reads. */
function setTauriRuntime(active: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (active) {
    w['__TAURI_INTERNALS__'] = {};
  } else {
    delete w['__TAURI_INTERNALS__'];
  }
}

const mockedPlanAndActManaged = planAndActManaged as ReturnType<typeof vi.fn>;
const mockedHasManagedCreditsActive = hasManagedCreditsActive as ReturnType<typeof vi.fn>;

beforeEach(() => {
  invokeCalls = [];
  statusFiles = [];
  worktreeDiffOverride = undefined;
  gitStatusMock.mockClear();
  gitStageMock.mockClear();
  gitCommitMock.mockClear();
  evaluateMissionMock.mockClear();
  // Inert by default (matches the vi.mock factory's plain vi.fn()) — the
  // existing native-path tests in this file never reach the managed engine,
  // so this only matters for the max-steps-graceful describe block below.
  mockedPlanAndActManaged.mockReset();
  mockedHasManagedCreditsActive.mockReset().mockReturnValue(false);
  setTauriRuntime(true);
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

describe('runMission — Step C: dirty worktree auto-commit before diff (M3 forensics)', () => {
  it('stages and commits untracked/modified files when the worktree is dirty at diff time', async () => {
    statusFiles = [
      { path: 'src/newFile.ts', status: '?' },
      { path: 'README.md', status: 'M' },
    ];
    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({ contract: baseContract });

    await runMission(mission, '/fake/repo', { onUpdate: () => {}, stopSignal: () => false });

    expect(gitStatusMock).toHaveBeenCalled();
    const worktreePathUsed = gitStatusMock.mock.calls[0]?.[0];

    expect(gitStageMock).toHaveBeenCalledWith(
      worktreePathUsed,
      expect.arrayContaining(['src/newFile.ts', 'README.md']),
    );
    expect(gitCommitMock).toHaveBeenCalledWith(
      worktreePathUsed,
      expect.stringContaining('snapshot uncommitted deliverable'),
    );
    // Deterministic, English, conventional-commit message — never invented
    // per-call, always the same clearly-labelled harness snapshot.
    expect(gitCommitMock.mock.calls[0]?.[1]).toBe(
      'chore(agent): snapshot uncommitted deliverable before review',
    );
  });

  it("never stages Lazy's own .lazy/.lazybrain infra paths, even when they show up dirty", async () => {
    statusFiles = [
      { path: 'src/newFile.ts', status: '?' },
      { path: '.lazybrain/brain/_cache/fts.sqlite', status: 'M' },
      { path: '.lazy/missions.json', status: 'M' },
    ];
    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({ contract: baseContract });

    await runMission(mission, '/fake/repo', { onUpdate: () => {}, stopSignal: () => false });

    expect(gitStageMock).toHaveBeenCalledTimes(1);
    const stagedPaths = gitStageMock.mock.calls[0]?.[1] as string[];
    expect(stagedPaths).toEqual(['src/newFile.ts']);
  });

  it('does not stage or commit anything when the worktree is already clean (implementer committed its own work)', async () => {
    statusFiles = [];
    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({ contract: baseContract });

    await runMission(mission, '/fake/repo', { onUpdate: () => {}, stopSignal: () => false });

    expect(gitStatusMock).toHaveBeenCalled();
    expect(gitStageMock).not.toHaveBeenCalled();
    expect(gitCommitMock).not.toHaveBeenCalled();
  });

  it('never blocks the mission when staging/commit itself fails (best-effort safety net)', async () => {
    statusFiles = [{ path: 'src/newFile.ts', status: '?' }];
    gitStageMock.mockRejectedValueOnce(new Error('git stage: index locked'));
    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({ contract: baseContract });

    await expect(
      runMission(mission, '/fake/repo', { onUpdate: () => {}, stopSignal: () => false }),
    ).resolves.not.toThrow();
    expect(evaluateMissionMock).toHaveBeenCalledTimes(1);
  });
});

// ── Graceful max-steps/consecutive-failures fallthrough (2026-08-05 incident) ─
//
// A DeepSeek mission finished its real work (self-verified at step 58) then
// hit the managed loop's step cap at step 60 while re-reading its own
// git_diff. The old code treated ANY managedOutcome.failed (including
// max_steps_exhausted/consecutive_failures) as an immediate, unconditional
// cleanupWorktree() + status 'failed' — discarding a complete, reviewable
// deliverable. runtime.ts now defers that verdict until Step C has computed
// the real diff: an empty diff still fails and discards exactly as before;
// a non-empty diff falls through into the normal review pipeline instead.

describe('runMission — graceful max-steps fallthrough (2026-08-05 incident)', () => {
  function mockManagedStepCapFailure(reason: string): void {
    mockedHasManagedCreditsActive.mockReturnValue(true);
    mockedPlanAndActManaged.mockImplementation(async (opts: PlanAndActManagedOpts) => {
      opts.onOutcome?.({ type: 'failed', reason });
    });
  }

  it('routes a max_steps_exhausted managed failure to review (with diff) when the worktree has real changes', async () => {
    statusFiles = [{ path: 'src/feature.ts', status: 'M' }];
    mockManagedStepCapFailure('max_steps_exhausted');
    const onUpdate = vi.fn();
    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({ contract: baseContract, model: 'deepseek/deepseek-v4-flash' });

    await runMission(mission, '/fake/repo', { onUpdate, stopSignal: () => false });

    // The deliverable must never be thrown away.
    expect(invokeCalls.some((c) => c.cmd === 'agent_discard_worktree')).toBe(false);
    // The normal Step C→F review/evaluation pipeline actually ran.
    expect(evaluateMissionMock).toHaveBeenCalledTimes(1);

    const patches = onUpdate.mock.calls.map((c) => (c[0] as { patch: Record<string, unknown> }).patch);
    const reviewPatch = patches.find((p) => p.status === 'review');
    expect(reviewPatch).toBeDefined();
    expect(reviewPatch?.diffAdded).toBeGreaterThan(0);
    expect(reviewPatch?.statusReason).toBe('step cap reached — deliverable preserved for review');
    expect(patches.some((p) => p.status === 'failed')).toBe(false);
  });

  it('still fails (and discards) a max_steps_exhausted managed failure when the worktree is clean', async () => {
    statusFiles = [];
    worktreeDiffOverride = '';
    mockManagedStepCapFailure('max_steps_exhausted');
    const onUpdate = vi.fn();
    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({ contract: baseContract, model: 'deepseek/deepseek-v4-flash' });

    await runMission(mission, '/fake/repo', { onUpdate, stopSignal: () => false });

    // Nothing to salvage — same discard behaviour as before this fix.
    expect(invokeCalls.some((c) => c.cmd === 'agent_discard_worktree')).toBe(true);
    expect(evaluateMissionMock).not.toHaveBeenCalled();

    const patches = onUpdate.mock.calls.map((c) => (c[0] as { patch: Record<string, unknown> }).patch);
    const failedPatch = patches.find((p) => p.status === 'failed');
    expect(failedPatch).toBeDefined();
    // Real bug fix (M26 — raw "consecutive_failures" rendered on a mission
    // card): statusReason now goes through translateStatusReason, never the
    // raw machine token. See statusReasonLabel.ts.
    expect(failedPatch?.statusReason).toBe('Mission arrêtée — nombre maximum d’étapes atteint.');
    expect(patches.some((p) => p.status === 'review')).toBe(false);
  });
});
