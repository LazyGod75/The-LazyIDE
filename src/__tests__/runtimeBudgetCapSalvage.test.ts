/**
 * runtimeBudgetCapSalvage.test.ts
 *
 * Originally the regression suite for the 2026-08-19 budget-cap incident's
 * Fix A/C (salvage a genuine deliverable instead of discarding it when a
 * budget/duration cap fires). Rewritten for the FOLLOW-UP incident review
 * (same date): checkNativeBudget's dollar-based kill was itself the
 * destructive mechanism — costUsd on the NATIVE claude-code/codex CLI rail
 * is an API-list-price EQUIVALENT the CLI self-reports, never money Lazy
 * actually billed (see runtime.ts's `isNativeRail`, CostChip.tsx,
 * MissionReportCard.tsx's "Cost-honesty wave" — all already say so), yet
 * crossing budgetCapUsd used to end the mission anyway — five real
 * documentation missions were cut short at $5.02-$13.69 against a $5 cap
 * while the UI simultaneously told the user "no debit — subscription".
 *
 * This file now proves, via runMission's real native (planAndActLive) path:
 *   A. A native-rail mission whose notional cost crosses budgetCapUsd is
 *      NOT stopped — no kill call, no budget-exceeded statusReason, no
 *      worktree discard — it completes exactly as a normal run would,
 *      keeping its real diff.
 *   B. The user still sees an honest, non-terminal FYI in CREDITS ("1
 *      credit == 1 USD cent" — billing/credits.ts's usdToCredits), worded
 *      as a non-debited equivalent, never a dollar figure and never framed
 *      as real spend.
 *   C. A native-rail mission with a genuinely empty diff and an over-cap
 *      notional cost ALSO completes normally (status 'review',
 *      emptyDeliverable: true) — the cap crossing alone is no longer a
 *      reason to discard the worktree; only an ACTUAL empty deliverable via
 *      the normal completion path decides that, same as any other run.
 *   D. A mission that stays UNDER its cap is unaffected — completes to
 *      'review' normally, no budget-related timeline note at all.
 *
 * The managed-rail counterpart (money IS real there — cap crossing must
 * still stop the mission) is covered separately by
 * runtimeManagedBudgetCapKill.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

// ── Force claude-code mode so runMission routes to the native planAndActLive
// loop (agent_run + agent://step|done|error events) — same technique as
// runtimeRetry.test.ts, which already proves this harness reaches Step A/B
// end to end. ─────────────────────────────────────────────────────────────
vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return {
    ...actual,
    getProviderMode: vi.fn(() => 'claude-code'),
  };
});

// ── Brain recall — minimal, matches runtimeRetry.test.ts's own mock ───────
vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    brain: {
      recall: vi.fn().mockResolvedValue({
        injectedContext: '',
        nodes: [],
        tokensInjected: 0,
        tokensSaved: 0,
      }),
      capture: vi.fn().mockResolvedValue(undefined),
      startupContext: vi.fn().mockResolvedValue(''),
    },
    // No `git` property on purpose — computeMissionDiff's git.status() call
    // is defensively try/caught (see runtime.ts), so a missing `.git` here
    // degrades to diffIncompleteFiles=[] instead of crashing. Matches
    // runtimeEvalDiff.test.ts's own (even sparser) platform mock.
  })),
}));

vi.mock('../lib/brain/context', () => ({
  normalizeRecall: vi.fn((r: unknown) => r),
  buildPromptBrainContext: vi.fn(() => ''),
  estimateTokens: vi.fn((text: string) => Math.ceil(text.length / 4)),
}));

vi.mock('../lib/journal/journal', () => ({
  emitEvent: vi.fn(() => Promise.resolve(0)),
  emitBuffered: vi.fn(() => Promise.resolve(0)),
}));

vi.mock('../lib/journal/projectId', () => ({
  projectIdFromRoot: vi.fn(() => 'test-project-id'),
}));

import { runMission } from '../lib/agents/runtime';
import type { Mission } from '../lib/agents/types';

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;
const mockedListen = listen as ReturnType<typeof vi.fn>;

/** Toggle the global flag isTauriRuntime() reads — same helper as
 *  runtimeRetry.test.ts. */
function setTauriRuntime(active: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (active) {
    w['__TAURI_INTERNALS__'] = {};
  } else {
    delete w['__TAURI_INTERNALS__'];
  }
}

