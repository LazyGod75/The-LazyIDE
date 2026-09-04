/**
 * Tests for the W8c chainEngine/canvasStore additions:
 *   - PIN OUTPUT (deliverable #1): capture, fire-with-pin injection,
 *     « Relancer l'aval » (refireChainDownstream) without a source run,
 *     unpin, and the refire × lastFiredAtMs exactly-once interaction.
 *   - N-WAY ROUTER (deliverable #3): resolveRouterBranch ordered/contains/
 *     default resolution (pure), fire-time routing inside attemptFire,
 *     persistence roundtrip (ChainsFileV1.routers, V1-compatible), chain
 *     validation into/out of a router, and computeCascadeDepth walking
 *     THROUGH a router hop.
 *
 * Same harness as chainEngine.test.ts: `@tauri-apps/api/core`/`event` are
 * globally mocked by setup.ts; `invoke` is configured per test.
 *
 * Phase 5 note (re-skip audit, 2026-07-28; pin-lock restored 2026-08-12;
 * router resolution restored 2026-08-12) — see chainEngine.test.ts's module
 * doc for the full story of the initChainEngine/initSgrChainRunner split.
 *   - Pin-lock on the LIVE fire path: RESTORED. sgrChainRunner.ts's
 *     fireChain now honors chain.pinnedContext (same ternary as the manual
 *     refireChainDownstream in canvasChainOps.ts).
 *   - Router-targeted chains: RESTORED. sgrChainRunner.ts's fireChain now
 *     has a `target.kind === 'router'` branch (fireRouterChain) that
 *     resolves resolveRouterBranch against the completion and cascades
 *     into the winning branch's outgoing chain(s) via the same fireChain
 *     entry point — mirrors the old chainEngine.ts's attemptFire. This is
 *     the reactive per-mission hook itself being fixed, not a rewire onto
 *     runCanvasAsGraph (that full-canvas-run path still has zero
 *     production callers, confirmed by grep — unrelated to this fix).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { setSgrManagedDrafts, clearSgrManagedDrafts } from '../lib/agents/sgrChainRunner';
import {
  initChainEngine,
  initSgrChainRunner,
  onMissionTerminal,
  buildContextBlock,
  capturePinnedOutput,
  refireChainDownstream,
  resolveRouterBranch,
  computeCascadeDepth,
  _resetChainEngineForTests,
  type ChainEngineDeps,
} from '../lib/agents/chainEngine';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { validateChain } from '../components/agents/canvas/chainValidation';
import { isChainsFileV1 } from '../components/agents/canvas/canvasPersistence';
import {
  makeRef,
  parseRouterBranchRef,
  type Chain,
  type ChainCondition,
  type ChainsFileV1,
  type DraftSpec,
  type RouterBranch,
  type RouterSpec,
} from '../components/agents/canvas/canvasTypes';
import type { Mission } from '../lib/agents/types';

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

// ── Fixtures (same shapes as chainEngine.test.ts) ──────────────────

function mission(overrides: Partial<Mission> & { id: string }): Mission {
  return { title: `Mission ${overrides.id}`, status: 'running', model: 'sonnet', ...overrides };
}

function chain(overrides: Partial<Chain> & { id: string; sourceRef: string; targetRef: string; condition: ChainCondition }): Chain {
  return { createdBy: 'user', ...overrides };
}

function draft(overrides: Partial<DraftSpec> & { id: string }): DraftSpec {
  return { title: `Draft ${overrides.id}`, task: 'do the thing', createdBy: 'user', ...overrides };
}

function branch(overrides: Partial<RouterBranch> & { id: string }): RouterBranch {
  return { label: `Branch ${overrides.id}`, condition: { kind: 'default' }, ...overrides };
}

function router(overrides: Partial<RouterSpec> & { id: string; branches: RouterBranch[] }): RouterSpec {
  return { ...overrides };
}

/** Same dual-shape rationale as chainEngine.test.ts's makeDeps: covers both
 *  initChainEngine (== initCanvasChainOps) and initSgrChainRunner. */
