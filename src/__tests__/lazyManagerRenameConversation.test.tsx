/**
 * Tab-strip rename feature — real component tree (AgentsStoreProvider ->
 * LazyManagerStoreProvider -> LazyManager), same convention as
 * lazyManagerCloseConversation.test.tsx: a props-level harness could not
 * catch a defect that lives in what double-clicking the real DOM node does,
 * or in whether the rename actually reaches localStorage.
 *
 * Real defect this closes (2026-08-15 QA): several open tabs derived from
 * the same opening prompt were indistinguishable, and there was no way to
 * give one a name to tell it apart — see conversationTabLabel.test.ts for
 * the label-derivation half of the fix (customTitle wins over the derived
 * label) and lazyManagerConversationTabs.test.tsx for the inline-edit UI
 * itself. This file proves the missing middle: agentsStore.tsx's
 * renameManagerConversation actually updates the LIVE tab AND persists the
 * name to disk — a rename that only lived in React state would vanish on
 * the very next reload.
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
import type { ManagerSession } from '../lib/agents/managerPersistence';

const mockInvoke = vi.mocked(invoke);
const MANAGER_SESSIONS_KEY = 'lazy.managerSessions';

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

function renameFirstTab(newName: string) {
  const tab = screen.getAllByTestId('lazy-manager-conversation-tab')[0]!;
  fireEvent.doubleClick(tab.querySelector('button')!);
  const input = screen.getByTestId('lazy-manager-conversation-tab-rename-input');
  fireEvent.change(input, { target: { value: newName } });
  fireEvent.keyDown(input, { key: 'Enter' });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('lazy.locale', 'en');
  _resetCanvasStoreForTests();
  vi.mocked(runManagerTurn).mockReset();
  mockInvoke.mockReset();
  mockInvoke.mockResolvedValue(undefined);
});

afterEach(() => {
  localStorage.clear();
});

describe('LazyManager — tab-strip rename (double-click a tab)', () => {
  it('renaming a tab updates its own label and tooltip immediately, without touching any other open tab', async () => {
    renderRealTree();
    await act(async () => {
      fireEvent.click(screen.getByTestId('lazy-manager-new-conv'));
    });
    expect(screen.getAllByTestId('lazy-manager-conversation-tab')).toHaveLength(2);

    renameFirstTab('Release checklist');

    const tabs = screen.getAllByTestId('lazy-manager-conversation-tab');
    const firstBtn = tabs[0]!.querySelector('button')!;
    expect(firstBtn.textContent).toContain('Release checklist');
    expect(firstBtn.getAttribute('title')).toContain('Release checklist');

    // The SECOND tab (still a fresh, unrenamed conversation) is untouched —
    // a rename must never leak onto a sibling conversation.
    const secondBtn = tabs[1]!.querySelector('button')!;
    expect(secondBtn.textContent).not.toContain('Release checklist');
  });

  it('a rename actually reaches localStorage (lazy.managerSessions) once the conversation has at least one message — never lives only in React state', async () => {
    renderRealTree();
    await act(async () => {
      fireEvent.click(screen.getByTestId('lazy-manager-new-conv'));
    });

    // Give the (now active, second) conversation real content — saveMessages
    // is a documented no-op for a still-empty conversation, same "nothing
    // meaningful to persist yet" contract as the derived-label fallback.
    fireEvent.change(screen.getByTestId('manager-input'), { target: { value: 'Ship the release' } });
    fireEvent.click(screen.getByTestId('manager-send'));
    await waitFor(() => expect(screen.getByTestId('manager-message-user')).toHaveTextContent('Ship the release'));

    const tabs = screen.getAllByTestId('lazy-manager-conversation-tab');
    const activeTab = tabs.find((t) => t.getAttribute('data-active') === 'true')!;
    fireEvent.doubleClick(activeTab.querySelector('button')!);
    const input = screen.getByTestId('lazy-manager-conversation-tab-rename-input');
    fireEvent.change(input, { target: { value: 'Release checklist' } });
    await act(async () => {
      fireEvent.keyDown(input, { key: 'Enter' });
    });

    // renameManagerConversation writes straight to disk (bypassing the
    // debounced per-conversation autosave, which skips a conversation whose
    // messages/pendingApprovals references are unchanged) — no waitFor
    // should be needed, but one guards against any future re-introduction
    // of a debounce on this path.
    await waitFor(() => {
      const raw = JSON.parse(localStorage.getItem(MANAGER_SESSIONS_KEY) ?? '[]') as ManagerSession[];
      expect(raw.some((s) => s.title === 'Release checklist')).toBe(true);
    });
  });

  it('clearing the rename input (empty name) un-renames the conversation back to its derived label', async () => {
    renderRealTree();
    await act(async () => {
      fireEvent.click(screen.getByTestId('lazy-manager-new-conv'));
    });

    renameFirstTab('Temporary name');
    let tabs = screen.getAllByTestId('lazy-manager-conversation-tab');
    expect(tabs[0]!.querySelector('button')!.textContent).toContain('Temporary name');

    renameFirstTab('   ');
    tabs = screen.getAllByTestId('lazy-manager-conversation-tab');
    expect(tabs[0]!.querySelector('button')!.textContent).not.toContain('Temporary name');
  });
});
