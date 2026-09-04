/**
 * Tests for joinEngine.ts (W-JOIN) — fan-in (all-of) join firing, wired
 * through chainEngine.ts's real `onMissionTerminal`/`reconcileChains`
 * entry points (never calling joinEngine's internals directly, so these
 * tests prove the ACTUAL wiring, not just the isolated module). Harness
 * mirrors chainEngine.test.ts/chainEnginePinRouter.test.ts exactly:
 * `@tauri-apps/api/core`/`event` are globally mocked by setup.ts; `invoke`
 * is configured per test via `installInvokeFake`.
 *
 * LIVE-PATH WIRING RESTORED (2026-08-12 — regression 3.1 of
 * REGRESSIONS-CHAINES.md): sgrChainRunner.ts's `fireDownstream` now reads
 * `canvasStoreVanilla.getState().joins`, fetches a fresh journal snapshot
 * via `fetchAllJournalMissions`, and calls `reconcileJoins`/
 * `checkAndFireJoin` with an `attemptFireFn` that delegates to the SAME
 * `fireChain` every other trigger path uses — so a join-reached draft gets
 * identical guards (cascade depth, SGR ownership, cross-project, pin) to a
 * directly-chained one. The two live-path tests below are un-skipped and
 * now pass for real. Startup/restart reconcile for joins is `reconcileChains`
 * → `reconcileJoins`; exactly-once is `shouldSkipAlreadyFired` on `fireChain`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  initChainEngine,
  initSgrChainRunner,
  onMissionTerminal,
  reconcileChains,
  computeCascadeDepth,
  MAX_CASCADE_DEPTH,
  _resetChainEngineForTests,
  type ChainEngineDeps,
} from '../lib/agents/chainEngine';
import { setSgrManagedDrafts, clearSgrManagedDrafts } from '../lib/agents/sgrChainRunner';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { makeRef, type Chain, type ChainCondition, type DraftSpec, type JoinSpec } from '../components/agents/canvas/canvasTypes';
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

function join(overrides: Partial<JoinSpec> & { id: string; sourceRefs: string[] }): JoinSpec {
  return { mode: 'all_success', ...overrides };
}

interface JournalRow {
  mission_id: string;
  project_id: string;
  status: string;
  data: string;
  updated_ms: number;
}

function journalRow(m: Mission, projectId: string, updatedMs: number): JournalRow {
  return { mission_id: m.id, project_id: projectId, status: m.status, data: JSON.stringify(m), updated_ms: updatedMs };
}

function installInvokeFake(rows: JournalRow[]): { rows: JournalRow[] } {
  const box = { rows };
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'journal_missions_current') return box.rows;
    if (cmd === 'canvas_state_save') return undefined;
    if (cmd === 'canvas_state_load') return null;
    if (cmd === 'journal_emit') return 1;
    if (cmd === 'journal_emit_batch') return 1;
    throw new Error(`unexpected invoke: ${cmd}`);
  });
  return box;
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

/** Wires both chain-related singletons, mirroring production (see
 *  chainEngine.test.ts's identical helper doc comment). Does not change
 *  whether a join fires — see this file's module doc comment: joinEngine.ts
 *  is orphaned regardless of which init function(s) run. Used purely so
 *  these tests exercise the SAME wiring production actually has. */
function initBothEngines(deps: ReturnType<typeof makeDeps>): void {
  initChainEngine(deps);
  initSgrChainRunner(deps);
}

