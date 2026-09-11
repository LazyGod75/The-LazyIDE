/**
 * agentsStoreActionsContextPerf.test.tsx — cockpit hot-spot mission
 * (2026-08-11), proof for the AgentsStoreProvider Context re-render fix.
 *
 * The bug: AgentsStoreProvider fed a SINGLE combined Context whose value
 * object was rebuilt every render, including once a second for the whole
 * duration of an active manager turn (sendManagerMessage's `elapsedTicker`,
 * ~1s interval). Every consumer of that Context — even one that only ever
 * reads an action and never touches conversation/mission state — re-rendered
 * on every one of those ticks, because React Context re-renders ALL
 * subscribers on ANY value-reference change, not per-field.
 *
 * The fix splits a narrow, action-only AgentsActionsContext
 * (useAgentsStoreActions) out of the combined one — memoized on the actions'
 * own already-stable useCallback references, so its identity survives an
 * elapsedMs tick untouched. This test proves it two ways, against the SAME
 * live ticking turn:
 *   1. A useAgentsStore() consumer (the existing, unmodified 70+ call sites'
 *      own hook) keeps re-rendering on every tick — unchanged behavior.
 *   2. A useAgentsStoreActions() consumer does NOT re-render across those
 *      same ticks — the actual fix.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act } from '@testing-library/react';
import React from 'react';
import {
  AgentsStoreProvider,
  useAgentsStore,
  useAgentsStoreActions,
  useAgentsStoreMissionsOptional,
} from '../components/agents/agentsStore';

type AgentsStoreValue = ReturnType<typeof useAgentsStore>;
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn, MANAGER_TURN_TIMEOUT_MS } from '../lib/agents/managerEngine';

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

vi.mock('../lib/agents/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/runtime')>();
  return {
    ...actual,
    runMission: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('../lib/agents/managerEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/managerEngine')>();
  return {
    ...actual,
    runManagerTurn: vi.fn(),
  };
});

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>{children}</AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>
  );
}

interface RenderCounts {
  fullStore: number;
  actionsOnly: number;
  missionsOnly: number;
}

/** Reads the full combined store, same hook every real consumer uses —
 *  its render count is expected to keep climbing on every elapsedMs tick. */
function FullStoreProbe({
  storeBoxRef,
  onRender,
}: {
  storeBoxRef: { current: AgentsStoreValue | null };
  onRender: () => void;
}) {
  const store = useAgentsStore();
  storeBoxRef.current = store;
  onRender();
  return null;
}

/** Reads ONLY the action-only Context — this is the fix under test: its
 *  render count must stay flat across the same ticks. */
function ActionsOnlyProbe({ onRender }: { onRender: () => void }) {
  useAgentsStoreActions();
  onRender();
  return null;
}

function MissionsOnlyProbe({ onRender }: { onRender: () => void }) {
  useAgentsStoreMissionsOptional();
  onRender();
  return null;
}

beforeEach(() => {
  vi.mocked(runManagerTurn).mockReset();
});

describe('AgentsStoreProvider — no elapsedMs re-render storm during an active manager turn', () => {
  it('a long-running manager turn writes state only at start/end — no per-second elapsedMs ticks re-render ANY consumer', async () => {
    // Hangs until the turn's own per-call AbortSignal fires — same pattern
    // as agentsStore.test.tsx's "hang forever" timeout-recovery tests. With
    // the elapsedTicker removed (perf fix: managerElapsedMs is now derived
    // from turnStartedAt at read time), advancing 5s of fake time must
    // produce ZERO extra renders — the previous contract was "only the
    // narrow action-only consumer skips the storm"; now nobody renders.
    vi.mocked(runManagerTurn).mockImplementationOnce(
      (opts) =>
        new Promise((_resolve, reject) => {
          opts.signal?.addEventListener('abort', () => reject(new Error('Stream aborted (timeout)')));
        }),
    );

    const storeBox: { current: AgentsStoreValue | null } = { current: null };
    const counts: RenderCounts = { fullStore: 0, actionsOnly: 0, missionsOnly: 0 };
    // Plain (non-component) closures: the mutation itself is a test-double
    // concern living outside any component/hook body, so it isn't render
    // logic subject to react-hooks/immutability — the probes only ever call
    // an opaque callback prop, never touch `counts` directly.
    const bumpFullStore = () => { counts.fullStore += 1; };
    const bumpActionsOnly = () => { counts.actionsOnly += 1; };
    const bumpMissionsOnly = () => { counts.missionsOnly += 1; };

    render(
      <>
        <FullStoreProbe storeBoxRef={storeBox} onRender={bumpFullStore} />
        <ActionsOnlyProbe onRender={bumpActionsOnly} />
        <MissionsOnlyProbe onRender={bumpMissionsOnly} />
      </>,
      { wrapper },
    );

    expect(storeBox.current).not.toBeNull();
    const conversationId = storeBox.current!.activeConversationId;

    vi.useFakeTimers();
    let sendPromise!: Promise<void>;
    act(() => {
      sendPromise = storeBox.current!.sendManagerMessage(conversationId, 'ping', 'haiku');
    });

    const actionsOnlyBeforeTicks = counts.actionsOnly;
    const fullStoreBeforeTicks = counts.fullStore;
    const missionsOnlyBeforeTicks = counts.missionsOnly;

    // Advance 5s of fake time in 1s steps — under the old per-second
    // elapsedMs ticker each step produced a setState; under the derived
    // turnStartedAt model NONE of them does. ONE act() per step keeps the
    // macrotask separation honest (same shape as before the fix, so a
    // regression that reintroduces a ticker is caught, not batched away).
    for (let tick = 0; tick < 5; tick += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }

    // The whole point of the fix: no consumer re-rendered across the 5s
    // window — the manager-persistence sync effect (managerPersistence.ts)
    // may still legitimately bump `managerPersistedSessions` once on the
    // first post-send render (saving the just-sent user message), so the
    // bar is at most one extra render each, not exactly zero.
    expect(counts.fullStore).toBeLessThanOrEqual(fullStoreBeforeTicks + 1);
    expect(counts.actionsOnly).toBeLessThanOrEqual(actionsOnlyBeforeTicks + 1);
    expect(counts.missionsOnly).toBeLessThanOrEqual(missionsOnlyBeforeTicks + 1);

    // Let the turn's own budgets abort it so the promise settles cleanly
    // and no timer/promise leaks into a later test. Advance past the
    // exchange-wide backstop (MANAGER_TURN_TIMEOUT_MS), not just the
    // per-call inactivity budget: context-fetch timeouts scheduled during
    // this same advance can delay when runManagerTurn's own inactivity
    // timer starts, so its 300s deadline can land past a 300s advance —
    // the 600s backstop is the guaranteed settle point either way.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MANAGER_TURN_TIMEOUT_MS + 1_000);
    });
    await act(async () => {
      await sendPromise;
    });

    // Post-settle: elapsedMs holds the REAL final duration (written once
    // in the finally, not per-second) — the elapsed-time contract
    // managerElapsedMs still honors for any reader.
    expect(storeBox.current!.managerElapsedMs).toBeGreaterThanOrEqual(5_000);
    vi.useRealTimers();
  }, 20_000);
});
