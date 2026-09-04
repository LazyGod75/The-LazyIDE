/**
 * Tests for chainEngine.ts (W3, spec §7) — the chain runtime.
 *
 * Covers: the full trigger matrix (condition × terminal status), loop-source
 * per-iteration firing, cascade-depth guard, context-block content + the 2000
 * char cap, addMission-id plumbing into remapDraftToMission, and
 * markChainFired's undo/redo exclusion (also covered from canvasStore's own
 * side in canvasStore.test.ts).
 *
 * Phase 5 note (re-skip audit, 2026-07-28): chainEngine.ts is now a thin
 * compat shim (see its own module doc) — the reactive fire-per-chain logic
 * this file exercises lives in sgrChainRunner.ts, wired by a SEPARATE
 * `initSgrChainRunner(deps)` call, not by `initChainEngine` (== the
 * unrelated `initCanvasChainOps`, which only wires pin/refire deps). Every
 * `initChainEngine(deps)` call below that expects `onMissionTerminal` (==
 * `onMissionTerminalSGR`) to actually fire now ALSO calls
 * `initSgrChainRunner(deps)` — this was the actual cause of every describe
 * block in this file going dark: not a behavior regression, a wiring gap
 * between two now-separate singletons. Some blocks test behavior that
 * really is gone (reconcileChains is a documented permanent no-op post-SGR
 * — see chainEngine.ts) or never carried over during the split (cross-
 * project defer/resume) — those stay `.skip`-ped with a comment on each
 * explaining which case it is. The cascade-depth guard at fire time was
 * restored 2026-08-12 (sgrChainRunner.ts's fireChain now calls
 * computeCascadeDepth again) — see REGRESSIONS-CHAINES.md for the full
 * regression inventory.
 *
 * `@tauri-apps/api/core` and `@tauri-apps/api/event` are globally mocked by
 * src/__tests__/setup.ts — this file configures `invoke` per test (for
 * `journal_missions_current` and `canvas_state_save`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { setSgrManagedDrafts, clearSgrManagedDrafts } from '../lib/agents/sgrChainRunner';
import {
  initChainEngine,
  initSgrChainRunner,
  onMissionTerminal,
  reconcileChains,
  computeCascadeDepth,
  buildContextBlock,
  MAX_CASCADE_DEPTH,
  _resetChainEngineForTests,
  type ChainEngineDeps,
} from '../lib/agents/chainEngine';
import { canvasStoreVanilla, _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';
import { makeRef, type Chain, type ChainCondition, type DraftSpec } from '../components/agents/canvas/canvasTypes';
import type { Mission, MissionStatus } from '../lib/agents/types';

const mockInvoke = vi.mocked(invoke);
const mockListen = vi.mocked(listen);

// ── Fixtures ───────────────────────────────────────────────────────

function mission(overrides: Partial<Mission> & { id: string }): Mission {
  return { title: `Mission ${overrides.id}`, status: 'running', model: 'sonnet', ...overrides };
}

function chain(overrides: Partial<Chain> & { id: string; sourceRef: string; targetRef: string; condition: ChainCondition }): Chain {
  return { createdBy: 'user', ...overrides };
}

function draft(overrides: Partial<DraftSpec> & { id: string }): DraftSpec {
  return { title: `Draft ${overrides.id}`, task: 'do the thing', createdBy: 'user', ...overrides };
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

/** Configures the global invoke mock: `journal_missions_current` resolves
 *  to `rows` (mutable — tests can reassign to simulate the journal changing
 *  between reconcile passes); `canvas_state_save`/`canvas_state_load`
 *  resolve harmlessly (chainEngine's direct-save-after-fire goes through
 *  canvas_state_save — no assertions needed on it by default). */
function installInvokeFake(rows: JournalRow[]): { rows: JournalRow[] } {
  const box = { rows };
  mockInvoke.mockImplementation(async (cmd: string) => {
    if (cmd === 'journal_missions_current') return box.rows;
    if (cmd === 'canvas_state_save') return undefined;
    if (cmd === 'canvas_state_load') return null;
    // chain.fired/chain.pending_cross_project (emitEvent -> journal_emit)
    // are fire-and-forget journal audit calls, not under test here — a
    // real seq-shaped resolution keeps stderr clean (emitEvent already
    // swallows a rejection, but there is no reason to exercise that path
    // in every other test in this file).
    if (cmd === 'journal_emit') return 1;
    if (cmd === 'journal_emit_batch') return 1;
    throw new Error(`unexpected invoke: ${cmd}`);
  });
  return box;
}

