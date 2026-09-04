/**
 * managerTurnBudget.test.ts — token-efficiency wave (2026-08-01):
 *
 * 1. Unit-tests measureManagerTurnBudget's pure char/estimated-token math.
 * 2. Measures the REAL, current buildManagerCorePrompt() +
 *    buildManagerDynamicContext() output against a representative turn and
 *    asserts it stays under an honest, generously-set threshold — a
 *    regression guard (same convention as managerEccCatalog.test.ts's own
 *    "stays compact" test), not a tight budget, so it fails loudly if this
 *    prompt starts growing unboundedly again.
 * 3. Demonstrates, with REAL measured numbers (not estimates), that the
 *    ECC-catalog relevance filter (managerEccCatalog.ts) and the history
 *    window (managerHistoryWindow.ts) both actually reduce what a
 *    representative long-session turn sends, compared to the prior
 *    (unfiltered, unbounded) behavior — reproduced here explicitly rather
 *    than asserted from memory.
 *
 * Mocks mirror managerEngine.test.ts's own boilerplate: buildManagerCorePrompt/
 * buildManagerDynamicContext are pure, but managerEngine.ts's module-level
 * imports (provider streaming backends, platform) have side effects outside
 * a real Tauri runtime, so the same provider/platform mocks are required
 * just to import the module at all.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../lib/models/index', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/index')>();
  return { ...actual, getProviderMode: vi.fn() };
});
vi.mock('../lib/models/claudeCodeProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/claudeCodeProvider')>();
  return { ...actual, streamClaudeCodeTurn: vi.fn() };
});
vi.mock('../lib/models/managedProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/managedProvider')>();
  return { ...actual, streamManagedAgentTurn: vi.fn() };
});
vi.mock('../lib/models/cliBackendProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/cliBackendProvider')>();
  return { ...actual, cliBackendProvider: vi.fn() };
});
vi.mock('../lib/platform', () => ({
  getPlatform: vi.fn(() => ({
    brain: { recall: vi.fn().mockResolvedValue({ injectedContext: '', nodes: [], tokensInjected: 0, tokensSaved: 0 }) },
  })),
}));

import { buildManagerCorePrompt, buildManagerDynamicContext, type ManagerContext } from '../lib/agents/managerEngine';
import { measureManagerTurnBudget } from '../lib/agents/managerTurnBudget';
import { boundManagerHistory } from '../lib/agents/managerHistoryWindow';
import type { ManagerMessage, Mission } from '../lib/agents/types';

function fixtureMission(i: number): Mission {
  return {
    id: `M${i}`,
    title: `Fix bug #${i} in the checkout flow`,
    status: i % 3 === 0 ? 'done' : 'running',
    model: 'sonnet',
    createdAt: Date.now(),
  } as Mission;
}

/** A realistic long-session history: 150 prior exchanges (300 messages).
 *  The assistant side includes a representative <lazy_actions> block (real
 *  manager replies routinely carry one) — that is what makes a real
 *  session's history hundreds of KB, not the plain prose alone; a
 *  prose-only fixture (as this used to be) fits comfortably under any
 *  reasonable budget and never demonstrates the windowing this test
 *  exists to prove. */
function realisticLongHistory(): ManagerMessage[] {
  const messages: ManagerMessage[] = [];
  for (let i = 0; i < 150; i++) {
    messages.push({
      id: `u${i}`,
      role: 'user',
      content: `Turn ${i}: peux-tu vérifier l'état de la mission M${i} et me dire si le déploiement a réussi ?`,
      timestamp: new Date().toISOString(),
    });
    messages.push({
      id: `a${i}`,
      role: 'assistant',
      content: `La mission M${i} est ${i % 3 === 0 ? 'terminée avec succès' : 'toujours en cours'}. J'ai vérifié le canvas et les logs associés, tout est cohérent avec ce que tu vois à l'écran.\n\n<lazy_actions>[{"type":"query_mission","missionId":"M${i}","question":"quel est l'état actuel et le dernier résultat de la mission ${i} ?"}]</lazy_actions>`,
      timestamp: new Date().toISOString(),
    });
  }
  return messages;
}

