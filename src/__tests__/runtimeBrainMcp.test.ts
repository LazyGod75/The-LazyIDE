/**
 * Tests for the "brain-everywhere" mid-mission hint added to planAndActLive's
 * task prompt (src/lib/agents/runtime.ts).
 *
 * The actual mid-mission `brain_search` MCP tool is wired entirely on the Rust
 * side (agent_run / build_brain_mcp_config in src-tauri/src/lib.rs) — it is
 * fail-open there (silently skipped when the brain/LazyBrain CLI/MCP script
 * can't be resolved), so runtime.ts cannot and does not assert the tool always
 * exists. What runtime.ts DOES own is the conditional hint text folded into
 * the task prompt sent to agent_run, and it must never regress the existing
 * one-time brain-context / startup-context injection already covered by
 * runtimeDispatch.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { invoke } from '@tauri-apps/api/core';

vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProviderMode: vi.fn(),
  };
});

vi.mock('../lib/agents/managedAgent', () => ({
  planAndActManaged: vi.fn().mockResolvedValue(undefined),
}));

// vi.mock(...) factories are hoisted above ALL other module-level code
// (including plain `const`s), so any mock fn a factory needs to reference
// must itself be created via vi.hoisted — otherwise it's a TDZ access at the
// time the (hoisted) factory runs. See https://vitest.dev/api/vi.html#vi-hoisted
const { mockRecall, mockStartupContext, mockBuildPromptBrainContext } = vi.hoisted(() => ({
  mockRecall: vi.fn(),
  mockStartupContext: vi.fn(),
  mockBuildPromptBrainContext: vi.fn(),
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

vi.mock('../lib/brain/context', () => ({
  normalizeRecall: vi.fn((r: unknown) => r),
  buildPromptBrainContext: mockBuildPromptBrainContext,
  estimateTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
}));

import { planAndAct } from '../lib/agents/runtime';
import type { PlanStep } from '../lib/agents/types';
import { getProviderMode } from '../lib/models/index';
import { RECALL_TEACHING } from '../lib/models/systemPrompts';

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;
const mockedGetProviderMode = getProviderMode as ReturnType<typeof vi.fn>;

function setTauriRuntime(active: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (active) {
    w['__TAURI_INTERNALS__'] = {};
  } else {
    delete w['__TAURI_INTERNALS__'];
  }
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
    missionId: 'brain-mcp-mission-1',
    missionTitle: 'Test task',
    worktreePath: '/tmp/wt/test',
    steps: makeSteps(),
    onStep: vi.fn(),
    onAction: vi.fn(),
    onProgress: vi.fn(),
    // stopSignal=true lets planAndActLive's wait loop resolve immediately —
    // the prompt is already fully built (and agent_run already invoked)
    // synchronously before that loop is ever reached.
    stopSignal: vi.fn(() => true),
    ...overrides,
  };
}

/** Extract the `task` string passed to invoke('agent_run', { req: {...} }). */
function getInvokedTask(): string {
  const call = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'agent_run');
  expect(call).toBeDefined();
  const req = (call as [string, { req: { task: string } }])[1].req;
  return req.task;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedInvoke.mockResolvedValue(undefined);
  mockRecall.mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 });
  mockStartupContext.mockResolvedValue('');
  mockBuildPromptBrainContext.mockReturnValue('');
  mockedGetProviderMode.mockReturnValue('claude-code');
  setTauriRuntime(true);
});

afterEach(() => {
  setTauriRuntime(false);
});