/** Captures the `project://changed` handler `initChainEngine` registers so
 *  tests can simulate a real project switch by invoking it directly. */
function installListenCapture(): { fire: (root: string) => Promise<void> } {
  let handler: ((event: { payload: string }) => void) | null = null;
  mockListen.mockImplementation((async (eventName: string, cb: (event: { payload: string }) => void) => {
    if (eventName === 'project://changed') handler = cb;
    return () => {
      handler = null;
    };
  }) as typeof listen);
  return {
    fire: async (root: string) => {
      handler?.({ payload: root });
      // reconcileChains is async and fire-and-forget from the listener —
      // flush microtasks so its journal_missions_current call resolves.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

/** Deps shape covers BOTH `initChainEngine` (== initCanvasChainOps —
 *  addMission/getActiveProjectId/defaultModelId) and `initSgrChainRunner`
 *  (adds waitForMissions/projectRoot) so `initBothEngines` below can hand
 *  the SAME object to both singletons, mirroring how agentsStore.tsx's
 *  provider mount wires them in production (see its two separate `init*`
 *  call sites). `waitForMissions`/`projectRoot` are unused by the reactive
 *  per-mission fire path this file exercises (sgrChainRunner.ts's
 *  fireDownstream never calls them) — present only to satisfy
 *  SgrChainRunnerDeps' shape. */
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

/** Wires BOTH chain-related singletons the way agentsStore.tsx's provider
 *  mount does — see makeDeps' doc comment for why this file's
 *  `initChainEngine(deps)` alone is not enough to make `onMissionTerminal`
 *  (== onMissionTerminalSGR) fire anything. */
function initBothEngines(deps: ReturnType<typeof makeDeps>): void {
  initChainEngine(deps);
  initSgrChainRunner(deps);
}

/** initChainEngine is now a no-op outside Tauri (chainEngine.ts's own
 *  isTauri() guard — see its doc comment) — this suite exercises the real
 *  engine, so it locally fakes the Tauri sentinel exactly like
 *  nightShift.test.ts's enableTauri()/disableTauri() does for the same
 *  reason (setup.ts deletes it globally so isTauri() defaults to false). */
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
  installInvokeFake([]);
  enableTauri();
});

afterEach(() => {
  disableTauri();
});

// ── Full trigger matrix ────────────────────────────────────────────

describe('chainEngine — trigger matrix (condition × terminal status)', () => {
  const conditions: ChainCondition[] = ['success', 'fail', 'always'];
  const statuses: MissionStatus[] = ['done', 'failed', 'cancelled'];

  const expected: Record<ChainCondition, Record<MissionStatus, boolean>> = {
    success: { done: true, failed: false, cancelled: false, queued: false, running: false, review: false } as never,
    fail: { done: false, failed: true, cancelled: false, queued: false, running: false, review: false } as never,
    always: { done: true, failed: true, cancelled: false, queued: false, running: false, review: false } as never,
  };

  for (const condition of conditions) {
    for (const status of statuses) {
      const shouldFire = expected[condition][status];
      it(`condition=${condition}, status=${status} -> ${shouldFire ? 'FIRES' : 'does not fire'}`, async () => {
        const deps = makeDeps();
        initBothEngines(deps);
        canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
        canvasStoreVanilla.getState().addChain(
          chain({ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition }),
        );

        onMissionTerminal(mission({ id: 'm1', status, title: 'Source' }));
        await vi.waitFor(() => {
          const fired = canvasStoreVanilla.getState().chains.find((c) => c.id === 'c1')!.lastFiredAtMs;
          if (shouldFire && fired === undefined) throw new Error('not fired yet');
        });

        if (shouldFire) {
          expect(deps.addMission).toHaveBeenCalledTimes(1);
          expect(canvasStoreVanilla.getState().drafts.find((d) => d.id === 'd1')).toBeUndefined(); // remapped away
        } else {
          expect(deps.addMission).not.toHaveBeenCalled();
        }
      });
    }
  }

  it('never fires a DISABLED chain, even on a matching condition/status', async () => {
    const deps = makeDeps();
    initBothEngines(deps);
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'always', disabled: true }),
    );

    onMissionTerminal(mission({ id: 'm1', status: 'done' }));
    await new Promise((r) => setTimeout(r, 10));

    expect(deps.addMission).not.toHaveBeenCalled();
    expect(canvasStoreVanilla.getState().chains.find((c) => c.id === 'c1')!.lastFiredAtMs).toBeUndefined();
  });

  it('is a no-op before initChainEngine has run', () => {
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'always' }),
    );

    expect(() => onMissionTerminal(mission({ id: 'm1', status: 'done' }))).not.toThrow();
    expect(canvasStoreVanilla.getState().chains.find((c) => c.id === 'c1')!.lastFiredAtMs).toBeUndefined();
  });
});