// Real unified diff — parsed by the REAL parseDiffFiles (not mocked here),
// same fixture shape as runtimeEvalDiff.test.ts's FAKE_DIFF.
const REAL_DIFF =
  'diff --git a/README.md b/README.md\n' +
  'index 22e067e..91c36bd 100644\n' +
  '--- a/README.md\n' +
  '+++ b/README.md\n' +
  '@@ -1,3 +1,4 @@\n' +
  ' # alpha\n' +
  '+<!-- shipped after the budget cap notice fired -->\n';

const baseContract = {
  objective: 'test',
  model: 'claude-sonnet',
  permissionMode: 'acceptEdits' as const,
  budgetCapUsd: 5,
  proofs: [],
  gates: { evaluators: false, humanApprove: false },
  shareToTeam: false,
  parentDepth: 0,
};

const baseMission = (overrides: Partial<Mission>): Mission =>
  ({
    id: 'M-budget-test',
    title: 'Documentation step',
    status: 'queued',
    model: 'claude-sonnet',
    ...overrides,
  }) as Mission;

/** Wires listen()/invoke() so agent_run fires a synthetic agent://done event
 *  with the given cost, mirroring runtimeRetry.test.ts's error-event
 *  pattern. `worktreeDiffResult` controls what agent_worktree_diff resolves
 *  to (a genuine diff, or '' for an empty deliverable). */
function wireNativeRun(opts: { costUsd: number; worktreeDiffResult: string }): {
  worktreePath: string;
  invokedCommands: () => string[];
} {
  const worktreePath = 'C:\\repo\\.lazy\\worktrees\\mission-budget';
  const handlers = new Map<string, (event: { payload: unknown }) => void>();
  mockedListen.mockImplementation((eventName: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(eventName, handler);
    return Promise.resolve(() => {
      handlers.delete(eventName);
    });
  });

  mockedInvoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'agent_create_worktree') {
      return Promise.resolve(worktreePath);
    }
    if (cmd === 'agent_run') {
      const req = args?.req as { id: string } | undefined;
      const doneHandler = req ? handlers.get(`agent://done/${req.id}`) : undefined;
      // Fires synchronously, before invoke() even returns — mirrors
      // runtimeRetry.test.ts — so planAndActLive's agentFinished resolves
      // without any real wait.
      doneHandler?.({
        payload: {
          result: 'Docs written.',
          exit_code: 0,
          duration_ms: 4200,
          input_tokens: 12000,
          output_tokens: 3000,
          cost_usd: opts.costUsd,
          tool_count: 6,
        },
      });
      return Promise.resolve(undefined);
    }
    if (cmd === 'agent_worktree_diff') {
      return Promise.resolve(opts.worktreeDiffResult);
    }
    if (cmd === 'agent_discard_worktree') {
      return Promise.resolve(undefined);
    }
    if (cmd === 'agent_run_kill') {
      return Promise.resolve(undefined);
    }
    return Promise.resolve(undefined);
  });

  return {
    worktreePath,
    invokedCommands: () => mockedInvoke.mock.calls.map(([cmd]) => cmd as string),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  setTauriRuntime(true);
});

afterEach(() => {
  setTauriRuntime(false);
});

