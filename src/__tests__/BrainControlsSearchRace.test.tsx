/* BrainControls — stale search response race regression test.
   B3.1: runSearch's debounced platform.brain.search() call has no guard
   against out-of-order resolution. A slow response for an EARLIER query can
   resolve after a fast response for a LATER query and overwrite it with
   stale results — the classic "slowest response wins" race.

   Mirrors the fix pattern already proven in ContextPicker.tsx (cancelled
   flag) adapted to BrainControls' ref-driven debounce shape (a monotonic
   request token instead of an effect-cleanup boolean, since runSearch is
   invoked directly from a setTimeout, not from an effect with cleanup).
*/

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { BrainControls } from '../components/brain/BrainControls';
import type { BrainSearchResult } from '../lib/platform/types';

vi.mock('../lib/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/platform')>();
  return {
    ...actual,
    getPlatform: vi.fn(),
  };
});

import { getPlatform } from '../lib/platform';
const mockGetPlatform = getPlatform as ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function renderControls(search: ReturnType<typeof vi.fn>) {
  mockGetPlatform.mockReturnValue({ name: 'tauri', brain: { search } });
  return render(
    <I18nProvider>
      <BrainControls
        clusters={['core']}
        onFilterChange={vi.fn()}
        onSearchSelect={vi.fn()}
        paletteId="spectre"
        onPaletteChange={vi.fn()}
        is3D={true}
        onIs3DChange={vi.fn()}
        zoom={1}
        onZoomChange={vi.fn()}
      />
    </I18nProvider>,
  );
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('BrainControls — search race condition (B3.1)', () => {
  it('discards a slow response for an earlier query once a later query has resolved', async () => {
    vi.useFakeTimers();

    const slow = deferred<BrainSearchResult[]>();
    const fast = deferred<BrainSearchResult[]>();
    const search = vi.fn((q: string) => (q === 'alpha' ? slow.promise : fast.promise));

    renderControls(search);
    const input = screen.getByPlaceholderText('Search the brain…');

    // First query: "alpha" — debounced 300ms, then in flight (slow).
    fireEvent.change(input, { target: { value: 'alpha' } });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(search).toHaveBeenCalledWith('alpha', 8);

    // Second query: "beta" — supersedes "alpha" before it resolves.
    fireEvent.change(input, { target: { value: 'beta' } });
    await act(async () => { vi.advanceTimersByTime(300); });
    expect(search).toHaveBeenCalledWith('beta', 8);

    // "beta" (fast) resolves first.
    await act(async () => {
      fast.resolve([
        { id: 'b1', title: 'Beta Result', snippet: '', score: 1 },
      ]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByText('Beta Result')).toBeInTheDocument();

    // "alpha" (slow) resolves late, after "beta" already rendered.
    await act(async () => {
      slow.resolve([
        { id: 'a1', title: 'Alpha Result', snippet: '', score: 1 },
      ]);
      await Promise.resolve();
      await Promise.resolve();
    });

    // The stale "alpha" response must NOT overwrite the newer "beta" result.
    expect(screen.getByText('Beta Result')).toBeInTheDocument();
    expect(screen.queryByText('Alpha Result')).not.toBeInTheDocument();
  });
});