// ── addMission-id plumbing + context injection ─────────────────────

describe('chainEngine — firing a same-project draft target', () => {
  it('launches with CONTEXTE AMONT appended, remaps the draft, and marks the chain fired', async () => {
    const deps = makeDeps();
    initBothEngines(deps);
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1', task: 'Écrire les tests', projectId: 'proj-1' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'success' }),
    );

    const source = mission({ id: 'm1', status: 'done', title: 'Implémenter la feature' });
    onMissionTerminal(source);

    await vi.waitFor(() => expect(deps.addMission).toHaveBeenCalledTimes(1));

    const call = deps.addMission.mock.calls[0][0];
    expect(call.title).toBe('Draft d1');
    expect(call.agentTask).toContain('Écrire les tests');
    expect(call.agentTask).toContain('## CONTEXTE AMONT');
    expect(call.agentTask).toContain('Implémenter la feature');
    expect(call.repo).toBe('.');

    // addMission's resolved id flows into remapDraftToMission.
    const missionId = await deps.addMission.mock.results[0].value;
    const chains = canvasStoreVanilla.getState().chains;
    expect(chains.find((c) => c.id === 'c1')!.targetRef).toBe(makeRef('mission', missionId));
    expect(canvasStoreVanilla.getState().drafts).toEqual([]);
  });

  it('markChainFired itself adds no undo step — only remapDraftToMission does (a genuine content change)', async () => {
    const deps = makeDeps();
    initBothEngines(deps);
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'always' }),
    );
    const before = canvasStoreVanilla.temporal.getState().pastStates.length;

    onMissionTerminal(mission({ id: 'm1', status: 'done' }));
    await vi.waitFor(() => expect(deps.addMission).toHaveBeenCalled());

    // +1 for remapDraftToMission (a real content mutation, already tracked
    // by W1a's own design) — markChainFired contributes zero additional
    // entries on top of it (see canvasStore.test.ts for markChainFired's
    // own dedicated isolation tests).
    expect(canvasStoreVanilla.temporal.getState().pastStates.length).toBe(before + 1);
  });

  it('a Transverse (projectId-less) draft always fires regardless of the active project', async () => {
    const deps = makeDeps({ getActiveProjectId: vi.fn(async () => 'some-other-project') });
    initBothEngines(deps);
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' })); // no projectId
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'always' }),
    );

    onMissionTerminal(mission({ id: 'm1', status: 'done' }));
    await vi.waitFor(() => expect(deps.addMission).toHaveBeenCalledTimes(1));
  });
});

// ── Isolated re-run (W-CLOSE row 6) — never fires outgoing chains ────

