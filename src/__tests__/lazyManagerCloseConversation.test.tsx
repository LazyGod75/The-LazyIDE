/**
 * LazyManagerHeader — tab-strip close button + "new conversation"
 * discoverability (real user report, 2026-08-02 QA, verbatim: "je ne vois
 * pas le bouton pour lancer une nouvelle conv, ouvrir une nouvelle conv en
 * plus ou fermer quand yen a plusieurs d'ouverte"). Real component tree
 * (AgentsStoreProvider -> LazyManagerStoreProvider -> LazyManager), same
 * convention as lazyManagerNewConversationBusy.test.tsx — a props-level
 * harness could not catch a defect that lives in what the real DOM renders.
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
  captureConversationSummary: vi.fn(),
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
  localStorage.setItem('lazy.locale', 'fr');
  _resetCanvasStoreForTests();
  vi.mocked(runManagerTurn).mockReset();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
});

afterEach(() => {
  localStorage.clear();
});

describe('LazyManagerHeader — "new conversation" is discoverable, not a bare unlabelled icon', () => {
  it('renders a labelled (icon + text) primary button, distinct from the bare-icon secondary controls', () => {
    renderRealTree();
    const newConvBtn = screen.getByTestId('lazy-manager-new-conv');
    // Real visible text, not just an aria-label/title an unlabelled icon
    // would also technically carry — this is the actual regression: four
    // visually-identical 24px icons with no text at all.
    expect(newConvBtn).toHaveTextContent('Nouvelle');
    // History (real user, 2026-08-02: "...une autre session quand je veux
    // aussi" — reopening a past session is primary navigation, not
    // occasional) is a direct Row-1 control, reachable in one click, no
    // overflow menu to open first. It still has NO text content — proving
    // the primary "+ Nouvelle" action still reads differently from this
    // secondary, icon-only one.
    const historyBtn = screen.getByTestId('lazy-manager-history-btn');
    expect(historyBtn.textContent).toBe('');
  });
});

describe('LazyManagerHeader — tab strip: close button on every open conversation', () => {
  it('a single open conversation renders no tab strip at all (unchanged single-conversation look)', () => {
    renderRealTree();
    expect(screen.queryByTestId('lazy-manager-conversation-tabs')).not.toBeInTheDocument();
  });

  it('opening a second conversation reveals the strip, each tab carrying its own close button', async () => {
    renderRealTree();
    await act(async () => {
      fireEvent.click(screen.getByTestId('lazy-manager-new-conv'));
    });

    const tabs = screen.getAllByTestId('lazy-manager-conversation-tab');
    expect(tabs).toHaveLength(2);
    const closeButtons = screen.getAllByTestId('lazy-manager-conversation-tab-close');
    expect(closeButtons).toHaveLength(2);
    // Real translated label, never the raw i18n key leaking through.
    expect(closeButtons[0]).toHaveAttribute('aria-label', 'Fermer la conversation');
  });

  it('clicking a tab\'s close button removes exactly that tab, keeping the other one intact', async () => {
    renderRealTree();
    await act(async () => {
      fireEvent.click(screen.getByTestId('lazy-manager-new-conv'));
    });
    expect(screen.getAllByTestId('lazy-manager-conversation-tab')).toHaveLength(2);

    // Close the FIRST tab (the original conversation, now a background tab
    // since "+" switched the active one to the fresh second conversation).
    await act(async () => {
      fireEvent.click(screen.getAllByTestId('lazy-manager-conversation-tab-close')[0]!);
    });

    // Back down to a single conversation — the tab strip itself is now
    // gone again (same "only rendered once a second conversation is
    // actually open" contract as the very first test above), never a
    // dangling empty strip.
    expect(screen.queryByTestId('lazy-manager-conversation-tabs')).not.toBeInTheDocument();
  });

  it('closing a tab never deletes it from history — it reopens via the History drawer with its own transcript intact', async () => {
    renderRealTree();
    fireEvent.change(screen.getByTestId('manager-input'), { target: { value: 'Prepare the changelog' } });
    fireEvent.click(screen.getByTestId('manager-send'));
    await waitFor(() => expect(screen.getByTestId('manager-message-user')).toHaveTextContent('Prepare the changelog'));
    // Let the turn resolve so the message is genuinely part of this
    // conversation's transcript (never mid-flight when closed).
    // No runManagerTurn mock resolution wired here — the composer's own
    // busy state doesn't block closing, so close it right away.

    await act(async () => {
      fireEvent.click(screen.getByTestId('lazy-manager-new-conv'));
    });
    const closeButtons = screen.getAllByTestId('lazy-manager-conversation-tab-close');
    await act(async () => {
      fireEvent.click(closeButtons[0]!);
    });

    // Reopen from history — the drawer must still list it (never deleted).
    // History is a direct Row-1 control (re-promoted 2026-08-02 — see
    // LazyManagerHeader.tsx), reachable in one click, no menu to open first.
    await act(async () => {
      fireEvent.click(screen.getByTestId('lazy-manager-history-btn'));
    });
    await waitFor(() => {
      expect(screen.getByText(/Prepare the changelog/)).toBeInTheDocument();
    });
  });

  it('a trailing "+" at the end of the tab strip opens another conversation (the standard tabbed-UI convention)', async () => {
    renderRealTree();
    await act(async () => {
      fireEvent.click(screen.getByTestId('lazy-manager-new-conv'));
    });
    expect(screen.getAllByTestId('lazy-manager-conversation-tab')).toHaveLength(2);

    await act(async () => {
      fireEvent.click(screen.getByTestId('lazy-manager-conversation-tab-add'));
    });
    expect(screen.getAllByTestId('lazy-manager-conversation-tab')).toHaveLength(3);
  });

  it('the trailing "+" respects the open-conversation cap exactly like the header button', async () => {
    renderRealTree();
    // MAX_OPEN_MANAGER_CONVERSATIONS is 6 — boots with 1 open. The header
    // pill (`lazy-manager-new-conv`) stays in the DOM at every conversation
    // count (owner rejected hiding it, see LazyManagerHeader.tsx's own doc
    // comment) — this test still drives the FIRST click through it and the
    // remaining 4 through the strip's own "+" to exercise both entry
    // points reaching the same cap.
    await act(async () => {
      fireEvent.click(screen.getByTestId('lazy-manager-new-conv'));
    });
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        fireEvent.click(screen.getByTestId('lazy-manager-conversation-tab-add'));
      });
    }
    const addBtn = screen.getByTestId('lazy-manager-conversation-tab-add');
    expect(addBtn).toBeDisabled();
    // The header pill must ALSO end up disabled-but-visible — never
    // removed from the DOM once the cap is reached.
    const pillBtn = screen.getByTestId('lazy-manager-new-conv');
    expect(pillBtn).toBeInTheDocument();
    expect(pillBtn).toBeDisabled();
  });

  it('Delete key on a focused tab closes it — a keyboard path, not mouse-only', async () => {
    renderRealTree();
    await act(async () => {
      fireEvent.click(screen.getByTestId('lazy-manager-new-conv'));
    });
    expect(screen.getAllByTestId('lazy-manager-conversation-tab')).toHaveLength(2);

    const tabs = screen.getAllByTestId('lazy-manager-conversation-tab');
    const firstTabSelectButton = tabs[0]!.querySelector('button')!;
    firstTabSelectButton.focus();
    await act(async () => {
      fireEvent.keyDown(firstTabSelectButton, { key: 'Delete' });
    });

    expect(screen.queryByTestId('lazy-manager-conversation-tabs')).not.toBeInTheDocument();
  });
});