describe('runMission — native rail, notional cost over cap (Fix D: no kill, no regression on real diff)', () => {
  it('is NOT stopped — no kill call, completes to review, keeps the worktree and the real diff', async () => {
    const { invokedCommands } = wireNativeRun({ costUsd: 13.69, worktreeDiffResult: REAL_DIFF });
    const mission = baseMission({ contract: { ...baseContract, budgetCapUsd: 5 } });

    const onUpdate = vi.fn();
    await runMission(mission, 'C:\\repo', { onUpdate, stopSignal: () => false });

    // The exact regression this fixes: crossing the notional cap must never
    // discard a real deliverable, and must never even attempt a kill (the
    // process has no real spend to protect against).
    expect(invokedCommands()).not.toContain('agent_discard_worktree');
    expect(invokedCommands()).not.toContain('agent_run_kill');

    const patches = onUpdate.mock.calls.map((c) => (c[0] as { patch: Partial<Mission> }).patch);
    const finalPatch = [...patches].reverse().find((p) => p.status !== undefined);
    expect(finalPatch?.status).toBe('review');
    expect(finalPatch?.worktree).toBeTruthy();
    expect(finalPatch?.diffFiles).toEqual([{ filename: 'README.md', added: 1, removed: 0 }]);
    expect(finalPatch?.diffAdded).toBe(1);
    expect(finalPatch?.emptyDeliverable).toBe(false);
    // No cap-exceeded verdict — this was a normal completion, not a stop.
    expect(finalPatch?.statusReason).toBeFalsy();
  });

  it('surfaces an honest, non-terminal FYI in CREDITS — never a dollar figure, never framed as real spend', async () => {
    wireNativeRun({ costUsd: 13.69, worktreeDiffResult: REAL_DIFF });
    const mission = baseMission({ contract: { ...baseContract, budgetCapUsd: 5 } });

    const onUpdate = vi.fn();
    await runMission(mission, 'C:\\repo', { onUpdate, stopSignal: () => false });

    const patches = onUpdate.mock.calls.map((c) => (c[0] as { patch: Partial<Mission> }).patch);
    const finalPatch = [...patches].reverse().find((p) => p.status !== undefined);
    const timelineText = (finalPatch?.actionTimeline ?? []).map((e) => e.text).join(' | ');
    // $13.69 -> 1369 credits (usdToCredits, "1 credit == 1 USD cent").
    expect(timelineText).toContain('1369');
    expect(timelineText).toContain('crédits');
    // Never mistakable for a real debit or a real stop.
    expect(timelineText).not.toContain('$');
    expect(timelineText.toLowerCase()).toMatch(/non débit|non interrompue/);
  });

  it('a DIFFERENT overshoot produces a DIFFERENT credits figure in the same run (proves it is computed, not a fixed literal)', async () => {
    wireNativeRun({ costUsd: 6.77, worktreeDiffResult: REAL_DIFF });
    const mission = baseMission({ contract: { ...baseContract, budgetCapUsd: 5 } });

    const onUpdate = vi.fn();
    await runMission(mission, 'C:\\repo', { onUpdate, stopSignal: () => false });

    const patches = onUpdate.mock.calls.map((c) => (c[0] as { patch: Partial<Mission> }).patch);
    const finalPatch = [...patches].reverse().find((p) => p.status !== undefined);
    const timelineText = (finalPatch?.actionTimeline ?? []).map((e) => e.text).join(' | ');
    // $6.77 -> 677 credits.
    expect(timelineText).toContain('677');
  });
});

describe('runMission — native rail, notional cost over cap, genuinely empty diff', () => {
  it('completes normally (review, emptyDeliverable) — the cap alone is no longer a reason to discard the worktree', async () => {
    const { invokedCommands } = wireNativeRun({ costUsd: 8, worktreeDiffResult: '' });
    const mission = baseMission({ contract: { ...baseContract, budgetCapUsd: 5 } });

    const onUpdate = vi.fn();
    await runMission(mission, 'C:\\repo', { onUpdate, stopSignal: () => false });

    expect(invokedCommands()).not.toContain('agent_discard_worktree');
    expect(invokedCommands()).not.toContain('agent_run_kill');

    const patches = onUpdate.mock.calls.map((c) => (c[0] as { patch: Partial<Mission> }).patch);
    const finalPatch = [...patches].reverse().find((p) => p.status !== undefined);
    expect(finalPatch?.status).toBe('review');
    expect(finalPatch?.emptyDeliverable).toBe(true);
    expect(finalPatch?.statusReason).toBeFalsy();
  });
});

describe('runMission — under-cap mission (regression: unaffected)', () => {
  it('completes to review normally — no budget-related timeline note at all', async () => {
    const { invokedCommands } = wireNativeRun({ costUsd: 2.1, worktreeDiffResult: REAL_DIFF });
    const mission = baseMission({ contract: { ...baseContract, budgetCapUsd: 5 } });

    const onUpdate = vi.fn();
    await runMission(mission, 'C:\\repo', { onUpdate, stopSignal: () => false });

    expect(invokedCommands()).not.toContain('agent_discard_worktree');
    const patches = onUpdate.mock.calls.map((c) => (c[0] as { patch: Partial<Mission> }).patch);
    // Find the patch that actually sets a terminal status — later patches
    // (Step E/F: orchestrator fan-out check, evaluation gate) may fire
    // additional onUpdate calls that don't touch `status` at all, so the
    // LAST call isn't necessarily the one that set it.
    const statusPatch = [...patches].reverse().find((p) => p.status !== undefined);
    expect(statusPatch?.status).toBe('review');
    expect(patches.some((p) => p.status === 'failed')).toBe(false);
    const timelineText = (statusPatch?.actionTimeline ?? []).map((e) => e.text).join(' | ');
    expect(timelineText).not.toContain('crédits');
    expect(timelineText.toLowerCase()).not.toContain('plafond');
  });
});