describe('chainEngine — isolated mission (W-CLOSE row 6, single-node re-run)', () => {
  it('an isolated mission completion does NOT fire an outgoing chain (live path, onMissionTerminal)', async () => {
    const deps = makeDeps();
    initBothEngines(deps);
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1', projectId: 'proj-1' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'always' }),
    );

    onMissionTerminal(mission({ id: 'm1', status: 'done', isolated: true }));

    // Give any (incorrect) async fire a chance to happen before asserting
    // it never did — same "flush microtasks" idiom the rest of this suite
    // uses via vi.waitFor, but here we're proving an ABSENCE.
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.addMission).not.toHaveBeenCalled();
    // The draft is untouched — never remapped to a mission, since nothing fired.
    expect(canvasStoreVanilla.getState().drafts.map((d) => d.id)).toEqual(['d1']);
  });

  // REMOVED FEATURE, not a wiring gap: reconcileChains() is now a permanent
  // no-op (see chainEngine.ts's own doc comment — "the SGR runtime
  // proactively executes downstream nodes when a mission completes, so
  // there is no reactive re-scan to perform"). There is no replacement for
  // a startup/project-switch journal scan in sgrChainRunner.ts — it only
  // reacts to a LIVE onMissionTerminalSGR call, never re-derives past
  // completions from journal_missions_current. Confirmed by reading
  // sgrChainRunner.ts in full: no invoke()/journal read anywhere in the
  // module. Kept skipped rather than deleted to preserve the documented
  // intent; see this mission's final report for the flag on whether an app
  // crash/restart between a mission finishing and its chain firing can now
  // permanently drop that chain (same underlying gap as the "exactly-once
  // across restart" and "cross-project honesty" resume tests below).
  it('an isolated mission is also skipped by reconcileChains (startup/project-switch path)', async () => {
    const deps = makeDeps();
    initBothEngines(deps);
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1', projectId: 'proj-1' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'always' }),
    );

    const isolatedMission = mission({ id: 'm1', status: 'done', isolated: true });
    installInvokeFake([journalRow(isolatedMission, 'proj-1', Date.now())]);

    await reconcileChains();

    expect(deps.addMission).not.toHaveBeenCalled();
    // Still consumed (high-water mark advances) so this exact completion is
    // never re-examined on a LATER reconcile either — see attemptFire's own
    // isolated-skip comment.
    expect(canvasStoreVanilla.getState().chains.find((c) => c.id === 'c1')!.lastFiredAtMs).toBeDefined();
  });

  it('a NON-isolated mission on the same setup fires normally (control)', async () => {
    const deps = makeDeps();
    initBothEngines(deps);
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1', projectId: 'proj-1' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'always' }),
    );

    onMissionTerminal(mission({ id: 'm1', status: 'done' })); // isolated absent
    await vi.waitFor(() => expect(deps.addMission).toHaveBeenCalledTimes(1));
  });
});

// ── Queued-mission target (v1 no-op) ────────────────────────────────

describe('chainEngine — queued-mission target', () => {
  // Behavior updated (test was obsolete, not the engine): the old
  // chainEngine.ts marked a queued-mission-target chain "consumed"
  // (lastFiredAtMs set) so a later journal reconcile pass would never
  // re-examine it. sgrChainRunner.ts's fireChain has no reconcile pass to
  // guard against — it only ever runs once, synchronously, from the live
  // onMissionTerminalSGR call — so its early `if (target.kind !== 'draft')
  // return;` (a mission target is v1 no-op, same as before) intentionally
  // skips markChainFired too: nothing needs "consuming" when there is no
  // replay to protect against. Confirmed against sgrChainRunner.ts's
  // fireChain, which returns before ever calling markChainFired/addMission
  // for a non-draft target.
  it('never launches an existing queued mission, and does not mark the chain fired (no replay pass to protect against)', async () => {
    const deps = makeDeps();
    initBothEngines(deps);
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('mission', 'm2'), condition: 'always' }),
    );

    onMissionTerminal(mission({ id: 'm1', status: 'done' }));
    // Give the fire-and-forget async handler a chance to run before
    // asserting an absence (same idiom as the isolated-mission live-path
    // test above).
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.addMission).not.toHaveBeenCalled();
    expect(canvasStoreVanilla.getState().chains.find((c) => c.id === 'c1')!.lastFiredAtMs).toBeUndefined();
  });
});

// ── Loop-source per-iteration firing ────────────────────────────────