function makeDeps(overrides: Partial<ChainEngineDeps> = {}): ChainEngineDeps & {
  addMission: ReturnType<typeof vi.fn>;
  waitForMissions: ReturnType<typeof vi.fn>;
  projectRoot: string;
} {
  let counter = 0;
  const addMission = vi.fn(async () => `M-new-${++counter}`);
  return {
    addMission,
    getActiveProjectId: vi.fn(async () => 'proj-1'),
    defaultModelId: vi.fn(() => 'sonnet'),
    waitForMissions: vi.fn(async () => []),
    projectRoot: '/tmp/test-project',
    ...overrides,
  } as ChainEngineDeps & {
    addMission: ReturnType<typeof vi.fn>;
    waitForMissions: ReturnType<typeof vi.fn>;
    projectRoot: string;
  };
}

/** Wires both chain-related singletons — needed only by tests that call
 *  `onMissionTerminal` (the live path lives in sgrChainRunner.ts). Tests
 *  that only call `refireChainDownstream` need just `initChainEngine`
 *  (canvasChainOps.ts owns that function, untouched by the Phase 5 split). */
function initBothEngines(deps: ReturnType<typeof makeDeps>): void {
  initChainEngine(deps);
  initSgrChainRunner(deps);
}

/** initChainEngine is now a no-op outside Tauri (chainEngine.ts's own
 *  isTauri() guard) — this suite exercises the real engine, so it locally
 *  fakes the Tauri sentinel exactly like nightShift.test.ts's
 *  enableTauri()/disableTauri() does (setup.ts deletes it globally). */
function enableTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}

function disableTauri(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  _resetChainEngineForTests();
  clearSgrManagedDrafts(); // hygiene — _resetChainEngineForTests does not touch this module singleton
  mockInvoke.mockReset();
  mockListen.mockReset();
  mockListen.mockResolvedValue(() => undefined);
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'journal_missions_current') return [];
    if (cmd === 'canvas_state_save') return undefined;
    if (cmd === 'canvas_state_load') return null;
    if (cmd === 'journal_emit') return 1;
    if (cmd === 'journal_emit_batch') return 1;
    throw new Error(`unexpected invoke: ${cmd}`);
  });
  enableTauri();
});

afterEach(() => {
  disableTauri();
});

// ── Pin output (deliverable #1) ──────────────────────────────────────

describe('pin output — capture', () => {
  it('capturePinnedOutput freezes the exact buildContextBlock text + source title', () => {
    const source = mission({ id: 'm1', status: 'done', title: 'Analyse de sécurité' });
    const pinned = capturePinnedOutput(source);
    expect(pinned.text).toBe(buildContextBlock(source));
    expect(pinned.sourceTitle).toBe('Analyse de sécurité');
    expect(pinned.pinnedAtMs).toBeGreaterThan(0);
  });

  it('pinChainOutput stores the snapshot on the CHAIN; unpinChainOutput removes it', () => {
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'success' }),
    );

    canvasStoreVanilla.getState().pinChainOutput('c1', { text: 'FROZEN', pinnedAtMs: 42, sourceTitle: 'T' });
    expect(canvasStoreVanilla.getState().chains.find((c) => c.id === 'c1')!.pinnedContext).toEqual({
      text: 'FROZEN',
      pinnedAtMs: 42,
      sourceTitle: 'T',
    });

    canvasStoreVanilla.getState().unpinChainOutput('c1');
    expect(canvasStoreVanilla.getState().chains.find((c) => c.id === 'c1')!.pinnedContext).toBeUndefined();
  });
});