function enableTauri(): void {
  (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'] = {};
}

function disableTauri(): void {
  delete (window as unknown as Record<string, unknown>)['__TAURI_INTERNALS__'];
}

/** Wires join j1 (sourceRefs m1+m2) -> outgoing chain -> draft d1, and
 *  initializes the engine. Every test starts from this shared shape and
 *  only varies `mode` + the missions' statuses. */
function setupJoinFixture(mode: JoinSpec['mode'] = 'all_success'): { deps: ReturnType<typeof makeDeps> } {
  const deps = makeDeps();
  canvasStoreVanilla.getState().addJoin(join({ id: 'j1', mode, sourceRefs: [makeRef('mission', 'm1'), makeRef('mission', 'm2')] }));
  canvasStoreVanilla.getState().addChain(
    chain({ id: 'c-out', sourceRef: makeRef('join', 'j1'), targetRef: makeRef('draft', 'd1'), condition: 'always' }),
  );
  canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
  return { deps };
}

beforeEach(() => {
  _resetCanvasStoreForTests();
  _resetChainEngineForTests();
  clearSgrManagedDrafts(); // hygiene — _resetChainEngineForTests does not touch this module singleton
  mockInvoke.mockReset();
  mockListen.mockReset();
  mockListen.mockResolvedValue(() => undefined);
  installInvokeFake([]);
  enableTauri();
});

afterEach(() => {
  disableTauri();
});

describe('join engine — live path (onMissionTerminal)', () => {
  it('does not fire while only one of two sources is terminal', async () => {
    const { deps } = setupJoinFixture('all_success');
    initBothEngines(deps);

    installInvokeFake([journalRow(mission({ id: 'm1', status: 'done' }), 'proj-1', 100)]);
    onMissionTerminal(mission({ id: 'm1', status: 'done' }));
    await new Promise((r) => setTimeout(r, 20));

    expect(deps.addMission).not.toHaveBeenCalled();
  });

  // Regression 3.1 of REGRESSIONS-CHAINES.md — restored 2026-08-12, see
  // module doc comment above.
  it('fires the outgoing chain exactly once once BOTH sources reach done (all_success)', async () => {
    const { deps } = setupJoinFixture('all_success');
    initBothEngines(deps);

    installInvokeFake([journalRow(mission({ id: 'm1', status: 'done' }), 'proj-1', 100)]);
    onMissionTerminal(mission({ id: 'm1', status: 'done' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(deps.addMission).not.toHaveBeenCalled();

    installInvokeFake([
      journalRow(mission({ id: 'm1', status: 'done' }), 'proj-1', 100),
      journalRow(mission({ id: 'm2', status: 'done' }), 'proj-1', 200),
    ]);
    onMissionTerminal(mission({ id: 'm2', status: 'done' }));
    await new Promise((r) => setTimeout(r, 20));

    expect(deps.addMission).toHaveBeenCalledTimes(1);
    expect(deps.addMission).toHaveBeenCalledWith(expect.objectContaining({ title: 'Draft d1' }));
  });

  it('all_success never fires when one source FAILS, even once both are terminal', async () => {
    const { deps } = setupJoinFixture('all_success');
    initBothEngines(deps);

    installInvokeFake([
      journalRow(mission({ id: 'm1', status: 'done' }), 'proj-1', 100),
      journalRow(mission({ id: 'm2', status: 'failed' }), 'proj-1', 200),
    ]);
    onMissionTerminal(mission({ id: 'm2', status: 'failed' }));
    await new Promise((r) => setTimeout(r, 20));

    expect(deps.addMission).not.toHaveBeenCalled();
  });

  // Regression 3.1 of REGRESSIONS-CHAINES.md — restored 2026-08-12, see
  // module doc comment above.
  it('all_settled fires even when one source FAILS, as long as both are terminal', async () => {
    const { deps } = setupJoinFixture('all_settled');
    initBothEngines(deps);

    installInvokeFake([
      journalRow(mission({ id: 'm1', status: 'done' }), 'proj-1', 100),
      journalRow(mission({ id: 'm2', status: 'failed' }), 'proj-1', 200),
    ]);
    onMissionTerminal(mission({ id: 'm2', status: 'failed' }));
    await new Promise((r) => setTimeout(r, 20));

    expect(deps.addMission).toHaveBeenCalledTimes(1);
  });

  it('a join under 2 sources (not fully wired yet) never fires, even if its one source is done', async () => {
    const deps = makeDeps();
    canvasStoreVanilla.getState().addJoin(join({ id: 'j1', mode: 'all_success', sourceRefs: [makeRef('mission', 'm1')] }));
    canvasStoreVanilla.getState().addChain(chain({ id: 'c-out', sourceRef: makeRef('join', 'j1'), targetRef: makeRef('draft', 'd1'), condition: 'always' }));
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    initBothEngines(deps);

    installInvokeFake([journalRow(mission({ id: 'm1', status: 'done' }), 'proj-1', 100)]);
    onMissionTerminal(mission({ id: 'm1', status: 'done' }));
    await new Promise((r) => setTimeout(r, 20));

    expect(deps.addMission).not.toHaveBeenCalled();
  });

  // Anti-double-launch guard (2026-08-04 UC3 dogfood incident — see
  // sgrManagedDraftRefs' own doc comment in sgrChainRunner.ts). Wiring the
  // join's outgoing chain through the SAME fireChain every other trigger
  // path uses (rather than a bespoke join-only launch) is what makes this
  // guard apply here automatically — prove it explicitly: a join whose
  // target draft is already owned by a live SGR plan run must NOT launch a
  // second time, even once both fan-in sources are terminal.
  it('does not fire when its target draft is already owned by a live SGR plan run', async () => {
    const { deps } = setupJoinFixture('all_success');
    initBothEngines(deps);

    setSgrManagedDrafts([makeRef('draft', 'd1')]);
    try {
      installInvokeFake([journalRow(mission({ id: 'm1', status: 'done' }), 'proj-1', 100)]);
      onMissionTerminal(mission({ id: 'm1', status: 'done' }));
      await new Promise((r) => setTimeout(r, 20));

      installInvokeFake([
        journalRow(mission({ id: 'm1', status: 'done' }), 'proj-1', 100),
        journalRow(mission({ id: 'm2', status: 'done' }), 'proj-1', 200),
      ]);
      onMissionTerminal(mission({ id: 'm2', status: 'done' }));
      await new Promise((r) => setTimeout(r, 20));

      expect(deps.addMission).not.toHaveBeenCalled();
    } finally {
      clearSgrManagedDrafts();
    }
  });
});

describe('join engine — restart / reconcile', () => {
  it('a fresh boot whose sources are ALREADY terminal in the journal fires the join once via reconcileChains', async () => {
    const { deps } = setupJoinFixture('all_success');
    installInvokeFake([
      journalRow(mission({ id: 'm1', status: 'done' }), 'proj-1', 100),
      journalRow(mission({ id: 'm2', status: 'done' }), 'proj-1', 200),
    ]);

    initBothEngines(deps); // runs one startup reconcileChains() internally
    await new Promise((r) => setTimeout(r, 20));

    expect(deps.addMission).toHaveBeenCalledTimes(1);
  });

  it('never refires on a later reconcile once already fired (lastFiredAtMs guard)', async () => {
    const { deps } = setupJoinFixture('all_success');
    installInvokeFake([
      journalRow(mission({ id: 'm1', status: 'done' }), 'proj-1', 100),
      journalRow(mission({ id: 'm2', status: 'done' }), 'proj-1', 200),
    ]);
    initBothEngines(deps);
    await new Promise((r) => setTimeout(r, 20)); // let the startup reconcile finish

    expect(deps.addMission).toHaveBeenCalledTimes(1);

    await reconcileChains();
    await reconcileChains();
    expect(deps.addMission).toHaveBeenCalledTimes(1); // still just once

    const outgoing = canvasStoreVanilla.getState().chains.find((c) => c.id === 'c-out');
    expect(outgoing?.lastFiredAtMs).toBe(200); // the LAST-arriving source's own real timestamp
  });

  it('does not fire on reconcile when only one source is terminal in the journal', async () => {
    const { deps } = setupJoinFixture('all_success');
    installInvokeFake([journalRow(mission({ id: 'm1', status: 'done' }), 'proj-1', 100)]);
    initBothEngines(deps);
    await new Promise((r) => setTimeout(r, 20));

    expect(deps.addMission).not.toHaveBeenCalled();
  });

  // Mission 4 (RECONCILE-DESIGN.md) anti-double-launch coverage: both fan-in
  // sources are ALREADY terminal in the journal at boot, but the join's
  // target draft is owned by a live SGR plan run — the startup reconcile
  // must not fire it a second time (2026-08-04 incident shape, reached
  // through the join's outgoing chain this time, not a direct one).
  it('does not fire on startup reconcile when its target draft is owned by a live SGR plan run', async () => {
    const { deps } = setupJoinFixture('all_success');
    installInvokeFake([
      journalRow(mission({ id: 'm1', status: 'done' }), 'proj-1', 100),
      journalRow(mission({ id: 'm2', status: 'done' }), 'proj-1', 200),
    ]);

    setSgrManagedDrafts([makeRef('draft', 'd1')]);
    try {
      initBothEngines(deps); // runs the startup reconcile internally
      await new Promise((r) => setTimeout(r, 20));

      expect(deps.addMission).not.toHaveBeenCalled();
      expect(canvasStoreVanilla.getState().chains.find((c) => c.id === 'c-out')!.lastFiredAtMs).toBeUndefined();

      // The run settles and releases ownership — a LATER reconcile fires
      // the join's outgoing chain for real, proving nothing was lost.
      clearSgrManagedDrafts();
      await reconcileChains();
      expect(deps.addMission).toHaveBeenCalledTimes(1);
    } finally {
      clearSgrManagedDrafts();
    }
  });
});

describe('join cascade depth (reuses computeCascadeDepth unchanged)', () => {
  it("a join's outgoing chain inherits cascade depth from its incoming fan-in predecessor", () => {
    const chains: Chain[] = [
      chain({ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'always' }),
      chain({ id: 'c2', sourceRef: makeRef('draft', 'd1'), targetRef: makeRef('draft', 'd2'), condition: 'always' }),
      chain({ id: 'c3', sourceRef: makeRef('draft', 'd2'), targetRef: makeRef('draft', 'd3'), condition: 'always' }),
      chain({ id: 'c4', sourceRef: makeRef('draft', 'd3'), targetRef: makeRef('draft', 'd4'), condition: 'always' }),
      // c5 is one of join j1's fan-in wiring edges (draft d4 -> join j1).
      chain({ id: 'c5', sourceRef: makeRef('draft', 'd4'), targetRef: makeRef('join', 'j1'), condition: 'always' }),
      // The join's own outgoing chain.
      chain({ id: 'c-out', sourceRef: makeRef('join', 'j1'), targetRef: makeRef('draft', 'd5'), condition: 'always' }),
    ];
    expect(computeCascadeDepth(chains, 'c-out')).toBe(6);
    expect(computeCascadeDepth(chains, 'c-out')).toBeGreaterThan(MAX_CASCADE_DEPTH);
  });
});