describe('chainEngine — loop source (sourceRef loop:<L>)', () => {
  it('fires once per completed iteration, in order, via the live path', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const deps = makeDeps();
      initBothEngines(deps);
      canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
      canvasStoreVanilla.getState().addChain(
        chain({ id: 'c1', sourceRef: makeRef('loop', 'L1'), targetRef: makeRef('draft', 'd1'), condition: 'success' }),
      );

      onMissionTerminal(mission({ id: 'iter1', status: 'done', loopParentId: 'L1', loopIteration: 1 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.addMission).toHaveBeenCalledTimes(1);

      // First fire remapped d1 away — chain into a new draft for iteration 2.
      canvasStoreVanilla.getState().addDraft(draft({ id: 'd2' }));
      canvasStoreVanilla.getState().addChain(
        chain({ id: 'c2', sourceRef: makeRef('loop', 'L1'), targetRef: makeRef('draft', 'd2'), condition: 'success' }),
      );

      vi.setSystemTime(1000); // distinct effective timestamp for the second completion
      onMissionTerminal(mission({ id: 'iter2', status: 'done', loopParentId: 'L1', loopIteration: 2 }));
      await vi.advanceTimersByTimeAsync(0);

      expect(deps.addMission).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  // REMOVED FEATURE, not a wiring gap: there is no startup journal scan
  // anywhere in the current runtime. Neither `initChainEngine`
  // (initCanvasChainOps) nor `initSgrChainRunner` reads
  // journal_missions_current or replays past completions — both just store
  // deps and return a dispose function (confirmed by reading both in
  // full). `installInvokeFake` below configures a journal the (now no-op)
  // reconcileChains() would have scanned; nothing in this test file's
  // control flow ever calls reconcileChains(), so this can only have
  // passed against the OLD chainEngine.ts, which apparently ran an
  // implicit startup scan from inside initChainEngine itself. See this
  // mission's final report — same underlying gap flagged on the
  // isolated-mission/reconcileChains test above and the "exactly-once
  // across restart" describe block below.
  it('startup reconcile fires ALL completed iterations that ran while the app was closed, in loopIteration order', async () => {
    const deps = makeDeps();
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', sourceRef: makeRef('loop', 'L1'), targetRef: makeRef('draft', 'd1'), condition: 'always' }),
    );

    installInvokeFake([
      // Deliberately out of chronological order in the journal — ordering
      // must follow loopIteration, not row order.
      journalRow(mission({ id: 'iter2', status: 'done', loopParentId: 'L1', loopIteration: 2 }), 'proj-1', 2000),
      journalRow(mission({ id: 'iter1', status: 'done', loopParentId: 'L1', loopIteration: 1 }), 'proj-1', 1000),
    ]);

    initBothEngines(deps);
    await vi.waitFor(() => expect(deps.addMission).toHaveBeenCalledTimes(1));

    // Only ONE fire happened (chain c1's single draft was consumed by
    // iteration 1 — see the launch-context assertion below); the SECOND
    // iteration's completion is still "pending" against this now-vanished
    // draft target and is safely dropped (skipped-target-missing), never
    // retried. This proves ordering (iteration 1 processed first, using its
    // OWN title) without needing a second draft in this fixture.
    const call = deps.addMission.mock.calls[0][0];
    expect(call.agentTask).toContain(mission({ id: 'iter1', status: 'done' }).title);
  });
});

// ── Exactly-once across a simulated restart ─────────────────────────

describe('chainEngine — exactly-once across restart', () => {
  // REMOVED FEATURE, not a wiring gap — same root cause as the two
  // "startup reconcile" skips above: reconcileChains() is a permanent
  // no-op and neither init function replays journal_missions_current.
  // `initChainEngine(deps)` alone firing a mission here (with no
  // onMissionTerminal call at all) can only have depended on the OLD
  // chainEngine.ts's implicit startup scan. See this mission's final
  // report for the restart-robustness gap this leaves.
  it('reconcileChains does not re-fire a chain whose lastFiredAtMs already covers the completion', async () => {
    const deps = makeDeps();
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'success' }),
    );
    installInvokeFake([journalRow(mission({ id: 'm1', status: 'done' }), 'proj-1', 5000)]);

    initBothEngines(deps);
    await vi.waitFor(() => expect(deps.addMission).toHaveBeenCalledTimes(1));

    // Simulate an app restart: fresh singleton, SAME persisted canvasStore
    // state (lastFiredAtMs survives — it's the store's own in-memory state
    // here, standing in for "reloaded from disk"), SAME journal rows.
    _resetChainEngineForTests();
    deps.addMission.mockClear();
    initBothEngines(deps);
    await new Promise((r) => setTimeout(r, 20));

    expect(deps.addMission).not.toHaveBeenCalled();
  });

  // Same removed-feature reason as above: reconcileChains() is a no-op, so
  // calling it twice is trivially a no-op too — this no longer exercises
  // any real reconcile logic (the "fire attempt consumes but can't
  // launch" comment below describes the OLD engine's init-time scan).
  it('a fresh reconcileChains() call against an unchanged journal is a pure no-op', async () => {
    const deps = makeDeps();
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'always' }),
    );
    installInvokeFake([journalRow(mission({ id: 'm1', status: 'done' }), 'proj-1', 100)]);
    initBothEngines(deps); // no draft d1 exists — fire attempt consumes but can't launch
    await vi.waitFor(() => {
      if (canvasStoreVanilla.getState().chains.find((c) => c.id === 'c1')!.lastFiredAtMs === undefined) {
        throw new Error('not consumed yet');
      }
    });

    await reconcileChains();
    await reconcileChains();

    expect(deps.addMission).not.toHaveBeenCalled(); // never had a real target — still zero calls, zero throws
  });
});