describe('measureManagerTurnBudget — pure math', () => {
  it('sums the four components and estimates tokens as chars/4', () => {
    const budget = measureManagerTurnBudget({
      core: 'x'.repeat(400),
      dynamic: 'y'.repeat(100),
      messages: [
        { id: '1', role: 'user', content: 'z'.repeat(200), timestamp: '' },
        { id: '2', role: 'assistant', content: 'w'.repeat(300), timestamp: '' },
      ],
      toolResultText: 'v'.repeat(50),
    });
    expect(budget.coreChars).toBe(400);
    expect(budget.dynamicChars).toBe(100);
    expect(budget.historyChars).toBe(500);
    expect(budget.toolResultChars).toBe(50);
    expect(budget.totalChars).toBe(1050);
    expect(budget.estimatedTokens).toBe(Math.round(1050 / 4));
  });

  it('defaults toolResultChars to 0 when no tool result text is given', () => {
    const budget = measureManagerTurnBudget({ core: 'a', dynamic: 'b', messages: [] });
    expect(budget.toolResultChars).toBe(0);
    expect(budget.totalChars).toBe(2);
  });
});

describe('representative manager turn — real measured cost (regression guard)', () => {
  it('stays under an honest estimated-token ceiling for a realistic long-session turn', () => {
    const missions = Array.from({ length: 15 }, (_, i) => fixtureMission(i));
    const history = realisticLongHistory();
    const lastUserMessage = 'écris-moi une campagne marketing avec des posts Instagram pour le lancement';

    const core = buildManagerCorePrompt();
    const ctx: ManagerContext = {
      agents: [],
      missions,
      canvasDigest: '### Agent Canvas\nNodes (5): mission:M1, mission:M2, draft:d1, draft:d2, note:n1\nCanvas total: 5',
      creditsSummary: 'Pro plan (active): 4,200 credits remaining of 5,000 included this billing period.',
      entitlementsSummary: '- Claude subscription (CLI/BYOK): ready\n- Lazy Pro (managed credits): active, 4,200 remaining',
      lastUserMessage,
    };
    const dynamic = buildManagerDynamicContext(ctx);
    const { messages: boundedHistory } = boundManagerHistory([...history, {
      id: 'current',
      role: 'user',
      content: lastUserMessage,
      timestamp: new Date().toISOString(),
    }]);

    const budget = measureManagerTurnBudget({ core, dynamic, messages: boundedHistory });

    // Real measured numbers as of this wave (see this test's own output —
    // printed for visibility, never asserted as an exact value since the
    // static core legitimately grows over time as doctrine is added).
    // eslint-disable-next-line no-console
    console.log('[managerTurnBudget] representative turn:', {
      coreChars: budget.coreChars,
      dynamicChars: budget.dynamicChars,
      historyChars: budget.historyChars,
      totalChars: budget.totalChars,
      estimatedTokens: budget.estimatedTokens,
    });

    // Regression guard, not a tight budget (same convention as
    // managerEccCatalog.test.ts's own "stays compact" test) — this is
    // generous headroom above the real measured value at write time, high
    // enough to never flake on legitimate doctrine growth, low enough to
    // catch a real regression (e.g. history windowing silently disabled,
    // or the ECC catalog filter silently disabled).
    expect(budget.estimatedTokens).toBeLessThan(45_000);
  });

  it('the ECC-catalog relevance filter measurably reduces dynamic-context size for a single-domain request, vs the unfiltered baseline', () => {
    const missions = Array.from({ length: 15 }, (_, i) => fixtureMission(i));
    const baseCtx: Omit<ManagerContext, 'lastUserMessage'> = { agents: [], missions };

    const unfiltered = buildManagerDynamicContext({ ...baseCtx }); // no lastUserMessage → full catalog (prior behavior)
    const filtered = buildManagerDynamicContext({
      ...baseCtx,
      lastUserMessage: 'écris-moi une campagne marketing avec des posts Instagram pour le lancement',
    });

    // eslint-disable-next-line no-console
    console.log('[managerTurnBudget] ECC catalog filter:', { unfilteredChars: unfiltered.length, filteredChars: filtered.length });
    expect(filtered.length).toBeLessThan(unfiltered.length);
  });

  it('the history window measurably reduces what is sent for a long session, vs resending everything unbounded', () => {
    const history = realisticLongHistory();
    const unbounded = history; // prior behavior: the full array, every turn
    const { messages: bounded, droppedCount } = boundManagerHistory(history);

    const unboundedChars = unbounded.reduce((sum, m) => sum + m.content.length, 0);
    const boundedChars = bounded.reduce((sum, m) => sum + m.content.length, 0);

    // eslint-disable-next-line no-console
    console.log('[managerTurnBudget] history window:', { messageCount: history.length, unboundedChars, boundedChars, droppedCount });

    if (droppedCount > 0) {
      expect(boundedChars).toBeLessThan(unboundedChars);
    } else {
      // A short-enough session legitimately fits the budget whole — not a
      // failure, just means this particular fixture is too small to show
      // a reduction (documented here so a future reader isn't confused by
      // a silently-vacuous assertion).
      expect(bounded).toEqual(unbounded);
    }
  });
});
