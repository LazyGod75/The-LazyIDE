/**
 * runtimeBaseBranch.test.ts
 *
 * Regression test for the "agent cannot pick up existing work living on
 * another local git branch" defect (real repro, lazy-backoffice, missions
 * M1/M2: "integrate the scaffold from branch
 * agent/M40-w1-a-scaffold-auth-admin"). The worktree used to always be
 * created from the target repo's current HEAD — there was no way for a plan
 * step to declare "start this worktree from branch X instead", so an agent
 * asked to continue work living on another branch got an empty worktree
 * (main had nothing) and silently delivered only the pre-existing README.md.
 *
 * Mission.baseBranch (see its doc comment, lib/agents/types.ts) fixes this:
 * runMission (runtime.ts) now forwards it to createWorktree, which passes it
 * to the `agent_create_worktree` Tauri command as the explicit git worktree
 * start point (src-tauri/src/commands/git.rs).
 *
 * This test proves, at the runtime.ts boundary (mocking the Tauri `invoke`
 * bridge, not the Rust process):
 *   1. A mission with a valid `baseBranch` forwards it verbatim as the
 *      `agent_create_worktree` call's `baseBranch` arg — the actual
 *      structural request the Rust side needs to root the new branch there.
 *   2. A mission whose `baseBranch` does not exist (simulated by rejecting
 *      the invoke call the same way agent_create_worktree_inner's honest
 *      validation does) falls back ONCE to no baseBranch (2026-08-05 —
 *      `createWorktreeWithBaseBranchFallback`, runtime.ts) and the mission
 *      PROCEEDS: a dependent mission launched after its parent's worktree
 *      branch was merged (which deletes the branch) must not fail hard just
 *      because that branch name no longer exists — the parent's content is
 *      already on the repo's default branch by then.
 *   3. A worktree-creation failure that is NOT the "base branch does not
 *      exist" case (e.g. a bad mergeBranches entry) is never retried and
 *      still fails the mission explicitly — the fallback is scoped
 *      narrowly, not a catch-all.
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

// Overridable per-test so the failure test can reject exactly like
// agent_create_worktree_inner's honest base-branch validation does.
let createWorktreeImpl: (args?: Record<string, unknown>) => Promise<unknown>;

function defaultInvokeImpl(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  invokeCalls.push({ cmd, args: args ?? {} });
  if (cmd === 'agent_create_worktree') return createWorktreeImpl(args);
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
const isVerificationMissionMock = vi.fn<typeof isVerificationMission>(() => false);
vi.mock('../lib/agents/evaluator', () => ({
  evaluateMission: (...args: Parameters<typeof evaluateMission>) => evaluateMissionMock(...args),
  deriveJudgesApproved: vi.fn(() => 'approved'),
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
  vi.setConfig({ testTimeout: 15_000 });
  invokeCalls = [];
  evaluateMissionMock.mockClear();
  isVerificationMissionMock.mockReset().mockReturnValue(false);
  createWorktreeImpl = (args) => Promise.resolve(`/fake/wt/${(args?.branch as string) ?? 'x'}`);
});

const baseMission = (overrides: Partial<Mission>): Mission =>
  ({
    id: 'M-test',
    title: 'Integrate the scaffold from agent/M40-w1-a-scaffold-auth-admin',
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

describe('runMission — Mission.baseBranch (real-work-on-another-branch fix)', () => {
  it('a step with a valid base branch forwards it to agent_create_worktree as the worktree start point', async () => {
    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({
      baseBranch: 'agent/M40-w1-a-scaffold-auth-admin',
      contract: baseContract,
    });

    await runMission(mission, '/fake/repo', { onUpdate: () => {}, stopSignal: () => false });

    const createCall = invokeCalls.find((c) => c.cmd === 'agent_create_worktree');
    expect(createCall).toBeDefined();
    expect(createCall?.args.baseBranch).toBe('agent/M40-w1-a-scaffold-auth-admin');
  });

  it('omitting baseBranch keeps today\'s default — no baseBranch arg forwarded', async () => {
    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({ contract: baseContract });

    await runMission(mission, '/fake/repo', { onUpdate: () => {}, stopSignal: () => false });

    const createCall = invokeCalls.find((c) => c.cmd === 'agent_create_worktree');
    expect(createCall).toBeDefined();
    expect(createCall?.args.baseBranch).toBeUndefined();
  });

  it('a nonexistent base branch (parent branch already merged+deleted) falls back once to the default branch and the mission proceeds', async () => {
    const missingBranch = 'agent/M40-w1-a-scaffold-auth-admin';
    // Mirrors agent_create_worktree_inner's REAL honest-validation contract
    // (src-tauri/src/commands/git.rs): it only rejects when a baseBranch was
    // actually requested — so this assertion depends on runtime.ts genuinely
    // forwarding mission.baseBranch through to the invoke call, not just on
    // any invoke rejection. The RETRY call (fallback, baseBranch omitted)
    // resolves, simulating createWorktree rooting off repoPath's current
    // HEAD — the repo's default branch, which already has the merged
    // parent content by the time the branch was deleted.
    createWorktreeImpl = (args) => {
      const requestedBase = args?.baseBranch as string | undefined;
      if (requestedBase) {
        return Promise.reject(
          new Error(
            `agent_create_worktree: base branch '${requestedBase}' does not exist in '/fake/repo' — refusing to silently fall back to HEAD`,
          ),
        );
      }
      return Promise.resolve(`/fake/wt/${(args?.branch as string) ?? 'x'}`);
    };

    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({ baseBranch: missingBranch, contract: baseContract });

    const onUpdate = vi.fn();
    await runMission(mission, '/fake/repo', { onUpdate, stopSignal: () => false });

    // Exactly one retry: the first call names the missing branch, the
    // second (fallback) omits baseBranch entirely.
    const createCalls = invokeCalls.filter((c) => c.cmd === 'agent_create_worktree');
    expect(createCalls).toHaveLength(2);
    expect(createCalls[0]?.args.baseBranch).toBe(missingBranch);
    expect(createCalls[1]?.args.baseBranch).toBeUndefined();

    // Never silent: an honest actionTimeline entry names the missing branch.
    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'M-test',
        patch: expect.objectContaining({
          actionTimeline: expect.arrayContaining([
            expect.objectContaining({ text: expect.stringContaining(missingBranch) }),
          ]),
        }),
      }),
    );

    // The mission PROCEEDS instead of failing hard: worktree creation is
    // never reported as failed, and the run reaches evaluation (proving it
    // went all the way through the mission loop on the fallback worktree,
    // unlike the old hard-fail behavior where evaluateMission was never
    // even called).
    expect(onUpdate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        patch: expect.objectContaining({ statusReason: expect.stringContaining('worktree_creation_failed') }),
      }),
    );
    expect(evaluateMissionMock).toHaveBeenCalled();
  });

  it('a worktree-creation failure that is NOT "base branch does not exist" is never retried and still fails the mission', async () => {
    // A DIFFERENT git failure (not the honest base-branch-missing rejection)
    // must not be mistaken for the merged+deleted-branch case: no retry, no
    // fallback, mission fails exactly like before this fix.
    createWorktreeImpl = () =>
      Promise.reject(new Error("agent_create_worktree: '/fake/repo' is not a git repository"));

    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({ baseBranch: 'agent/M40-w1-a-scaffold-auth-admin', contract: baseContract });

    const onUpdate = vi.fn();
    await runMission(mission, '/fake/repo', { onUpdate, stopSignal: () => false });

    // Exactly one attempt — the fallback path must never fire for this error.
    const createCalls = invokeCalls.filter((c) => c.cmd === 'agent_create_worktree');
    expect(createCalls).toHaveLength(1);

    expect(onUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'M-test',
        patch: expect.objectContaining({
          status: 'failed',
          statusReason: expect.stringContaining('worktree_creation_failed'),
        }),
      }),
    );
    expect(invokeCalls.some((c) => c.cmd === 'agent_run')).toBe(false);
    expect(evaluateMissionMock).not.toHaveBeenCalled();
  });
});
