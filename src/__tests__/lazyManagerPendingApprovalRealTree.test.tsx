/**
 * Integration tests for the gate-usability approval surface — the REAL
 * component tree (agentsStore -> LazyManager -> LazyManagerMessageList ->
 * ManagerBubble -> PendingApprovalCard), not the isolated
 * LazyManagerMessageList props harness pendingApprovals.test.tsx and
 * LazyManagerMessageList.test.tsx already cover.
 *
 * REGRESSION (real user test, 2026-07-28): the manager deferred three
 * retry_mission actions to approval — the conversation showed the three
 * "requires approval" messages and the three retry_mission chips, but
 * `[data-testid="pending-approval-card"]` existed NOWHERE in the DOM (no
 * way to approve anything), and the chips themselves rendered in the same
 * style as a genuinely SUCCESSFUL action, even though nothing had executed.
 *
 * Root cause, confirmed empirically by the second test below: gate-deferred
 * actions never survived an AgentsStoreProvider remount (an app relaunch, or
 * a dev-server full reload — this codebase has an extensive history of
 * exactly that kind of instability). Two independent persistence bugs
 * compounded:
 *   1. managerPersistence.ts's sanitizeMessage dropped `actionStatuses`/
 *      `actionRefs` when reconstructing a persisted ManagerMessage — a
 *      restored message's action chip then read `undefined !== false`,
 *      i.e. the exact same "not failed" default a genuinely-executed action
 *      gets (the false-success chip defect).
 *   2. `pendingApprovals` was pure in-memory React state, never persisted
 *      anywhere — so even with the chip fixed, the card itself (which
 *      renders only from `pendingApprovals`) could never come back: the
 *      action became permanently unreachable (the missing-card defect).
 * Fixed in managerPersistence.ts (PersistedPendingApproval, sanitizeMessage,
 * sanitizeSession, saveMessages/flushAndSwitch/loadSession) and
 * agentsStore.tsx (toPersistedPendingApproval/fromPersistedPendingApproval,
 * the mount-restore effect, the autosave effect, newManagerConversation,
 * loadManagerSession) — see those files' own doc comments for the full fix.
 *
 * Neither pendingApprovals.test.tsx (drives useAgentsStore() directly, no
 * UI, no remount) nor LazyManagerMessageList.test.tsx (passes
 * `pendingApprovals` as a literal prop straight into the isolated
 * component) could ever have caught this — both bypass the real store ->
 * UI wiring AND the real persistence round-trip a reload actually exercises.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AgentsStoreProvider, useAgentsStore } from '../components/agents/agentsStore';
import { LazyManagerStoreProvider } from '../components/lazyManager/lazyManagerStore';
import { LazyManager } from '../components/lazyManager/LazyManager';
import { I18nProvider } from '../i18n';
import { ToastProvider } from '../components/ui/Toast';
import { runManagerTurn } from '../lib/agents/managerEngine';
import { _resetCanvasStoreForTests } from '../components/agents/canvas/canvasStore';

const mockInvoke = vi.mocked(invoke);

vi.mock('../lib/brain/capture', () => ({
  captureAgentMission: vi.fn(),
}));

vi.mock('../lib/agents/managerEngine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/agents/managerEngine')>();
  return {
    ...actual,
    runManagerTurn: vi.fn(),
  };
});

/** Grabs a live `useAgentsStore()` handle from INSIDE the same provider tree
 *  the rendered UI reads from, purely to seed the fixture mission the test
 *  needs (retry_mission requires a real mission to reference) — every
 *  assertion below still reads the real rendered DOM, never this handle. */
function StoreProbe({ onReady }: { onReady: (store: ReturnType<typeof useAgentsStore>) => void }) {
  const store = useAgentsStore();
  onReady(store);
  return null;
}

function renderRealTree(onStoreReady: (store: ReturnType<typeof useAgentsStore>) => void) {
  return render(
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>
          <StoreProbe onReady={onStoreReady} />
          <LazyManagerStoreProvider>
            <LazyManager />
          </LazyManagerStoreProvider>
        </AgentsStoreProvider>
      </ToastProvider>
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  _resetCanvasStoreForTests();
  vi.mocked(runManagerTurn).mockReset();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
});