// ── Cross-project pending -> resume on project switch ───────────────

describe('chainEngine — cross-project honesty', () => {
  // CONFIRMED REAL REGRESSION (not obsolete-by-design; see final report):
  // sgrChainRunner.ts's fireChain silently `return`s on a cross-project
  // target — reading it in full shows NO `emit`/`bus` call anywhere in the
  // module. `chain:pendingCrossProject` is never fired by the current
  // runtime. This is not a harmless simplification: Cockpit.tsx (lines
  // ~267-289) still has a live `on('chain:pendingCrossProject', ...)`
  // listener whose own doc comment says "chainEngine itself is already
  // subscribed to the resulting `project://changed` event and auto-fires
  // the deferred launch" — that listener is now permanently dead code, and
  // a cross-project chain silently vanishes with NO toast and NO way to
  // ever launch it (the completion was already consumed by the one live
  // onMissionTerminalSGR call; there is no reconcile pass to retry it —
  // see the "exactly-once across restart" skips above). Left skipped
  // rather than rewritten to assert the (worse) new behavior, since that
  // would bury a real product bug as if it were expected.
  it('defers (never launches) when the target draft belongs to a non-active project, and announces it', async () => {
    const bus = await import('../lib/bus');
    const busSpy = vi.fn();
    const unsub = bus.on('chain:pendingCrossProject', busSpy);

    const deps = makeDeps({ getActiveProjectId: vi.fn(async () => 'proj-active') });
    initBothEngines(deps);
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1', projectId: 'proj-other' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'always' }),
    );

    onMissionTerminal(mission({ id: 'm1', status: 'done', title: 'Upstream mission' }));
    await new Promise((r) => setTimeout(r, 20));

    expect(deps.addMission).not.toHaveBeenCalled();
    // Deliberately NOT consumed — see chainEngine.ts's module header
    // "cross-project honesty" section: staying behind lastFiredAtMs is what
    // makes it re-checkable on the next reconcile/project switch.
    expect(canvasStoreVanilla.getState().chains.find((c) => c.id === 'c1')!.lastFiredAtMs).toBeUndefined();
    expect(busSpy).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 'c1', draftId: 'd1', projectId: 'proj-other', sourceTitle: 'Upstream mission' }),
    );
    unsub();
  });

  // Same confirmed regression as above, plus: sgrChainRunner.ts registers
  // no `project://changed` (or any Tauri event) listener at all — reading
  // the whole module shows only the deps object and fireDownstream/
  // fireChain, no `listen()` call. The old chainEngine.ts's resume-on-
  // project-switch mechanism has no successor.
  it('auto-resumes and fires for real once project://changed reports the target project as active', async () => {
    const listenCapture = installListenCapture();
    let active = 'proj-active';
    const deps = makeDeps({ getActiveProjectId: vi.fn(async () => active) });
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1', projectId: 'proj-other' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'always' }),
    );
    installInvokeFake([journalRow(mission({ id: 'm1', status: 'done' }), 'proj-active', 100)]);

    initBothEngines(deps);
    await new Promise((r) => setTimeout(r, 20));
    expect(deps.addMission).not.toHaveBeenCalled(); // still deferred (target project inactive)

    // The user (via AppContext.switchProject) switches to the target
    // project for real — chainEngine reacts to the SAME project://changed
    // event AppContext already emits, never switching anything itself.
    active = 'proj-other';
    await listenCapture.fire('/repos/proj-other');
    await new Promise((r) => setTimeout(r, 20));

    expect(deps.addMission).toHaveBeenCalledTimes(1);
  });

  // Depends on reconcileChains() actually scanning (removed feature — see
  // the "exactly-once across restart" skips above) AND the now-dead
  // `chain:pendingCrossProject` emit (see the first skip in this block).
  it('only announces a still-pending chain once per session (anti-spam)', async () => {
    const bus = await import('../lib/bus');
    const busSpy = vi.fn();
    const unsub = bus.on('chain:pendingCrossProject', busSpy);

    const deps = makeDeps({ getActiveProjectId: vi.fn(async () => 'proj-active') });
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1', projectId: 'proj-other' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'always' }),
    );
    installInvokeFake([journalRow(mission({ id: 'm1', status: 'done' }), 'proj-active', 100)]);

    initBothEngines(deps);
    await new Promise((r) => setTimeout(r, 20));
    await reconcileChains();
    await reconcileChains();

    expect(busSpy).toHaveBeenCalledTimes(1);
    unsub();
  });
});