describe('pin output — fire-with-pin injection', () => {
  // RESTORED 2026-08-12 (regression 3.5 of REGRESSIONS-CHAINES.md): the
  // reactive path (sgrChainRunner.ts's fireChain) now honors
  // `chain.pinnedContext` — same ternary as the manual "Relancer l'aval"
  // path (refireChainDownstream, canvasChainOps.ts) already used.
  it('a pinned chain injects the FROZEN snapshot instead of the live source output', async () => {
    const deps = makeDeps();
    initBothEngines(deps);
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1', task: 'Downstream task' }));
    canvasStoreVanilla.getState().addChain(
      chain({
        id: 'c1',
        sourceRef: makeRef('mission', 'm1'),
        targetRef: makeRef('draft', 'd1'),
        condition: 'success',
        pinnedContext: { text: '\n\n## FROZEN SNAPSHOT TEXT', pinnedAtMs: 1000, sourceTitle: 'Old run' },
      }),
    );

    onMissionTerminal(mission({ id: 'm1', status: 'done', title: 'Live title that must NOT be injected' }));
    await vi.waitFor(() => expect(deps.addMission).toHaveBeenCalledTimes(1));

    const call = deps.addMission.mock.calls[0][0];
    expect(call.agentTask).toContain('Downstream task');
    expect(call.agentTask).toContain('FROZEN SNAPSHOT TEXT');
    expect(call.agentTask).not.toContain('Live title that must NOT be injected');
  });

  // Anti-double-launch guard (2026-08-04 UC3 dogfood incident — see
  // sgrManagedDraftRefs' own doc comment in sgrChainRunner.ts): restoring
  // pin injection touches the SAME fireChain the double-launch fix lives
  // in. Prove the pin restoration did not reorder past the ownership guard
  // — a pinned chain whose target draft is owned by a live SGR plan run
  // must still be skipped, not fired a second time by this reactive path.
  it('a pinned chain does not double-fire when its target draft is owned by a live SGR plan run', async () => {
    const deps = makeDeps();
    initBothEngines(deps);
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1', task: 'Downstream task' }));
    canvasStoreVanilla.getState().addChain(
      chain({
        id: 'c1',
        sourceRef: makeRef('mission', 'm1'),
        targetRef: makeRef('draft', 'd1'),
        condition: 'success',
        pinnedContext: { text: '\n\n## FROZEN SNAPSHOT TEXT', pinnedAtMs: 1000, sourceTitle: 'Old run' },
      }),
    );

    setSgrManagedDrafts([makeRef('draft', 'd1')]);
    try {
      onMissionTerminal(mission({ id: 'm1', status: 'done' }));
      await new Promise((r) => setTimeout(r, 20));
      expect(deps.addMission).not.toHaveBeenCalled();
    } finally {
      clearSgrManagedDrafts();
    }
  });

  // Still genuinely green under current behavior, kept active — but note
  // the caveat: since the live path never honors a pin at all anymore (see
  // the skip above), this no longer proves an unpin -> revert TOGGLE, only
  // that live firing injects fresh buildContextBlock output (true on its
  // own, still worth guarding).
  it('after unpin, the SAME chain reverts to live buildContextBlock injection', async () => {
    const deps = makeDeps();
    initBothEngines(deps);
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addChain(
      chain({
        id: 'c1',
        sourceRef: makeRef('mission', 'm1'),
        targetRef: makeRef('draft', 'd1'),
        condition: 'success',
        pinnedContext: { text: '\n\n## FROZEN', pinnedAtMs: 1000, sourceTitle: 'Old' },
      }),
    );
    canvasStoreVanilla.getState().unpinChainOutput('c1');

    onMissionTerminal(mission({ id: 'm1', status: 'done', title: 'Fresh live title' }));
    await vi.waitFor(() => expect(deps.addMission).toHaveBeenCalledTimes(1));

    const call = deps.addMission.mock.calls[0][0];
    expect(call.agentTask).toContain('## CONTEXTE AMONT');
    expect(call.agentTask).toContain('Fresh live title');
    expect(call.agentTask).not.toContain('FROZEN');
  });
});