describe('PendingApprovalCard — real render path through LazyManager', () => {
  it('renders the approval card in the DOM (with working buttons) after the manager defers actions to approval, driven through the real composer', async () => {
    let storeHandle: ReturnType<typeof useAgentsStore> | undefined;
    renderRealTree((s) => { storeHandle = s; });
    expect(storeHandle).toBeDefined();

    // Seed three real missions so retry_mission has something to reference —
    // mirrors the real repro (three retry_mission actions in one turn).
    const missionIds: string[] = [];
    for (const title of ['M44', 'M45', 'M46']) {
      await act(async () => {
        await storeHandle!.addMission({
          title, repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false,
        });
      });
      const id = storeHandle!.missions[storeHandle!.missions.length - 1]!.id;
      act(() => {
        storeHandle!.updateMission({ id, patch: { status: 'failed' } });
      });
      missionIds.push(id);
    }

    // Default autonomy is 'supervised' -> retry_mission (SENSITIVE) asks.
    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Je relance les trois missions en échec.',
      actions: missionIds.map((missionId) => ({ type: 'retry_mission', missionId })) as never,
      rawResponse: '',
    });

    fireEvent.change(screen.getByTestId('manager-input'), { target: { value: 'Relance les missions en échec' } });
    fireEvent.click(screen.getByTestId('manager-send'));

    // The REAL DOM, through the REAL render tree — this is exactly what a
    // user's eyes would see. Must find the card, not just store state.
    // Generous waitFor budget: the card appears only after the (mocked but
    // async) manager turn + approval-gate round trip through the real
    // provider stack — the default 1000ms flakes under CI load.
    await waitFor(() => expect(screen.getByTestId('pending-approval-card')).toBeInTheDocument(), { timeout: 5_000 });

    for (const missionId of missionIds) {
      const pendingId = storeHandle!.pendingApprovals.find(
        (p) => p.action.type === 'retry_mission' && (p.action as { missionId: string }).missionId === missionId,
      )!.id;
      expect(screen.getByTestId(`pending-approval-approve-${pendingId}`)).toBeInTheDocument();
      expect(screen.getByTestId(`pending-approval-reject-${pendingId}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId('pending-approval-approve-all')).toBeInTheDocument();
    expect(screen.getByTestId('pending-approval-reject-all')).toBeInTheDocument();

    // Chip style fix: a gate-deferred action's summary chip must read as
    // PENDING — never bare/success (the false-success defect) and never the
    // crossed-out "denied" look either (still actionable, not refused).
    expect(screen.getByTestId('manager-action-chip-pending-0')).toBeInTheDocument();
    expect(screen.getByTestId('manager-action-chip-pending-1')).toBeInTheDocument();
    expect(screen.getByTestId('manager-action-chip-pending-2')).toBeInTheDocument();

    // Persistent Accept/Reject bar (real-user design 2026-08-03,
    // Cursor/Windsurf pattern — see LazyManager.tsx): pinned ABOVE the chat
    // while actions are pending, one click approves or rejects everything.
    expect(screen.getByTestId('pending-approval-bar')).toBeInTheDocument();

    // "Tout accepter" on the bar must resolve ALL pending actions through
    // the real store (the bar's handlers call approveAllPendingActions on
    // the active conversation, exactly like the card's own button).
    fireEvent.click(screen.getByTestId('pending-approval-bar-accept-all'));
    await waitFor(() => expect(storeHandle!.pendingApprovals).toHaveLength(0), { timeout: 5_000 });
    expect(screen.queryByTestId('pending-approval-bar')).not.toBeInTheDocument();
  });

  it('survives an AgentsStoreProvider remount (app relaunch / full reload): the card and the correct chip style both come back for a still-unresolved approval', async () => {
    let storeHandle: ReturnType<typeof useAgentsStore> | undefined;
    const first = renderRealTree((s) => { storeHandle = s; });

    await act(async () => {
      await storeHandle!.addMission({
        title: 'M44', repo: '.', worktree: '', modelLabel: 'sonnet', mode: 'agent', orchestrator: false,
      });
    });
    const missionId = storeHandle!.missions[storeHandle!.missions.length - 1]!.id;
    act(() => {
      storeHandle!.updateMission({ id: missionId, patch: { status: 'failed' } });
    });

    vi.mocked(runManagerTurn).mockResolvedValueOnce({
      responseText: 'Je relance la mission.',
      actions: [{ type: 'retry_mission', missionId }] as never,
      rawResponse: '',
    });

    fireEvent.change(screen.getByTestId('manager-input'), { target: { value: 'Relance la mission en échec' } });
    fireEvent.click(screen.getByTestId('manager-send'));
    await waitFor(() => expect(screen.getByTestId('pending-approval-card')).toBeInTheDocument(), { timeout: 5_000 });

    // Give the debounced autosave (managerPersistence.ts's 400ms timer) time
    // to actually write the session (messages AND pendingApprovals) to
    // localStorage before tearing down — a real app quitting mid-session
    // gets exactly this much of a window too (the effect fires on every
    // managerMessages/pendingApprovals change, not just on unmount).
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });

    first.unmount();

    // Fresh mount — a brand new AgentsStoreProvider instance, exactly like
    // an app relaunch or a full page/HMR reload. Nothing here talks to the
    // OLD store at all; every assertion below reads only the NEW tree.
    renderRealTree(() => {});

    // The conversation (including the "requires approval" message and the
    // action chip) is restored — this part already worked before the fix.
    await waitFor(() => expect(screen.getByText(/Je relance la mission/)).toBeInTheDocument(), { timeout: 5_000 });

    // THE FIX: the approval card must come back, still actionable — this is
    // the exact "carte d'approbation ne s'affiche plus du tout" defect.
    const card = screen.getByTestId('pending-approval-card');
    expect(card).toBeInTheDocument();
    const approveButtons = screen.getAllByText('Approve');
    expect(approveButtons.length).toBeGreaterThan(0);
    // PendingApprovalBar safety fix (2026-08-15): a single pending action now
    // ALSO renders its own singular "Reject" button on the persistent bar
    // (see that component's own doc comment), in addition to
    // PendingApprovalCard's in-transcript one — both correctly read "Reject"
    // (never "Reject all") for exactly one pending action, so this can no
    // longer assume a single unique match, same convention as the
    // `approveButtons` assertion just above.
    const rejectButtons = screen.getAllByText('Reject');
    expect(rejectButtons.length).toBeGreaterThan(0);

    // THE OTHER HALF OF THE FIX: the chip must NOT read as a false success
    // (undefined actionStatuses defaulting to "not failed") — it must show
    // the same pending treatment it had before the reload.
    expect(screen.getByTestId('manager-action-chip-pending-0')).toBeInTheDocument();
  });
});
