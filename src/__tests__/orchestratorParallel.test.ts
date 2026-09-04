/**
 * T1.5 — Dynamic parallel orchestrator tests.
 *
 * Verifies:
 *   - Two sub-agents launch in parallel (Promise.allSettled, not sequential loop)
 *   - Each sub-agent gets its own worktree (createWorktree called per sub-agent)
 *   - Depth-3 spawn is rejected (parentDepth >= 2 blocks fan-out)
 *   - Sponsor chain events (agent.delegated) carry correct depth
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mission } from '../lib/agents/types';

let invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];
let emitCalls: Array<{ type: string; missionId?: string; payload: Record<string, unknown> }> = [];

/** Default invoke() behaviour — restored after tests that need a different
 *  implementation (see the Fix 3 describe block below), so overriding it
 *  for one test never leaks into later ones. */
function defaultInvokeImpl(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
  invokeCalls.push({ cmd, args: args ?? {} });
  if (cmd === 'agent_create_worktree') return Promise.resolve(`/fake/wt/${args?.branch ?? 'x'}`);
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
    callback();
    return Promise.resolve(() => undefined);
  }),
}));

vi.mock('../lib/platform', () => ({
  getPlatform: () => 'desktop',
  isTauri: () => true,
}));

vi.mock('../lib/journal/journal', () => ({
  emitEvent: vi.fn((e: { type: string; missionId?: string; payload: Record<string, unknown> }) => {
    emitCalls.push({ type: e.type, missionId: e.missionId, payload: e.payload });
    return Promise.resolve(0);
  }),
  emitBuffered: vi.fn((e: { type: string; missionId?: string; payload: Record<string, unknown> }) => {
    emitCalls.push({ type: e.type, missionId: e.missionId, payload: e.payload });
    return Promise.resolve(0);
  }),
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

vi.mock('../lib/agents/evaluator', () => ({
  evaluateMission: vi.fn(() => Promise.resolve({
    score: 80, passed: true, risk: 'low' as const, reviewers: [], createdAt: new Date().toISOString(),
  })),
  deriveJudgesApproved: vi.fn(() => 'approved'),
  // R13 — see canvasMissionLearningCapture.test.ts's matching comment:
  // runtime.ts's action-timeline eval-completion line now calls
  // formatVerdictScoreLine (evaluator.ts) — a full mock replacement without
  // it throws mid-update.
  formatVerdictScoreLine: vi.fn((v: { score: number }) => `${v.score}/100`),
  // Trust-critical defect #2 (M2 forensics) — see canvasMissionLearningCapture
  // .test.ts's matching comment: runtime.ts's Step C now also imports
  // isVerificationMission to compute mission.emptyDeliverable.
  isVerificationMission: vi.fn(() => false),
}));

vi.mock('../lib/agents/diffParse', () => ({ parseDiffFiles: vi.fn(() => []) }));
vi.mock('../lib/agents/stageContract', () => ({
  compilePlan: vi.fn(() => ({
    brainAdapted: false,
    adaptations: [],
    graph: { stages: [{ kind: 'implement', attemptCount: 0 }] },
  })),
  planToSteps: vi.fn(() => []),
}));
vi.mock('../lib/agents/learningLoop', () => ({ runLearningLoop: vi.fn(() => Promise.resolve({ summary: '', insights: [] })) }));
vi.mock('../lib/agents/artifacts', () => ({ saveArtifacts: vi.fn(() => Promise.resolve()) }));
vi.mock('../lib/agents/recovery', () => ({ evaluateRecovery: vi.fn(() => ({ shouldRecover: false })), delayMs: vi.fn(() => 0) }));
vi.mock('../lib/agents/managedAgent', () => ({ planAndActManaged: vi.fn() }));
vi.mock('../lib/agents/proofs', () => ({ parseProofBlocks: vi.fn(() => []), buildProofContractBlock: vi.fn(() => ''), PROOF_KINDS: ['screenshot','test_run','e2e_recording','command_output','behavior_diff'] }));
vi.mock('../lib/agents/launchLog', () => ({ launchPhaseEnter: vi.fn(), launchPhaseExit: vi.fn(), launchPhaseError: vi.fn() }));
vi.mock('../lib/models/accessSettings', () => ({ loadAccessSettings: vi.fn(() => ({})) }));
vi.mock('../lib/models/openrouterCatalog', () => ({ DEFAULT_OPENROUTER_MODEL_ID: 'default/model', isOpenRouterFreeModel: vi.fn(() => false) }));
vi.mock('../lib/agents/agentSessionGate', () => ({ gateAgentSession: vi.fn(async () => ({ ok: true, rail: 'cli' })) }));

beforeEach(() => {
  vi.setConfig({ testTimeout: 15_000 });
  invokeCalls = [];
  emitCalls = [];
});

const baseMission = (overrides: Partial<Mission>): Mission => ({
  id: 'M-test', title: 'Test', status: 'running', model: 'claude-sonnet',
  ...overrides,
} as Mission);

const baseContract = (parentDepth: number) => ({
  objective: 'test', model: 'claude-sonnet', permissionMode: 'acceptEdits' as const,
  budgetCapUsd: 10, proofs: [], gates: { evaluators: false, humanApprove: false },
  shareToTeam: false, parentDepth,
});

describe('T1.5: Dynamic parallel orchestrator', () => {
  it('launches sub-agents in parallel with per-sub-agent worktrees', async () => {
    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({
      id: 'M-orch', isOrchestrator: true,
      subAgents: [{ name: 'Implementer', status: 'queued' }, { name: 'Tester', status: 'queued' }],
      contract: baseContract(0),
    });
    await runMission(mission, '/fake/repo', { onUpdate: () => {}, stopSignal: () => false });

    // At least 2 agent_run calls for sub-agents (parent may also call agent_run)
    const agentRuns = invokeCalls.filter((c) => c.cmd === 'agent_run');
    expect(agentRuns.length).toBeGreaterThanOrEqual(2);
    // At least 2 createWorktree calls for sub-agents (parent creates its own too)
    const worktreeCreates = invokeCalls.filter((c) => c.cmd === 'agent_create_worktree');
    expect(worktreeCreates.length).toBeGreaterThanOrEqual(2);
  });

  it('emits agent.delegated events with correct depth', async () => {
    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({
      id: 'M-orch2', isOrchestrator: true,
      subAgents: [{ name: 'Worker', status: 'queued' }],
      contract: baseContract(0),
    });
    await runMission(mission, '/fake/repo', { onUpdate: () => {}, stopSignal: () => false });

    const delegated = emitCalls.filter((e) => e.type === 'agent.delegated');
    expect(delegated.length).toBe(1);
    expect(delegated[0].payload.depth).toBe(1);
    expect(delegated[0].payload.parentMissionId).toBe('M-orch2');
  });

  it('rejects depth-3 spawn (parentDepth >= 2 blocks fan-out)', async () => {
    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({
      id: 'M-depth3', isOrchestrator: true,
      subAgents: [{ name: 'Sub', status: 'queued' }],
      contract: baseContract(2),
    });
    await runMission(mission, '/fake/repo', { onUpdate: () => {}, stopSignal: () => false });

    const agentRuns = invokeCalls.filter((c) => c.cmd === 'agent_run');
    expect(agentRuns.length).toBe(0);
    const blocked = emitCalls.filter((e) => e.type === 'mission.blocked');
    expect(blocked.length).toBe(1);
    expect(String(blocked[0].payload.reason)).toContain('depth cap');
  });

  // Real M3/M40 forensics (2026-08-01, lazy-backoffice): the judged diff is
  // always computed from the PARENT mission's own worktree (runtime.ts Step
  // C), never a sub-agent's — so a sub-agent's committed work only reaches
  // review if the merge-back call actually targets the PARENT's worktree.
  // The pre-fix call site passed the parent worktree path in as `repoPath`
  // itself, which broke `agent_merge_worktree_inner`'s (Rust) lookup of the
  // CHILD's own worktree (nested under the wrong base) — the merge failed
  // every time and was silently swallowed, leaving the parent worktree (and
  // `mission.diffFiles`) empty forever.
  it('merges a sub-agent worktree onto the PARENT mission worktree, not repo_path', async () => {
    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({
      id: 'M-merge', isOrchestrator: true,
      subAgents: [{ name: 'Implementer', status: 'queued' }],
      contract: baseContract(0),
    });
    await runMission(mission, '/fake/repo', { onUpdate: () => {}, stopSignal: () => false });

    // The parent mission's OWN worktree creation call (branch always starts
    // with 'agent/<missionId>-') — its returned path is what the merge must
    // land on.
    const parentCreate = invokeCalls.find(
      (c) => c.cmd === 'agent_create_worktree' && String(c.args.branch).startsWith('agent/M-merge-'),
    );
    expect(parentCreate).toBeDefined();
    const parentWorktreePath = `/fake/wt/${String(parentCreate!.args.branch)}`;

    const mergeCall = invokeCalls.find((c) => c.cmd === 'agent_merge_worktree');
    expect(mergeCall).toBeDefined();
    // repoPath must stay the TRUE repo root — the Rust side derives the
    // CHILD worktree's own location from this argument. Passing the
    // parent's worktree path here instead (the pre-fix bug) makes that
    // lookup resolve to a nested, nonexistent path.
    expect(mergeCall!.args.repoPath).toBe('/fake/repo');
    expect(mergeCall!.args.branch).toBe('M-merge-implementer-wt');
    // mergeIntoDir must be the PARENT's own worktree — the actual `git
    // merge` target, so the commit lands where evaluateMission's diff
    // (Step C) will see it.
    expect(mergeCall!.args.mergeIntoDir).toBe(parentWorktreePath);
  });
});

// ── Fix 3 (audit): no shared-worktree fallback on creation failure ──
// Previously, a sub-agent whose createWorktree() call rejected silently
// fell back to running in the PARENT's shared worktree — letting concurrent
// sub-agents corrupt each other's git state (the exact hazard per-sub-agent
// worktrees exist to eliminate). Now that sub-mission fails immediately
// (mission.failed, reason 'worktree_creation_failed'); the OTHERS proceed
// unaffected (Promise.allSettled semantics — a sibling rejection never
// cancels the rest).
describe('T1.5: worktree creation failure (Fix 3 — no shared-worktree fallback)', () => {
  afterEach(async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    // Restore the shared default so later tests in this file (and any run
    // after this describe block) are unaffected by this block's override.
    (invoke as ReturnType<typeof vi.fn>).mockImplementation(
      (cmd: string, args?: Record<string, unknown>) => defaultInvokeImpl(cmd, args),
    );
  });

  it('fails the sub-mission immediately on worktree creation failure — never falls back to the parent worktree; the surviving sub-agent still completes in its own worktree', async () => {
    const { invoke } = await import('@tauri-apps/api/core');
    const mockedInvoke = invoke as ReturnType<typeof vi.fn>;
    mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
      invokeCalls.push({ cmd, args: args ?? {} });
      if (cmd === 'agent_create_worktree') {
        const branch = String(args?.branch ?? '');
        if (branch.includes('implementer')) return Promise.reject(new Error('disk full'));
        return Promise.resolve(`/fake/wt/${branch}`);
      }
      if (cmd === 'agent_merge_worktree') return Promise.resolve('fake-merge-sha');
      if (cmd === 'agent_discard_worktree') return Promise.resolve(undefined);
      if (cmd === 'agent_run') return Promise.resolve(undefined);
      if (cmd === 'agent_run_kill') return Promise.resolve(undefined);
      return Promise.resolve(undefined);
    });

    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({
      id: 'M-wtfail', isOrchestrator: true,
      subAgents: [{ name: 'Implementer', status: 'queued' }, { name: 'Tester', status: 'queued' }],
      contract: baseContract(0),
    });

    await runMission(mission, '/fake/repo', { onUpdate: () => {}, stopSignal: () => false });

    const agentRuns = invokeCalls.filter((c) => c.cmd === 'agent_run');

    // The failed sub-agent's agent_run must NEVER have been called — no
    // fallback run against the parent (or any) worktree.
    const failedChildRan = agentRuns.some(
      (c) => (c.args.req as { id: string } | undefined)?.id === 'M-wtfail-implementer',
    );
    expect(failedChildRan).toBe(false);

    // The surviving sub-agent (Tester) is entirely unaffected — it still
    // ran, in its OWN dedicated worktree (never the parent's).
    const testerRun = agentRuns.find(
      (c) => (c.args.req as { id: string } | undefined)?.id === 'M-wtfail-tester',
    );
    expect(testerRun).toBeDefined();
    const testerWorktreePath = (testerRun!.args.req as { worktreePath: string }).worktreePath;
    expect(testerWorktreePath).toBe('/fake/wt/M-wtfail-tester-wt');

    // The failed sub-mission's own failure is recorded honestly, addressed
    // to ITS id (not the parent's).
    const childFailures = emitCalls.filter(
      (e) => e.type === 'mission.failed' && e.missionId === 'M-wtfail-implementer',
    );
    expect(childFailures).toHaveLength(1);
    expect(String(childFailures[0].payload.reason)).toBe('worktree_creation_failed');
  });
});