// ── Cascade depth guard (pure) ───────────────────────────────────────

describe('computeCascadeDepth', () => {
  it('a chain with no predecessor has depth 1', () => {
    const chains: Chain[] = [chain({ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'always' })];
    expect(computeCascadeDepth(chains, 'c1')).toBe(1);
  });

  it('walks a linear cascade A -> B -> C -> ... counting hops', () => {
    // c1: mission:m1 -> mission:m2 ; c2: mission:m2 -> mission:m3 ; c3: mission:m3 -> draft:d1
    const chains: Chain[] = [
      chain({ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('mission', 'm2'), condition: 'always' }),
      chain({ id: 'c2', sourceRef: makeRef('mission', 'm2'), targetRef: makeRef('mission', 'm3'), condition: 'always' }),
      chain({ id: 'c3', sourceRef: makeRef('mission', 'm3'), targetRef: makeRef('draft', 'd1'), condition: 'always' }),
    ];
    expect(computeCascadeDepth(chains, 'c1')).toBe(1);
    expect(computeCascadeDepth(chains, 'c2')).toBe(2);
    expect(computeCascadeDepth(chains, 'c3')).toBe(3);
  });

  it('flags a chain past MAX_CASCADE_DEPTH (6 linear hops)', () => {
    const chains: Chain[] = [];
    for (let i = 1; i <= 6; i += 1) {
      chains.push(
        chain({
          id: `c${i}`,
          sourceRef: makeRef('mission', `m${i}`),
          targetRef: i === 6 ? makeRef('draft', 'd1') : makeRef('mission', `m${i + 1}`),
          condition: 'always',
        }),
      );
    }
    expect(computeCascadeDepth(chains, 'c6')).toBe(6);
    expect(computeCascadeDepth(chains, 'c6')).toBeGreaterThan(MAX_CASCADE_DEPTH);
  });

  it('never infinite-loops on a cycle (defense in depth — chainValidation already prevents creating one)', () => {
    const chains: Chain[] = [
      chain({ id: 'c1', sourceRef: makeRef('mission', 'a'), targetRef: makeRef('mission', 'b'), condition: 'always' }),
      chain({ id: 'c2', sourceRef: makeRef('mission', 'b'), targetRef: makeRef('mission', 'a'), condition: 'always' }),
    ];
    expect(() => computeCascadeDepth(chains, 'c1')).not.toThrow();
    expect(computeCascadeDepth(chains, 'c1')).toBeGreaterThan(MAX_CASCADE_DEPTH);
  });

  // RESTORED 2026-08-12 (regression 3.7 of REGRESSIONS-CHAINES.md):
  // sgrChainRunner.ts's fireChain now calls computeCascadeDepth at the head
  // of the function, mirroring the old attemptFire — a chain whose computed
  // depth exceeds MAX_CASCADE_DEPTH is consumed (lastFiredAtMs set) but
  // never fired. chainValidation.ts's docstring was corrected to point at
  // the new call site (sgrChainRunner.ts's fireChain).
  it('the engine skips (never fires) a chain whose computed depth exceeds the guard', async () => {
    const deps = makeDeps();
    initBothEngines(deps);
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    // Build a 6-hop chain ending in c6 -> draft:d1, with c1..c5 pointing at
    // mission refs (never fired for real, just graph shape for the depth
    // walk) so c6's predecessor chain is exactly 6 deep.
    for (let i = 1; i <= 5; i += 1) {
      canvasStoreVanilla.getState().addChain(
        chain({
          id: `c${i}`,
          sourceRef: makeRef('mission', `m${i}`),
          targetRef: makeRef('mission', `m${i + 1}`),
          condition: 'always',
        }),
      );
    }
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c6', sourceRef: makeRef('mission', 'm6'), targetRef: makeRef('draft', 'd1'), condition: 'always' }),
    );

    onMissionTerminal(mission({ id: 'm6', status: 'done' }));
    await new Promise((r) => setTimeout(r, 20));

    expect(deps.addMission).not.toHaveBeenCalled();
    expect(canvasStoreVanilla.getState().chains.find((c) => c.id === 'c6')!.lastFiredAtMs).toBeDefined(); // consumed, not retried
  });

  // Anti-double-launch guard (2026-08-04 UC3 dogfood incident — see
  // sgrManagedDraftRefs' own doc comment in sgrChainRunner.ts). The new
  // cascade-depth check runs BEFORE the SGR-ownership check in fireChain —
  // prove it does not short-circuit past that guard for a chain well
  // within the depth limit (depth 1 here): a draft owned by a live SGR
  // plan run must still never be fired reactively.
  it('a within-depth chain still respects the SGR-managed-draft guard (cascade check does not bypass it)', async () => {
    const deps = makeDeps();
    initBothEngines(deps);
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'always' }),
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

  // Mission 4 (RECONCILE-DESIGN.md) anti-double-launch coverage: the SAME
  // guard must hold on the RECONCILE path, not just the live path above —
  // a draft the active SGR plan run owns must never be fired by a startup/
  // project-switch catch-up either, or the 2026-08-04 double-launch
  // incident reopens through the new code path instead of the old one.
  it('reconcileChains respects the SGR-managed-draft guard — never double-fires a draft the live run owns', async () => {
    const deps = makeDeps();
    canvasStoreVanilla.getState().addDraft(draft({ id: 'd1' }));
    canvasStoreVanilla.getState().addChain(
      chain({ id: 'c1', sourceRef: makeRef('mission', 'm1'), targetRef: makeRef('draft', 'd1'), condition: 'always' }),
    );
    installInvokeFake([journalRow(mission({ id: 'm1', status: 'done' }), 'proj-1', 100)]);

    setSgrManagedDrafts([makeRef('draft', 'd1')]);
    try {
      initBothEngines(deps); // runs the startup reconcile internally
      await new Promise((r) => setTimeout(r, 20));

      expect(deps.addMission).not.toHaveBeenCalled();
      // Deliberately NOT consumed — same rationale as cross-project defer:
      // the live SGR run (not this reconcile) is responsible for this
      // draft, so the chain must stay re-checkable once the run clears.
      expect(canvasStoreVanilla.getState().chains.find((c) => c.id === 'c1')!.lastFiredAtMs).toBeUndefined();

      // Once the run settles and releases ownership, a LATER reconcile
      // must be free to fire it for real — proving the guard defers rather
      // than permanently losing the chain.
      clearSgrManagedDrafts();
      await reconcileChains();
      expect(deps.addMission).toHaveBeenCalledTimes(1);
    } finally {
      clearSgrManagedDrafts();
    }
  });
});