describe('pin output — « Relancer l\'aval » (refireChainDownstream)', () => {
  it('re-fires the target from the pinned snapshot WITHOUT running the source and WITHOUT consuming lastFiredAtMs', async () => {
    const deps = makeDeps();
    initChainEngine(deps);
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1', task: 'Replayable task' }));
    canvasStoreVanilla.getState().addChain(
      chain({
        id: 'c1',
        sourceRef: makeRef('mission', 'm1'),
        targetRef: makeRef('draft', 'd1'),
        condition: 'success',
        pinnedContext: { text: '\n\n## PINNED CONTEXT', pinnedAtMs: 1000, sourceTitle: 'Old' },
      }),
    );

    const outcome = await refireChainDownstream('c1');
    expect(outcome).toBe('refired');
    expect(deps.addMission).toHaveBeenCalledTimes(1);
    expect(deps.addMission.mock.calls[0][0].agentTask).toContain('PINNED CONTEXT');

    // Exactly-once interaction (documented in refireChainDownstream's doc
    // comment): a manual replay NEVER advances the automatic-fire high-water
    // mark, and never remaps/consumes the draft — the same snapshot stays
    // replayable, and a FUTURE real source completion still fires normally.
    const c1 = canvasStoreVanilla.getState().chains.find((c) => c.id === 'c1')!;
    expect(c1.lastFiredAtMs).toBeUndefined();
    expect(canvasStoreVanilla.getState().drafts.some((d) => d.id === 'd1')).toBe(true);

    // ...and it IS repeatable (the whole point of the token-saver).
    await refireChainDownstream('c1');
    expect(deps.addMission).toHaveBeenCalledTimes(2);
  });

  it('a refire does not interfere with the automatic exactly-once path: a later REAL completion still fires', async () => {
    const deps = makeDeps();
    initBothEngines(deps); // needs sgrChainRunner too — this test also exercises the live onMissionTerminal path
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addChain(
      chain({
        id: 'c1',
        sourceRef: makeRef('mission', 'm1'),
        targetRef: makeRef('draft', 'd1'),
        condition: 'success',
        pinnedContext: { text: '\n\n## PINNED', pinnedAtMs: 1000, sourceTitle: 'Old' },
      }),
    );

    await refireChainDownstream('c1');
    expect(deps.addMission).toHaveBeenCalledTimes(1);

    onMissionTerminal(mission({ id: 'm1', status: 'done' }));
    await vi.waitFor(() => expect(deps.addMission).toHaveBeenCalledTimes(2));
    // The real fire consumed the completion as usual.
    expect(canvasStoreVanilla.getState().chains.find((c) => c.id === 'c1')!.lastFiredAtMs).toBeDefined();
  });

  it('refuses honestly for an unpinned chain, an unknown chain, and a launched (non-draft) target', async () => {
    const deps = makeDeps();
    initChainEngine(deps);
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c-unpinned', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'success' }),
    );
    canvasStoreVanilla.getState().addChain(
      chain({
        id: 'c-launched',
        sourceRef: makeRef('mission', 'm1'),
        targetRef: makeRef('mission', 'm2'),
        condition: 'success',
        pinnedContext: { text: 'X', pinnedAtMs: 1, sourceTitle: 'T' },
      }),
    );

    expect(await refireChainDownstream('c-unpinned')).toBe('skipped-not-pinned');
    expect(await refireChainDownstream('nope')).toBe('skipped-chain-missing');
    expect(await refireChainDownstream('c-launched')).toBe('skipped-target-not-draft');
    expect(deps.addMission).not.toHaveBeenCalled();
  });

  it('refuses honestly (never launches) when the pinned target draft belongs to an inactive project', async () => {
    const deps = makeDeps({ getActiveProjectId: vi.fn(async () => 'proj-active') });
    initChainEngine(deps);
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1', projectId: 'proj-other' }));
    canvasStoreVanilla.getState().addChain(
      chain({
        id: 'c1',
        sourceRef: makeRef('mission', 'm1'),
        targetRef: makeRef('draft', 'd1'),
        condition: 'success',
        pinnedContext: { text: 'X', pinnedAtMs: 1, sourceTitle: 'T' },
      }),
    );

    expect(await refireChainDownstream('c1')).toBe('skipped-inactive-project');
    expect(deps.addMission).not.toHaveBeenCalled();
  });
});

// ── Router node (deliverable #3) ─────────────────────────────────────

describe('resolveRouterBranch (pure)', () => {
  const doneMission = mission({ id: 'm1', status: 'done' });
  const failedMission = mission({ id: 'm1', status: 'failed' });

  it('evaluates branches IN ORDER — first match wins even when a later branch also matches', () => {
    const branches: RouterBranch[] = [
      branch({ id: 'b1', condition: { kind: 'contains', value: 'timeout' } }),
      branch({ id: 'b2', condition: { kind: 'outcome', value: 'success' } }),
      branch({ id: 'b3', condition: { kind: 'default' } }),
    ];
    // Output contains 'timeout' AND the mission is done — b1 wins by order.
    expect(resolveRouterBranch(branches, doneMission, 'the run hit a TIMEOUT twice')!.id).toBe('b1');
    // Without the keyword, b2 (outcome success) matches next.
    expect(resolveRouterBranch(branches, doneMission, 'all green')!.id).toBe('b2');
  });

  it('outcome fail matches a failed mission; default catches everything else', () => {
    const branches: RouterBranch[] = [
      branch({ id: 'b1', condition: { kind: 'outcome', value: 'fail' } }),
      branch({ id: 'b2', condition: { kind: 'default' } }),
    ];
    expect(resolveRouterBranch(branches, failedMission, '')!.id).toBe('b1');
    expect(resolveRouterBranch(branches, doneMission, '')!.id).toBe('b2');
  });

  it('contains matches case-insensitively', () => {
    const branches: RouterBranch[] = [branch({ id: 'b1', condition: { kind: 'contains', value: 'FlAkY' } })];
    expect(resolveRouterBranch(branches, doneMission, 'this looks flaky to me')!.id).toBe('b1');
  });

  it('returns null with no branches, or when nothing matches and there is no default', () => {
    expect(resolveRouterBranch([], doneMission, 'x')).toBeNull();
    const noDefault: RouterBranch[] = [branch({ id: 'b1', condition: { kind: 'outcome', value: 'fail' } })];
    expect(resolveRouterBranch(noDefault, doneMission, 'x')).toBeNull();
  });
});

