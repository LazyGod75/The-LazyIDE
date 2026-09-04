/**
 * runtimeMissionProjectIdIntegrity.test.ts
 *
 * Regression guard for a project_id drift bug found in prod (2026-08-04):
 * missions created under one project (e.g. lazy-backoffice) were later
 * observed in `missions_current` with a DIFFERENT project_id — the one for
 * whatever project happened to be ACTIVE at the moment a later update was
 * journaled, not the mission's own origin project. Root cause traced to
 * agentsStore.tsx's debounced mission-journaling effect, which computes ONE
 * projectId from the currently active project (resolveProjectRoot()) and
 * stamps EVERY changed mission with it — including missions that belong to
 * a project other than the one currently active (see this file's sibling
 * report for the exact fix needed there; that file is out of this module's
 * scope to edit).
 *
 * runtime.ts's OWN mission.* emitters (mission.started/completed/failed/
 * blocked) are the one piece of this pipeline in scope here, and they are
 * ALREADY correctly scoped: projectId is derived from THIS run's own
 * `repoPath` parameter (via projectIdFromRoot), never from any ambient
 * "active project" global. This test pins that contract down so it can
 * never silently regress to the same drift bug.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mission } from '../lib/agents/types';
import type { evaluateMission } from '../lib/agents/evaluator';

let invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

const FAKE_DIFF =
  'diff --git a/README.md b/README.md\n' +
  'index 22e067e..91c36bd 100644\n' +
  '--- a/README.md\n' +
  '+++ b/README.md\n' +
  '@@ -1,3 +1,4 @@\n' +
  ' # alpha\n' +
  '+<!-- qa-check -->\n';

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

vi.mock('../lib/platform', () => ({
  getPlatform: () => ({ git: { status: vi.fn(() => Promise.resolve({ files: [] })) } }),
  isTauri: () => true,
}));

// Captures every emitted event's { type, projectId } — the exact shape this
// test needs to assert against, instead of the other runtime test files'
// no-op mocks.
const emittedEvents: Array<{ type: string; projectId: string }> = [];
vi.mock('../lib/journal/journal', () => ({
  emitEvent: vi.fn((e: { type: string; projectId: string }) => {
    emittedEvents.push({ type: e.type, projectId: e.projectId });
    return Promise.resolve(0);
  }),
  emitBuffered: vi.fn((e: { type: string; projectId: string }) => {
    emittedEvents.push({ type: e.type, projectId: e.projectId });
  }),
}));

// Reflects its input (unlike the other runtime test files' constant stub) so
// this test can assert the emitted projectId is DERIVED from the exact
// repoPath runMission was called with, never a fixed/ambient value.
vi.mock('../lib/journal/projectId', () => ({
  projectIdFromRoot: vi.fn((root: string) => `pid:${root}`),
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

beforeEach(() => {
  invokeCalls = [];
  emittedEvents.length = 0;
  evaluateMissionMock.mockClear();
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

describe('runMission — mission.* events always carry the projectId derived from THIS run\'s own repoPath', () => {
  it('mission.started and mission.completed both use projectIdFromRoot(repoPath) for the repoPath this run was actually given', async () => {
    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({ contract: baseContract });

    await runMission(mission, '/repo/project-A', { onUpdate: () => {}, stopSignal: () => false });

    const started = emittedEvents.find((e) => e.type === 'mission.started');
    const completed = emittedEvents.find((e) => e.type === 'mission.completed');
    expect(started?.projectId).toBe('pid:/repo/project-A');
    expect(completed?.projectId).toBe('pid:/repo/project-A');
  });

  it(
    'a second run against a DIFFERENT repoPath gets its own projectId — never a value left over from a prior run',
    async () => {
      const { runMission } = await import('../lib/agents/runtime');

      await runMission(baseMission({ id: 'M-a', contract: baseContract }), '/repo/project-A', {
        onUpdate: () => {},
        stopSignal: () => false,
      });
      emittedEvents.length = 0;
      await runMission(baseMission({ id: 'M-b', contract: baseContract }), '/repo/project-B', {
        onUpdate: () => {},
        stopSignal: () => false,
      });

      // Every event from the second run must reflect project-B — none of them
      // may carry project-A's id (the exact drift shape seen in prod: a later
      // update stamped with whichever project was active at THAT moment).
      expect(emittedEvents.length).toBeGreaterThan(0);
      for (const e of emittedEvents) {
        expect(e.projectId).toBe('pid:/repo/project-B');
      }
    },
    // Two full sequential mission runs (~3.5s each, real setTimeout-based
    // progress pacing in runtime.ts) exceed vitest's default 5000ms.
    15000,
  );
});