// ── Context block content + cap (pure) ───────────────────────────────

describe('buildContextBlock', () => {
  it('includes the CONTEXTE AMONT heading, source title, and status', () => {
    const block = buildContextBlock(mission({ id: 'm1', title: 'Analyse de sécurité', status: 'done' }));
    expect(block).toContain('## CONTEXTE AMONT');
    expect(block).toContain('Analyse de sécurité');
    expect(block).toContain('done');
  });

  it('reuses formatMissionDetail (the real output source) — a mission with a real result shows up verbatim', () => {
    const withResult = mission({
      id: 'm1',
      status: 'done',
      title: 'T',
      actionTimeline: [{ time: '10:00', text: 'Résultat: tout est vert, 42 tests passent' }],
    });
    const block = buildContextBlock(withResult);
    expect(block).toContain('42 tests passent');
  });

  it('caps the whole block at 2000 chars for the output-summary portion (never unbounded)', () => {
    const huge = mission({
      id: 'm1',
      status: 'done',
      title: 'T',
      actionTimeline: Array.from({ length: 50 }, (_, i) => ({ time: '10:00', text: `entry ${i} `.repeat(50) })),
    });
    const block = buildContextBlock(huge);
    // formatMissionDetail's own caps + this module's 2000-char cap together
    // bound the block to a small, fixed multiple of the cap — never
    // unbounded regardless of actionTimeline size.
    expect(block.length).toBeLessThan(2200);
  });
});