describe('router — fire-time routing inside the engine', () => {
  function seedRouterGraph(): void {
    canvasStoreVanilla.getState().addRouter(
      router({
        id: 'R1',
        branches: [
          branch({ id: 'b-ok', condition: { kind: 'outcome', value: 'success' } }),
          branch({ id: 'b-else', condition: { kind: 'default' } }),
        ],
      }),
    );
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd-ok', task: 'deploy it' }));
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd-else', task: 'debug it' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c-in', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('router', 'R1'), condition: 'always' }),
    );
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c-ok', sourceRef: makeRef('router', 'R1:b-ok'), targetRef: makeRef('draft', 'd-ok'), condition: 'always' }),
    );
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c-else', sourceRef: makeRef('router', 'R1:b-else'), targetRef: makeRef('draft', 'd-else'), condition: 'always' }),
    );
  }

  // RESTORED 2026-08-12 (regression 3.2 of REGRESSIONS-CHAINES.md):
  // sgrChainRunner.ts's fireChain now has a `target.kind === 'router'`
  // branch (fireRouterChain) that resolves resolveRouterBranch against the
  // completion and cascades into the winning branch's own outgoing
  // chain(s) via the same fireChain entry point — mirrors the old
  // chainEngine.ts's attemptFire exactly. runCanvasAsGraph (the
  // full-canvas-run replacement the old comment pointed to) is still never
  // called from any production component — this reactive per-mission hook
  // is the fix, not a bridge to that path.
  it('a done source routes through the SUCCESS branch only (one launch, the right draft)', async () => {
    const deps = makeDeps();
    initBothEngines(deps);
    seedRouterGraph();

    onMissionTerminal(mission({ id: 'm1', status: 'done' }));
    await vi.waitFor(() => expect(deps.addMission).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 10)); // no second launch sneaks in

    expect(deps.addMission).toHaveBeenCalledTimes(1);
    expect(deps.addMission.mock.calls[0][0].agentTask).toContain('deploy it');
    // The into-router chain consumed the completion (exactly-once preserved
    // through the router hop).
    expect(canvasStoreVanilla.getState().chains.find((c) => c.id === 'c-in')!.lastFiredAtMs).toBeDefined();
    // The untaken branch's draft is untouched.
    expect(canvasStoreVanilla.getState().drafts.some((d) => d.id === 'd-else')).toBe(true);
  });

  // RESTORED 2026-08-12 — same fireRouterChain path as above.
  it('a failed source falls through to the DEFAULT branch', async () => {
    const deps = makeDeps();
    initBothEngines(deps);
    seedRouterGraph();

    onMissionTerminal(mission({ id: 'm1', status: 'failed' }));
    await vi.waitFor(() => expect(deps.addMission).toHaveBeenCalledTimes(1));

    expect(deps.addMission.mock.calls[0][0].agentTask).toContain('debug it');
    expect(canvasStoreVanilla.getState().drafts.some((d) => d.id === 'd-ok')).toBe(true);
  });

  // RESTORED 2026-08-12 — fireRouterChain marks the into-router chain fired
  // when the router itself is gone, so a vanished-router completion is
  // consumed honestly instead of staying "never examined" forever.
  it('a vanished router consumes the completion honestly (skipped, never retried forever)', async () => {
    const deps = makeDeps();
    initBothEngines(deps);
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c-in', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('router', 'ghost'), condition: 'always' }),
    );

    onMissionTerminal(mission({ id: 'm1', status: 'done' }));
    await vi.waitFor(() => {
      if (canvasStoreVanilla.getState().chains.find((c) => c.id === 'c-in')!.lastFiredAtMs === undefined) {
        throw new Error('not consumed yet');
      }
    });
    expect(deps.addMission).not.toHaveBeenCalled();
  });

  // Anti-double-launch guard (2026-08-04 UC3 dogfood incident — see
  // sgrManagedDraftRefs' own doc comment in sgrChainRunner.ts): the router
  // restoration recurses into the SAME fireChain the double-launch fix
  // lives in (fireRouterChain -> fireChain for the winning branch's own
  // outgoing chain). Prove the router path does not bypass the ownership
  // guard — a router branch whose target draft is owned by a live SGR plan
  // run must still be skipped, not fired a second time through this
  // reactive path.
  it('a resolved router branch does not double-fire when its target draft is owned by a live SGR plan run', async () => {
    const deps = makeDeps();
    initBothEngines(deps);
    seedRouterGraph();

    setSgrManagedDrafts([makeRef('draft', 'd-ok')]);
    try {
      onMissionTerminal(mission({ id: 'm1', status: 'done' }));
      await new Promise((r) => setTimeout(r, 20));
      expect(deps.addMission).not.toHaveBeenCalled();
      // The into-router chain is still consumed — only the branch's launch
      // is skipped, not the router resolution itself.
      expect(canvasStoreVanilla.getState().chains.find((c) => c.id === 'c-in')!.lastFiredAtMs).toBeDefined();
    } finally {
      clearSgrManagedDrafts();
    }
  });
});

