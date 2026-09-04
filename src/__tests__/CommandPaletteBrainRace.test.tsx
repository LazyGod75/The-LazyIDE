/* CommandPalette — stale brain-search response race regression test.
   B3.1: the 200ms-debounced platform.brain.search() effect's cleanup only
   clears the pending setTimeout — it never cancels a request already in
   flight. A slow response for an EARLIER query can resolve after a fast
   response for a LATER query and silently overwrite the palette's brain
   results with stale nodes.

   Fix mirrors ContextPicker.tsx's proven `cancelled` closure-flag pattern
   exactly: the effect captures `cancelled`, sets it in its cleanup, and the
   .then() handler checks it before calling setState.

   All surrounding contexts (AppContext, editor store, agents UI context,
   subscription context, toast) are stubbed via importOriginal + override —
   this test only exercises the brain-search race, not those integrations.
*/

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { CommandPalette } from '../components/palette/CommandPalette';
import type { BrainSearchResult } from '../lib/platform/types';

vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return { ...actual, getPlatform: vi.fn() };
});

vi.mock('../app/AppContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/AppContext')>();
  return {
    ...actual,
    useAppContext: () => ({
      setActiveSpace: vi.fn(),
      openProject: vi.fn(),
      projectRoot: '',
    }),
  };
});

vi.mock('../components/editor/editorStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/editor/editorStore')>();
  return { ...actual, useEditorStore: () => ({ openFile: vi.fn(), tabs: [] }) };
});

vi.mock('../components/agents/agentsUiContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/agents/agentsUiContext')>();
  return { ...actual, useAgentsUiContext: () => ({ requestNewMission: vi.fn() }) };
});

vi.mock('../lib/billing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/billing')>();
  return { ...actual, useSubscriptionContext: () => ({ isPro: false, isProPlus: false }) };
});

vi.mock('../components/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../components/ui')>();
  return { ...actual, useToast: () => ({ toast: vi.fn() }) };
});

import { getPlatform } from '../lib/platform';
const mockGetPlatform = getPlatform as ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

// jsdom does not implement scrollIntoView; CommandPalette calls it to keep
// the highlighted row in view whenever the item list changes.
Element.prototype.scrollIntoView = vi.fn();

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('CommandPalette — brain search race condition (B3.1)', () => {
  it('discards a slow response for an earlier query once a later query has resolved', async () => {
    vi.useFakeTimers();

    const slow = deferred<BrainSearchResult[]>();
    const fast = deferred<BrainSearchResult[]>();
    const search = vi.fn((q: string) => (q === 'alpha' ? slow.promise : fast.promise));
    mockGetPlatform.mockReturnValue({ name: 'tauri', brain: { search }, fs: { readDir: vi.fn() } });

    render(
      <I18nProvider>
        <CommandPalette isOpen={true} onClose={vi.fn()} />
      </I18nProvider>,
    );

    const input = screen.getByRole('textbox');

    // First query: "alpha" — debounced 200ms, then in flight (slow).
    fireEvent.change(input, { target: { value: 'alpha' } });
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(search).toHaveBeenCalledWith('alpha', 4);

    // Second query: "beta" — supersedes "alpha" before it resolves.
    fireEvent.change(input, { target: { value: 'beta' } });
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(search).toHaveBeenCalledWith('beta', 4);

    // "beta" (fast) resolves first.
    await act(async () => {
      fast.resolve([{ id: 'b1', title: 'Beta Node', snippet: '', score: 1 }]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('Beta Node')).toBeInTheDocument();

    // "alpha" (slow) resolves late, after "beta" already rendered.
    await act(async () => {
      slow.resolve([{ id: 'a1', title: 'Alpha Node', snippet: '', score: 1 }]);
      await Promise.resolve();
      await Promise.resolve();
    });

    // The stale "alpha" response must NOT overwrite the newer "beta" result.
    expect(screen.getByText('Beta Node')).toBeInTheDocument();
    expect(screen.queryByText('Alpha Node')).not.toBeInTheDocument();
  });
});
