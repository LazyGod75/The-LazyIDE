/**
 * runtimeManagedBudgetCapKill.test.ts
 *
 * Regression guard for the 2026-08-19 dollar-kill incident fix: the fix
 * exempts the NATIVE Claude/Codex CLI rail from the budget-cap kill (its
 * costUsd is a notional API-list-price equivalent, never real spend — see
 * runtime.ts's `isNativeRail`/checkNativeBudget). The managed/Pro rail,
 * where credits ARE really debited, must keep its existing enforcement
 * completely unchanged — this file proves that via runMission's real
 * managed (planAndActManaged) path, mirroring
 * runtimeBudgetCapSalvage.test.ts's native-side harness.
 *
 * Also proves the shared stop message (formatBudgetExceededMessage) now
 * reports the real spend/cap in CREDITS ("1 credit == 1 USD cent" —
 * billing/credits.ts's usdToCredits, the same conversion CostChip.tsx's
 * real-spend branch already used) rather than a raw dollar figure — the
 * display-honesty half of the same fix, applied to the rail where the
 * number is real money.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import { invoke } from '@tauri-apps/api/core';

// ── Mock managedProvider's streamManagedAgentTurn — same technique as
// managedAgent.test.ts. The mocked turn's content never matters: a
// near-zero budgetCapUsd guarantees the FIRST turn's cost accounting
// already reads 'exceeded' at the loop's own budget checkpoint, BEFORE any
// action executes. ───────────────────────────────────────────────────────
vi.mock('../lib/models/managedProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/managedProvider')>();
  return {
    ...actual,
    streamManagedAgentTurn: vi.fn(),
  };
});

vi.mock('../lib/agents/agentsStorage', () => ({
  listAgents: vi.fn().mockResolvedValue([]),
}));

// Partial mock (importOriginal) rather than a hand-maintained stub list —
// runMission's provider-mode detection (models/index.ts's getProviderMode)
// calls the real `isTauri`, which a hand-copied export list drops; keeping
// the real export here means it stays correct as this module grows new
// exports other call paths start using.
vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return {
    ...actual,
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
      fs: {
        createDir: vi.fn().mockResolvedValue(undefined),
        writeFile: vi.fn().mockResolvedValue(undefined),
      },
      // No `git` property on purpose — computeMissionDiff's git.status() call
      // is defensively try/caught, degrading to diffIncompleteFiles=[]
      // (runtimeBudgetCapSalvage.test.ts's own platform mock does the same).
    })),
  };
});

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

vi.mock('../lib/agents/agentSessionGate', () => ({
  gateAgentSession: vi.fn(async () => ({ ok: true, rail: 'cli' })),
}));

import { runMission } from '../lib/agents/runtime';
import { streamManagedAgentTurn } from '../lib/models/managedProvider';
import type { Mission } from '../lib/agents/types';

const mockedInvoke = invoke as ReturnType<typeof vi.fn>;
const mockedStream = streamManagedAgentTurn as ReturnType<typeof vi.fn>;

function setTauriRuntime(active: boolean): void {
  const w = window as unknown as Record<string, unknown>;
  if (active) {
    w['__TAURI_INTERNALS__'] = {};
  } else {
    delete w['__TAURI_INTERNALS__'];
  }
}

/** Async generator yielding a single text chunk — same shape
 *  managedAgent.test.ts's own makeStream helper produces. The content never
 *  matters here (see this file's header): the budget check fires before any
 *  parsed action executes. */
async function* makeStream(text: string): AsyncIterable<string> {
  yield text;
}

const REAL_DIFF =
  'diff --git a/README.md b/README.md\n' +
  'index 22e067e..91c36bd 100644\n' +
  '--- a/README.md\n' +
  '+++ b/README.md\n' +
  '@@ -1,3 +1,4 @@\n' +
  ' # alpha\n' +
  '+<!-- shipped before the budget cap fired -->\n';

const baseContract = {
  objective: 'test',
  model: 'anthropic/claude-sonnet-5',
  permissionMode: 'acceptEdits' as const,
  // Near-zero on purpose — any real turn's accounted cost already exceeds
  // this, so the loop's OWN live check (managedAgent.ts) fires on turn 1.
  budgetCapUsd: 0.0001,
  proofs: [],
  gates: { evaluators: false, humanApprove: false },
  shareToTeam: false,
  parentDepth: 0,
};

const baseMission = (overrides: Partial<Mission>): Mission =>
  ({
    id: 'M-managed-budget-test',
    title: 'Managed documentation step',
    status: 'queued',
    model: 'anthropic/claude-sonnet-5',
    ...overrides,
  }) as Mission;

function wireManagedRun(worktreeDiffResult: string): void {
  const worktreePath = 'C:\\repo\\.lazy\\worktrees\\mission-managed-budget';
  mockedInvoke.mockImplementation((cmd: string) => {
    if (cmd === 'agent_create_worktree') return Promise.resolve(worktreePath);
    if (cmd === 'agent_worktree_diff') return Promise.resolve(worktreeDiffResult);
    if (cmd === 'agent_discard_worktree') return Promise.resolve(undefined);
    return Promise.resolve(undefined);
  });
  mockedStream.mockImplementation(() =>
    makeStream('THOUGHT: working\nACTION: read_file\nARGS: {"path": "README.md"}'),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  setTauriRuntime(true);
  wireManagedRun(REAL_DIFF);
});

describe('runMission — managed rail, budget cap exceeded (no regression: real credits, real stop)', () => {
  it('still stops the mission — the managed engine keeps enforcing its own live budget cap unchanged', async () => {
    const mission = baseMission({ contract: { ...baseContract } });
    const onUpdate = vi.fn();

    await runMission(mission, 'C:\\repo', {
      onUpdate,
      stopSignal: () => false,
      getBudgetCapUsd: () => mission.contract?.budgetCapUsd,
    });

    const patches = onUpdate.mock.calls.map((c) => (c[0] as { patch: Partial<Mission> }).patch);
    const finalPatch = [...patches].reverse().find((p) => p.status !== undefined);
    // Salvaged (real diff present) -> 'review', not discarded — same Fix A/C
    // salvage behavior the native suite already proves; the KILL itself
    // (the loop stopping BEFORE producing more work) is what must survive
    // unchanged for this rail, not necessarily a full worktree wipe.
    expect(finalPatch?.status).toBe('review');
    expect(finalPatch?.statusReason).toBeTruthy();
    // The loop must have stopped at (or very near) the first turn — proves
    // the budget cap actually cut the run short rather than letting it run
    // to natural completion.
    expect(mockedStream.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it('reports the stop in CREDITS ("1 credit == 1 USD cent"), never a raw dollar figure', async () => {
    const mission = baseMission({ contract: { ...baseContract, budgetCapUsd: 0.0001 } });
    const onUpdate = vi.fn();

    await runMission(mission, 'C:\\repo', {
      onUpdate,
      stopSignal: () => false,
      getBudgetCapUsd: () => mission.contract?.budgetCapUsd,
    });

    const patches = onUpdate.mock.calls.map((c) => (c[0] as { patch: Partial<Mission> }).patch);
    const finalPatch = [...patches].reverse().find((p) => p.status !== undefined);
    expect(finalPatch?.statusReason).toBeTruthy();
    // capUsd 0.0001 -> 0 credits (rounds down); this is a real-money rail so
    // the wording must be credits-based, not a "$"/"€" figure.
    expect(finalPatch?.statusReason).toMatch(/cr[ée]dit/i);
    expect(finalPatch?.statusReason).not.toMatch(/\$/);
  });
});
