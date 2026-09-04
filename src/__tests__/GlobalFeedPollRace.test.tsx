/* GlobalFeed — interval poller out-of-order resolution regression test.
   B3.2: refresh() is invoked on a bare setInterval with no guard against a
   slow tick resolving after a faster, more recent tick. If a tick takes
   longer than the 30s interval (or is simply slower than a later tick for
   any reason — network jitter, a busy sidecar, ...), its stale result can
   land AFTER a fresher tick's result and silently replace it on screen.

   Fix: a monotonic tick token — the same "discard superseded work"
   principle proven for debounced searches (ContextPicker.tsx), adapted to
   a free-running poller instead of a debounce.
*/

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { GlobalFeed } from '../components/agents/GlobalFeed';
import type { ActivityFeedItem } from '../lib/journal/projections';

vi.mock('../lib/journal/projections', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/journal/projections')>();
  return { ...actual, queryActivityFeed: vi.fn() };
});

import { queryActivityFeed } from '../lib/journal/projections';
const mockQuery = queryActivityFeed as ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function item(seq: number, actor: string): ActivityFeedItem {
  return {
    seq,
    ts_ms: Date.now(),
    project_id: 'proj-1',
    mission_id: null,
    event_type: 'mission.created',
    actor,
    payload_preview: '',
  };
}

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('GlobalFeed — interval poller race condition (B3.2)', () => {
  it('keeps the most recent tick result even when an earlier tick resolves later', async () => {
    vi.useFakeTimers();

    const tick1 = deferred<ActivityFeedItem[]>(); // slow — started first
    const tick2 = deferred<ActivityFeedItem[]>(); // fast — started second, resolves first
    // Initial mount call resolves immediately with an empty feed so the
    // component reaches its steady (non-empty-state) render quickly.
    mockQuery.mockReturnValueOnce(Promise.resolve([item(0, 'mount')]));
    mockQuery.mockReturnValueOnce(tick1.promise);
    mockQuery.mockReturnValueOnce(tick2.promise);

    render(
      <I18nProvider>
        <GlobalFeed />
      </I18nProvider>,
    );

    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(screen.getByTestId('feed-item-0')).toBeInTheDocument();

    // Tick 1 fires (slow, in flight).
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(mockQuery).toHaveBeenCalledTimes(2);

    // Tick 2 fires before tick 1 resolves (simulates tick1 running long).
    await act(async () => { vi.advanceTimersByTime(30_000); });
    expect(mockQuery).toHaveBeenCalledTimes(3);

    // Tick 2 (fast/newer) resolves first.
    await act(async () => {
      tick2.resolve([item(2, 'tick2-actor')]);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId('feed-item-2')).toBeInTheDocument();

    // Tick 1 (slow/older) resolves late, after tick 2 already rendered.
    await act(async () => {
      tick1.resolve([item(1, 'tick1-actor')]);
      await Promise.resolve();
      await Promise.resolve();
    });

    // The stale tick 1 result must NOT overwrite the newer tick 2 result.
    expect(screen.getByTestId('feed-item-2')).toBeInTheDocument();
    expect(screen.queryByTestId('feed-item-1')).not.toBeInTheDocument();
  });
});
