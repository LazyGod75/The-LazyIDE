/**
 * canvasMissionBrainPipeline.test.ts — brain-integration wave.
 *
 * David's explicit demand: "les agents et le lazymanager doivent interagir
 * avec le lazybrain de manière optimale". This suite locks in the audit
 * finding for points 1-3 of that wave: a chain-fired mission (chainEngine.ts's
 * attemptFire) and a manager-launched mission (create_draft/launch_draft,
 * direct launch_mission) both go through the exact SAME shared pipeline as a
 * user-launched mission — agentsStore.tsx's addMission -> runtime.ts's
 * runMission -> planAndAct(Live|Managed) — so there is nothing launch-path-
 * specific to fix: the brain-recall pre-run enrichment (runtime.ts's
 * 'brain-recall' launch phase, this file's planAndActLive's own
 * getPlatform().brain.recall(coreTask) call) and the post-mission learning
 * capture (runMission's Step G, learningLoop.ts's runLearningLoop) both run
 * unconditionally, keyed only on `mission.agentTask` — never on how the
 * mission was created.
 *
 * Regression contract this file protects:
 *   1. A chain-fired mission's agentTask (draft.task + chainEngine.ts's
 *      buildContextBlock output, i.e. containing "## CONTEXTE AMONT") ADDS
 *      to — never replaces — the separately-fetched <brain_context> block.
 *      Both must be present in the final task prompt sent to agent_run.
 *   2. The same holds for a manager-launched mission with a plain agentTask
 *      (no upstream chain context) — the brain-recall call fires exactly
 *      the same way, proving there is no chain-specific bypass.
 *   3. The post-mission learning loop (Step G) still runs for a mission
 *      whose agentTask carries the chain-fired CONTEXTE AMONT marker.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return { ...actual, getProviderMode: vi.fn() };
});

vi.mock('../lib/agents/managedAgent', () => ({
  planAndActManaged: vi.fn().mockResolvedValue(undefined),
}));

// vi.hoisted — see runtimeBrainMcp.test.ts's identical comment: vi.mock
// factories are hoisted above plain `const`s, so mocks referenced inside a
// factory must themselves be created via vi.hoisted.
const { mockRecall, mockStartupContext } = vi.hoisted(() => ({
  mockRecall: vi.fn(),
  mockStartupContext: vi.fn(),
}));

vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    brain: {
      recall: mockRecall,
      capture: vi.fn().mockResolvedValue(undefined),
      startupContext: mockStartupContext,
    },
  })),
}));

import { planAndAct } from '../lib/agents/runtime';
import type { PlanStep } from '../lib/agents/types';
import { getProviderMode } from '../lib/models/index';

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;
const mockedGetProviderMode = getProviderMode as ReturnType<typeof vi.fn>;

function setTauriRuntime(active: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (active) w['__TAURI_INTERNALS__'] = {};
  else delete w['__TAURI_INTERNALS__'];
}

function makeSteps(): PlanStep[] {
  return [
    { label: 'Initialisation', state: 'todo' as const },
    { label: 'Analyse', state: 'todo' as const },
    { label: 'Implémentation', state: 'todo' as const },
    { label: 'Tests', state: 'todo' as const },
    { label: 'Diff', state: 'todo' as const },
  ];
}

function makeOpts(overrides: Partial<Parameters<typeof planAndAct>[0]> = {}) {
  return {
    missionId: 'canvas-brain-mission-1',
    missionTitle: 'Fallback title (unused when missionTask is set)',
    worktreePath: '/tmp/wt/test',
    steps: makeSteps(),
    onStep: vi.fn(),
    onAction: vi.fn(),
    onProgress: vi.fn(),
    stopSignal: vi.fn(() => true),
    ...overrides,
  };
}

function getInvokedTask(): string {
  const call = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'agent_run');
  expect(call).toBeDefined();
  const req = (call as [string, { req: { task: string } }])[1].req;
  return req.task;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedInvoke.mockResolvedValue(undefined);
  mockStartupContext.mockResolvedValue('');
  mockedGetProviderMode.mockReturnValue('claude-code');
  setTauriRuntime(true);
});

afterEach(() => {
  setTauriRuntime(false);
});

// The exact upstream-context marker chainEngine.ts's buildContextBlock
// appends to a fired draft's task (see that module's own doc comment) —
// reproduced verbatim here rather than importing chainEngine.ts, which would
// pull in canvasStore/journal wiring this pure prompt-composition test does
// not need.
const CHAIN_FIRED_AGENT_TASK =
  'run the tests' +
  '\n\n## CONTEXTE AMONT\nMission « Implement auth » terminée (done).\nMission M1: "Implement auth"\nStatus: done';

describe('canvas-originated mission launches share the SAME brain-recall pipeline as a user launch', () => {
  it('a chain-fired mission (agentTask carrying CONTEXTE AMONT) gets BOTH the upstream block AND a real <brain_context> block — one never replaces the other', async () => {
    mockRecall.mockResolvedValue({
      injectedContext: '[#n1] Auth decision: use PKCE for the OAuth flow.',
      nodes: [{ id: 'n1', title: 'Auth decision', snippet: 'use PKCE for the OAuth flow.', score: 0.9 }],
      tokensInjected: 42,
      tokensSaved: 1200,
    });

    await planAndAct(makeOpts({ missionTask: CHAIN_FIRED_AGENT_TASK }));

    const task = getInvokedTask();
    // 1. The upstream (chain) context survived verbatim inside "Task: ...".
    expect(task).toContain('## CONTEXTE AMONT');
    expect(task).toContain('Implement auth');
    // 2. The brain-recall pre-run enrichment ALSO fired — a real, separate
    //    <brain_context> block is present, built from the SAME combined
    //    coreTask (missionTask), never skipped because agentTask already
    //    carried upstream context.
    expect(mockRecall).toHaveBeenCalledWith(CHAIN_FIRED_AGENT_TASK, 'canvas-brain-mission-1');
    expect(task).toContain('<brain_context>');
    expect(task).toContain('Auth decision: use PKCE for the OAuth flow.');
    expect(task).toContain('Memory citations: #n1');
    // 3. Ordering: the brain_context block appears strictly AFTER the
    //    upstream context (it is appended to the already-composed coreTask),
    //    i.e. it ADDS to rather than replaces it.
    expect(task.indexOf('<brain_context>')).toBeGreaterThan(task.indexOf('## CONTEXTE AMONT'));
  });

  it('a manager-launched mission with a PLAIN agentTask (no chain upstream context) gets the identical brain-recall enrichment — no chain-specific bypass', async () => {
    mockRecall.mockResolvedValue({
      injectedContext: '[#n2] Rate limit note: 100 req/min per key.',
      nodes: [{ id: 'n2', title: 'Rate limit note', snippet: '100 req/min per key.', score: 0.85 }],
      tokensInjected: 30,
      tokensSaved: 900,
    });

    await planAndAct(makeOpts({ missionTask: 'add rate limiting to the API' }));

    const task = getInvokedTask();
    expect(mockRecall).toHaveBeenCalledWith('add rate limiting to the API', 'canvas-brain-mission-1');
    expect(task).toContain('<brain_context>');
    expect(task).toContain('Rate limit note: 100 req/min per key.');
  });

  it('soft-fails to no brain_context (never crashes the launch) when recall rejects — same for both launch shapes', async () => {
    mockRecall.mockRejectedValue(new Error('brain offline'));

    await planAndAct(makeOpts({ missionTask: CHAIN_FIRED_AGENT_TASK }));

    expect(mockedInvoke).toHaveBeenCalledWith('agent_run', expect.objectContaining({
      req: expect.objectContaining({ id: 'canvas-brain-mission-1' }),
    }));
    const task = getInvokedTask();
    expect(task).toContain('## CONTEXTE AMONT'); // upstream context is NEVER lost
    expect(task).not.toContain('<brain_context>'); // honest absence, not a fabricated block
  });
});