describe('router — persistence + refs + validation + cascade depth', () => {
  it('routers roundtrip through ChainsFileV1 (additive, V1-compatible) and hydrate', () => {
    const spec = router({
      id: 'R1',
      projectId: 'proj-1',
      branches: [branch({ id: 'b1', label: 'ok', condition: { kind: 'outcome', value: 'success' } })],
    });
    const file: ChainsFileV1 = { version: 1, chains: [], drafts: [], routers: [spec] };
    const parsed = JSON.parse(JSON.stringify(file)) as ChainsFileV1;

    // A file WITH routers still validates as V1; a legacy file WITHOUT the
    // field also validates and hydrates to zero routers.
    expect(isChainsFileV1(parsed)).toBe(true);
    expect(isChainsFileV1({ version: 1, chains: [], drafts: [] })).toBe(true);

    canvasStoreVanilla.getState().hydrate(null, parsed);
    expect(canvasStoreVanilla.getState().routers).toEqual([spec]);

    canvasStoreVanilla.getState().hydrate(null, { version: 1, chains: [], drafts: [] });
    expect(canvasStoreVanilla.getState().routers).toEqual([]);
  });

  it('parseRouterBranchRef splits router:R1:b1 and rejects a plain router ref', () => {
    expect(parseRouterBranchRef(makeRef('router', 'R1:b1'))).toEqual({ routerId: 'R1', branchId: 'b1' });
    expect(parseRouterBranchRef(makeRef('router', 'R1'))).toBeNull();
    expect(parseRouterBranchRef(makeRef('mission', 'm1'))).toBeNull();
  });

  it('validateChain: chains INTO a router are legal, router→router is legal, and cycle detection still applies', () => {
    // mission -> router: legal.
    expect(validateChain([], makeRef('mission', 'm1'), makeRef('router', 'R1'), { kind: 'router' })).toEqual({ ok: true });
    // router branch -> another router: legal.
    expect(validateChain([], makeRef('router', 'R1:b1'), makeRef('router', 'R2'), { kind: 'router' })).toEqual({ ok: true });
    // Direct cycle through router refs is still rejected.
    const existing: Chain[] = [
      chain({ id: 'c1', sourceRef: makeRef('router', 'R2'), targetRef: makeRef('router', 'R1'), condition: 'always' }),
    ];
    const result = validateChain(existing, makeRef('router', 'R1'), makeRef('router', 'R2'), { kind: 'router' });
    expect(result.ok).toBe(false);
  });

  it('computeCascadeDepth walks THROUGH a router hop (branch chain counts its into-router predecessor)', () => {
    const chains: Chain[] = [
      chain({ id: 'c-in', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('router', 'R1'), condition: 'always' }),
      chain({ id: 'c-branch', sourceRef: makeRef('router', 'R1:b1'), targetRef: makeRef('draft', 'd1'), condition: 'always' }),
    ];
    expect(computeCascadeDepth(chains, 'c-in')).toBe(1);
    expect(computeCascadeDepth(chains, 'c-branch')).toBe(2);
  });
});