describe('planAndActLive task prompt — brain-everywhere mid-mission hint', () => {
  it('always includes the brain_search availability hint (conditional phrasing, tool wiring lives in Rust)', async () => {
    await planAndAct(makeOpts());

    const task = getInvokedTask();
    expect(task).toContain('If a brain_search tool is available');
    expect(task).toContain('persistent brain');
  });

  it('still includes the hint and still invokes agent_run when brain recall AND startup context both fail (fail-open)', async () => {
    mockRecall.mockRejectedValue(new Error('brain offline'));
    mockStartupContext.mockRejectedValue(new Error('brain offline'));

    await planAndAct(makeOpts());

    expect(mockedInvoke).toHaveBeenCalledWith('agent_run', expect.objectContaining({
      req: expect.objectContaining({ id: 'brain-mcp-mission-1' }),
    }));
    const task = getInvokedTask();
    expect(task).toContain('If a brain_search tool is available');
    expect(task).toContain('Do the task. Be autonomous');
  });

  it('keeps the one-time startup-context and brain-context injection blocks intact alongside the new hint', async () => {
    mockStartupContext.mockResolvedValue('Recent session: refactored auth module.');
    mockBuildPromptBrainContext.mockReturnValue('BRAIN_CONTEXT_MARKER_XYZ');

    await planAndAct(makeOpts());

    const task = getInvokedTask();
    // Start-injection (pre-existing behavior) must be unaffected by this change.
    expect(task).toContain('<brain_startup_context>');
    expect(task).toContain('Recent session: refactored auth module.');
    expect(task).toContain('BRAIN_CONTEXT_MARKER_XYZ');
    // New mid-mission hint must be present too, positioned after the injected
    // context blocks and before the closing instruction.
    const hintIdx = task.indexOf('If a brain_search tool is available');
    const contextIdx = task.indexOf('BRAIN_CONTEXT_MARKER_XYZ');
    const closingIdx = task.indexOf('Do the task. Be autonomous');
    expect(hintIdx).toBeGreaterThan(contextIdx);
    expect(closingIdx).toBeGreaterThan(hintIdx);
  });

  it('does not add the hint to the managed (Pro) loop prompt — Rust MCP wiring is native-claude only', async () => {
    mockedGetProviderMode.mockReturnValue('managed');
    const { planAndActManaged } = await import('../lib/agents/managedAgent');

    await planAndAct(makeOpts({ managedModel: 'openrouter/some-model' }));

    expect(planAndActManaged).toHaveBeenCalledTimes(1);
    const [managedOpts] = (planAndActManaged as ReturnType<typeof vi.fn>).mock.calls[0] as [{ missionTask?: string; missionTitle: string }];
    // planAndActManaged builds its own prompt independently — it must never
    // receive the native-only hint string via missionTask/missionTitle.
    expect(managedOpts.missionTask ?? managedOpts.missionTitle).not.toContain('brain_search tool is available');
  });
});

// ── RECALL_TEACHING — when/how to consult and interpret project memory ──
describe('planAndActLive task prompt — RECALL_TEACHING', () => {
  it('includes RECALL_TEACHING verbatim, after the brain_search hint and before the closing instruction', async () => {
    await planAndAct(makeOpts());

    const task = getInvokedTask();
    expect(task).toContain(RECALL_TEACHING);

    const hintIdx = task.indexOf('If a brain_search tool is available');
    const teachingIdx = task.indexOf(RECALL_TEACHING);
    const closingIdx = task.indexOf('Do the task. Be autonomous');
    expect(teachingIdx).toBeGreaterThan(hintIdx);
    expect(closingIdx).toBeGreaterThan(teachingIdx);
  });

  it('is still present when brain recall and startup context both fail (fail-open, same as the hint)', async () => {
    mockRecall.mockRejectedValue(new Error('brain offline'));
    mockStartupContext.mockRejectedValue(new Error('brain offline'));

    await planAndAct(makeOpts());

    const task = getInvokedTask();
    expect(task).toContain(RECALL_TEACHING);
  });

  it('is NOT duplicated into the separate agent_run `system` string (single injection point)', async () => {
    await planAndAct(makeOpts());

    const call = mockedInvoke.mock.calls.find(([cmd]) => cmd === 'agent_run');
    const req = (call as [string, { req: { system: string } }])[1].req;
    expect(req.system).not.toContain(RECALL_TEACHING);
  });
});
