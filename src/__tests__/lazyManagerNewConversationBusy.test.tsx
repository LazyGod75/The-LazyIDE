/**
 * "Nouvelle conversation" while busy — real user test, 2026-08-01 QA:
 * background wake-ups (managerWakeup.ts) keep the manager `busy` much of the
 * time, so the New-conversation button used to be `disabled={busy}` — a
 * click while busy silently did NOTHING (no feedback), and the user kept
 * talking into the old thread believing it was fresh.
 *
 * Fix (round 1): the button (LazyManagerHeader.tsx) is now always clickable
 * regardless of busy state; clicking it used to stop/detach the in-flight
 * turn and LazyManager.tsx showed an explicit confirmation toast.
 *
 * MULTI-CONVERSATION LAZYMANAGER (wave 1) supersedes the "stops the
 * in-flight turn" half of that fix: starting a new conversation no longer
 * interrupts anything — the busy conversation keeps working in the
 * background on its own tab (that is the entire point of "plusieurs
 * conversations en meme temps qui taffe"). The button is STILL never
 * `disabled` by busy state (see LazyManagerHeader.tsx's own doc comment on
 * `openConversationCapReached` — the ONLY real disable condition now is the
 * open-conversation cap, MAX_OPEN_MANAGER_CONVERSATIONS) — this file keeps
 * covering that half of the original fix, and adds coverage for the new
 * "never interrupts" contract plus the cap-based disable.
 *
 * Real component tree (AgentsStoreProvider -> LazyManagerStoreProvider ->
 * LazyManager), same convention as lazyManagerPendingApprovalRealTree.test
 * .tsx — a props-level harness could not have caught the original defect
 * (the `disabled` HTML attribute lived on the real DOM button).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React from 'react';
import { invoke } from '@tauri-apps/api/core';
import { AgentsStoreProvider } from '../components/agents/agentsStore';
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

function renderRealTree() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <AgentsStoreProvider>
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
  localStorage.setItem('lazy.locale', 'fr'); // deterministic copy assertions below
  _resetCanvasStoreForTests();
  vi.mocked(runManagerTurn).mockReset();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
});

afterEach(() => {
  localStorage.clear();
});

describe('LazyManagerHeader — "Nouvelle conversation" stays clickable while the manager is busy', () => {
  it('is never HTML-disabled while managerBusy is true (the original silent-no-op defect)', async () => {
    // Never resolves for the duration of this test — keeps managerBusy true,
    // mirroring a real in-flight turn (or a background wake-up) at the exact
    // moment the user reaches for "+".
    vi.mocked(runManagerTurn).mockReturnValueOnce(new Promise(() => {}));

    renderRealTree();
    fireEvent.change(screen.getByTestId('manager-input'), { target: { value: 'Relance les missions' } });
    fireEvent.click(screen.getByTestId('manager-send'));

    await waitFor(() => expect(screen.getByTestId('manager-stop')).toBeInTheDocument());

    const newConvBtn = screen.getByTestId('lazy-manager-new-conv');
    expect(newConvBtn).not.toBeDisabled();
    expect(newConvBtn).not.toHaveAttribute('disabled');
    // Visible cue that something else is still working — not JUST a title
    // attribute (real user report's own "not only a title attribute"
    // requirement). No longer means "clicking this will interrupt it".
    expect(screen.getByTestId('lazy-manager-new-conv-busy-dot')).toBeInTheDocument();
  });

  it('clicking it while busy opens a fresh EMPTY conversation WITHOUT stopping the still-running one — that keeps working in the background', async () => {
    // Never resolves — the busy conversation's turn stays genuinely in
    // flight for the whole test, proving "+" never touches it.
    vi.mocked(runManagerTurn).mockReturnValueOnce(new Promise(() => {}));

    renderRealTree();
    fireEvent.change(screen.getByTestId('manager-input'), { target: { value: 'Relance les missions' } });
    fireEvent.click(screen.getByTestId('manager-send'));

    await waitFor(() => expect(screen.getByTestId('manager-stop')).toBeInTheDocument());
    expect(screen.getByTestId('manager-message-user')).toHaveTextContent('Relance les missions');

    await act(async () => {
      fireEvent.click(screen.getByTestId('lazy-manager-new-conv'));
    });

    // Never the "interrupted" wording — nothing was cut short. The plain
    // "started" confirmation, every time "+" is clicked.
    expect(screen.getByTestId('lazy-manager-new-conversation-toast')).toHaveTextContent(
      'Nouvelle conversation démarrée.',
    );
    // The ACTIVE tab is now the fresh, empty conversation — the old
    // message is no longer part of what's DISPLAYED (it moved to the
    // background conversation's own tab).
    expect(screen.queryByTestId('manager-message-user')).not.toBeInTheDocument();
    // The composer reflects the NEW (idle) conversation immediately — no
    // waiting on the old turn to resolve, because nothing had to.
    expect(screen.getByTestId('manager-send')).toBeInTheDocument();
    // A visible tab strip now exists with (at least) two conversations —
    // the still-busy background one and the fresh active one — proving the
    // old turn genuinely kept running rather than being silently dropped.
    const tabs = screen.getAllByTestId('lazy-manager-conversation-tab');
    expect(tabs.length).toBeGreaterThanOrEqual(2);
    const busyTab = tabs.find((tab) => tab.getAttribute('data-busy') === 'true');
    expect(busyTab).toBeDefined();
  });

  it('clicking it while IDLE still shows the plain (non-interrupted) confirmation — no turn was cut short', async () => {
    renderRealTree();

    await act(async () => {
      fireEvent.click(screen.getByTestId('lazy-manager-new-conv'));
    });

    expect(screen.getByTestId('lazy-manager-new-conversation-toast')).toHaveTextContent(
      'Nouvelle conversation démarrée.',
    );
  });

  it('the reachable "+" becomes HTML-disabled once the open-conversation cap is reached, with a real explanatory tooltip — both entry points, never removed from the DOM', async () => {
    renderRealTree();

    // MAX_OPEN_MANAGER_CONVERSATIONS is 6 — the app boots with 1 already
    // open, so 5 more "+" clicks reach the cap exactly.
    //
    // Owner rejected the 2026-08-02 attempt to hide the header pill once a
    // second conversation opened ("je suis censé pouvoir ouvrir une
    // nouvelle conversation quand je veux") — it now stays in the DOM at
    // every conversation count, alongside the tab strip's own trailing "+"
    // once that exists. Both must end up disabled-but-visible at the cap.
    await act(async () => {
      fireEvent.click(screen.getByTestId('lazy-manager-new-conv'));
    });
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        fireEvent.click(screen.getByTestId('lazy-manager-conversation-tab-add'));
      });
    }

    const pillBtn = screen.getByTestId('lazy-manager-new-conv');
    expect(pillBtn).toBeInTheDocument();
    expect(pillBtn).toBeDisabled();
    expect(pillBtn).toHaveAttribute('title', expect.stringContaining('conversations ouvertes'));

    const addBtn = screen.getByTestId('lazy-manager-conversation-tab-add');
    expect(addBtn).toBeDisabled();
    expect(addBtn).toHaveAttribute('title', expect.stringContaining('conversations ouvertes'));
  });

  // Accessibility fix (real user QA, 2026-08-15): the cap-reached reason
  // used to live ONLY in a `title` attribute — invisible to a screen-reader
  // or keyboard user who never hovers a disabled control. Both entry points
  // now carry an `aria-describedby` pointing at a shared, visually-hidden
  // (`.sr-only`) text node with the SAME explanatory copy.
  it('both "New conversation" entry points expose the cap-reached reason via aria-describedby, not title alone', async () => {
    renderRealTree();
    await act(async () => {
      fireEvent.click(screen.getByTestId('lazy-manager-new-conv'));
    });
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        fireEvent.click(screen.getByTestId('lazy-manager-conversation-tab-add'));
      });
    }

    const pillBtn = screen.getByTestId('lazy-manager-new-conv');
    const addBtn = screen.getByTestId('lazy-manager-conversation-tab-add');
    const describedById = pillBtn.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    expect(addBtn).toHaveAttribute('aria-describedby', describedById);

    const reasonEl = document.getElementById(describedById!);
    expect(reasonEl).not.toBeNull();
    expect(reasonEl).toHaveTextContent(/conversations ouvertes/);
  });
});
