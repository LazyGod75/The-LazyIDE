/**
 * runtimeExtraReadableRoots.test.ts
 *
 * Regression test for the cross-project READ access gap (confirmed in a
 * live run): a mission rooted at project B had NO way to read project A's
 * source at all — the ONLY confinement `agent_run` ever applied was
 * `Command::current_dir(&worktree_path)` (run.rs), and no `--add-dir` was
 * ever passed. runtime.ts's own prompt used to TELL the agent it "MAY read
 * files under other currently open project roots" — a promise the
 * invocation never delivered.
 *
 * Mission.extraReadableRoots (see its doc comment, lib/agents/types.ts)
 * fixes this: runMission now forwards it through planAndAct ->
 * planAndActLive, which appends it to the `agent_run` request as
 * `extraReadableRoots` (camelCase — AgentRunRequest, protocol.rs). Rust
 * independently re-validates every entry against the live ProjectRegistry
 * before wiring anything (out of scope for this TS-boundary test — see
 * extra_roots.rs's own Rust unit tests for that half).
 *
 * This test proves, at the runtime.ts boundary (mocking the Tauri `invoke`
 * bridge, not the Rust process, same style as runtimeBaseBranch.test.ts):
 *   1. A mission with `extraReadableRoots` set forwards them verbatim as
 *      the `agent_run` call's `req.extraReadableRoots` — the actual field
 *      the Rust side reads.
 *   2. A mission that declares none omits the field entirely (undefined,
 *      never an empty array) — today's unchanged worktree-only behavior,
 *      no regression.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mission } from '../lib/agents/types';
import type { evaluateMission, isVerificationMission } from '../lib/agents/evaluator';

let invokeCalls: Array<{ cmd: string; args: Record<string, unknown> }> = [];

// Real event-driven simulation (unlike a naive "invoke the callback
// synchronously with no payload" stub, which would crash inside
// planAndActLive's stepHandler/doneHandler — event.payload would be read
// off `undefined` — BEFORE the `agent_run` invoke call is ever reached):
// `listen(eventName, callback)` stores the callback keyed by the exact
// event name planAndActLive registers (`agent://done/{missionId}`, etc),
// and the `agent_run` invoke handler below fires the matching `done`
// callback on a microtask with a realistic AgentDoneEvent payload — the
// same round trip the real Tauri bridge performs (agent_run kicks off the
// mission, a later `agent://done/{id}` event resolves it).
const doneListeners = new Map<string, (event: { payload: Record<string, unknown> }) => void>();

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
  if (cmd === 'agent_run') {
    const req = (args?.req ?? {}) as { id: string };
    queueMicrotask(() => {
      doneListeners.get(`agent://done/${req.id}`)?.({
        payload: {
          result: 'ok',
          exit_code: 0,
          duration_ms: 1,
          input_tokens: 1,
          output_tokens: 1,
          cost_usd: 0,
          tool_count: 0,
        },
      });
    });
    return Promise.resolve(undefined);
  }
  if (cmd === 'agent_run_kill') return Promise.resolve(undefined);
  return Promise.resolve(undefined);
}

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => defaultInvokeImpl(cmd, args)),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn((eventName: string, callback: (event: { payload: Record<string, unknown> }) => void) => {
    if (eventName.startsWith('agent://done/')) doneListeners.set(eventName, callback);
    return Promise.resolve(() => { doneListeners.delete(eventName); });
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

// isTauriRuntime() (runtime.ts, kept local/unexported — see its own doc
// comment for why it is NOT sourced from the '../lib/platform' mock above)
// checks `'__TAURI_INTERNALS__' in window` directly, independent of the
// getPlatform/isTauri mock. Without this stub, isTauriRuntime() reads false
// in jsdom and planAndAct's native branch (chosenKind === 'native') is
// never reached at all — the mission would silently run through the
// scripted/mock engine instead, and agent_run would never be invoked.
// Same recipe as agentsStore.test.tsx's own simulateTauri().
beforeEach(() => {
  invokeCalls = [];
  doneListeners.clear();
  evaluateMissionMock.mockClear();
  isVerificationMissionMock.mockReset().mockReturnValue(false);
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
});

const baseMission = (overrides: Partial<Mission>): Mission =>
  ({
    id: 'M-test',
    title: 'Document project A the way project B calls it',
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

describe('runMission — Mission.extraReadableRoots (cross-project read access fix)', () => {
  it('a mission with extraReadableRoots forwards them verbatim as agent_run\'s extraReadableRoots request field', async () => {
    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({
      extraReadableRoots: ['C:\\Users\\dev\\other-project'],
      contract: baseContract,
    });

    await runMission(mission, '/fake/repo', { onUpdate: () => {}, stopSignal: () => false });

    const runCall = invokeCalls.find((c) => c.cmd === 'agent_run');
    expect(runCall).toBeDefined();
    const req = runCall?.args.req as Record<string, unknown>;
    expect(req.extraReadableRoots).toEqual(['C:\\Users\\dev\\other-project']);
  });

  it('a mission with multiple extraReadableRoots forwards the whole list, in order', async () => {
    const { runMission } = await import('../lib/agents/runtime');
    const roots = ['C:\\Users\\dev\\project-a', 'C:\\Users\\dev\\project-b'];
    const mission = baseMission({ extraReadableRoots: roots, contract: baseContract });

    await runMission(mission, '/fake/repo', { onUpdate: () => {}, stopSignal: () => false });

    const runCall = invokeCalls.find((c) => c.cmd === 'agent_run');
    const req = runCall?.args.req as Record<string, unknown>;
    expect(req.extraReadableRoots).toEqual(roots);
  });

  it('a mission declaring no extraReadableRoots omits the field entirely — no regression from today\'s worktree-only behavior', async () => {
    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({ contract: baseContract });

    await runMission(mission, '/fake/repo', { onUpdate: () => {}, stopSignal: () => false });

    const runCall = invokeCalls.find((c) => c.cmd === 'agent_run');
    expect(runCall).toBeDefined();
    const req = runCall?.args.req as Record<string, unknown>;
    expect(req.extraReadableRoots).toBeUndefined();
    // Every OTHER field the pre-existing runtime already sent must still be
    // present, unchanged — this feature must never regress an ordinary
    // (no extra roots) mission launch.
    expect(req.worktreePath).toBeDefined();
    expect(req.task).toBeDefined();
  });

  it('an explicitly empty extraReadableRoots array also omits the field (never a spurious empty-array request)', async () => {
    const { runMission } = await import('../lib/agents/runtime');
    const mission = baseMission({ extraReadableRoots: [], contract: baseContract });

    await runMission(mission, '/fake/repo', { onUpdate: () => {}, stopSignal: () => false });

    const runCall = invokeCalls.find((c) => c.cmd === 'agent_run');
    const req = runCall?.args.req as Record<string, unknown>;
    expect(req.extraReadableRoots).toBeUndefined();
  });
});
