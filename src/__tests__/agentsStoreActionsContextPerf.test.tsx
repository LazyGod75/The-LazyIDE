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
import { runManagerTurn, MANAGER_LLM_CALL_TIMEOUT_MS } from '../lib/agents/managerEngine';

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

describe('AgentsStoreProvider — split action-only Context skips the elapsedMs re-render storm', () => {
  it('an actions-only consumer does not re-render across 5 ticks of an active manager turn, while a full-store consumer keeps re-rendering', async () => {
    // Hangs until the turn's own per-call AbortSignal fires — same pattern
    // as agentsStore.test.tsx's "hang forever" timeout-recovery tests, so
    // the elapsedTicker keeps running (never cleared by an early resolve)
    // for as many ticks as the test advances.
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

    // 5 ticks of the 1s elapsedMs ticker while the turn is still in flight —
    // ONE act() per tick (matching real setInterval macrotask separation),
    // never one act() spanning all 5s: batching every tick's state update
    // into a SINGLE act() would merge them into one React commit and hide
    // the exact re-render-per-tick behavior this test exists to prove.
    for (let tick = 0; tick < 5; tick += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
    }

    // Sanity check: the ticks genuinely happened (proves this isn't a
    // trivially-passing test because nothing fired at all).
    expect(storeBox.current!.managerElapsedMs).toBeGreaterThanOrEqual(5_000);
    // The full-store consumer re-rendered on (at least most of) those
    // ticks — unchanged, pre-existing behavior for the ~70 untouched call
    // sites.
    expect(counts.fullStore).toBeGreaterThan(fullStoreBeforeTicks + 3);
    // The actions-only consumer saw (at most) ONE extra render across the
    // whole 5-tick window — the manager-persistence sync effect
    // (managerPersistence.ts) saves the just-sent user message on the FIRST
    // post-send render and legitimately bumps `managerPersistedSessions`
    // once, which loadManagerSession's own pre-existing dependency array
    // depends on; every subsequent tick finds nothing new to persist and
    // touches nothing this Context depends on. The bar this test exists to
    // prove is the delta: 5 renders collapsed to at most 1, not "5 renders
    // collapsed to exactly 0" (that second bar isn't real given the code
    // this Context wraps, unchanged by this fix).
    expect(counts.actionsOnly).toBeLessThanOrEqual(actionsOnlyBeforeTicks + 1);
    expect(counts.missionsOnly).toBeLessThanOrEqual(missionsOnlyBeforeTicks + 1);

    // Let the turn's own per-call budget abort it so the promise settles
    // cleanly and no timer/promise leaks into a later test.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(MANAGER_LLM_CALL_TIMEOUT_MS + 100);
    });
    await act(async () => {
      await sendPromise;
    });
    vi.useRealTimers();
  }, 20_000);
});
