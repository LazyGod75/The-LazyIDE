/**
 * FluxFooter.test.tsx — sweep #7 / audit P07 fix.
 *
 * Covers the one piece of the fix that lives in the component rather than
 * activityFeedFormat.ts's pure formatter: clicking a ticker entry that has a
 * mission id must focus that mission on the canvas via the same
 * 'canvas:focus' bus event the manager itself uses (useCanvasManagerEvents.ts),
 * and an entry with no mission id (e.g. project.opened) must not be
 * clickable at all.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { FluxFooter } from '../components/agents/cockpit/FluxFooter';
import { on } from '../lib/bus';
import type { ActivityFeedItem } from '../lib/journal/projections';
import { setSystemPressureForTests, resetSystemPressureForTests } from '../lib/agents/systemPressure';
import { buildFeedEntries } from '../lib/journal/activityFeedFormat';

const mockBuildFeedEntries = vi.mocked(buildFeedEntries);

const mockQueryActivityFeed = vi.fn<() => Promise<ActivityFeedItem[]>>(() => Promise.resolve([]));
vi.mock('../lib/journal/projections', () => ({
  queryActivityFeed: (...args: unknown[]) => mockQueryActivityFeed(...(args as [])),
}));

// Wraps the REAL buildFeedEntries in a spy (not a stub) so the memoisation
// test below can assert call COUNT while every other test in this file
// still gets real dedupe/formatting output.
vi.mock('../lib/journal/activityFeedFormat', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/journal/activityFeedFormat')>();
  return { ...actual, buildFeedEntries: vi.fn(actual.buildFeedEntries) };
});

function makeItem(overrides: Partial<ActivityFeedItem> & { event_type: string }): ActivityFeedItem {
  return {
    seq: 1,
    ts_ms: Date.now(),
    project_id: 'demo-shop',
    mission_id: null,
    actor: 'agent',
    payload_preview: '{}',
    ...overrides,
  };
}

function renderFooter() {
  return render(
    <I18nProvider>
      <FluxFooter />
    </I18nProvider>,
  );
}

beforeEach(() => {
  mockQueryActivityFeed.mockReset();
  mockBuildFeedEntries.mockClear();
  localStorage.setItem('lazy.locale', 'fr');
  resetSystemPressureForTests();
});

afterEach(() => {
  resetSystemPressureForTests();
});

describe('FluxFooter', () => {
  it('renders nothing when there is no activity yet', async () => {
    mockQueryActivityFeed.mockResolvedValue([]);
    renderFooter();
    // Let the initial poll() microtask (and its setState) resolve/flush.
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('flux-footer')).not.toBeInTheDocument();
  });

  it('renders one entry per row, and clicking a mission entry emits canvas:focus for that mission', async () => {
    mockQueryActivityFeed.mockResolvedValue([
      makeItem({ seq: 1, event_type: 'mission.started', mission_id: 'M9', payload_preview: '{}' }),
    ]);

    const focusEvents: Array<{ ref: string }> = [];
    const navEvents: unknown[] = [];
    const unsubFocus = on('canvas:focus', (payload) => focusEvents.push(payload));
    const unsubNav = on('nav:navigateSpace', (payload) => navEvents.push(payload));

    renderFooter();
    const entry = await screen.findByTestId('flux-entry-1');
    expect(entry).toHaveAttribute('role', 'button');

    fireEvent.click(entry);

    expect(focusEvents).toEqual([{ ref: 'mission:M9' }]);
    expect(navEvents).toEqual(['agents']);

    unsubFocus();
    unsubNav();
  });

  it('does not make an entry with no mission id (e.g. project.opened) clickable', async () => {
    mockQueryActivityFeed.mockResolvedValue([
      makeItem({ seq: 1, event_type: 'project.opened', mission_id: null, payload_preview: '{"root":"/x/demo-shop"}' }),
    ]);

    const focusEvents: unknown[] = [];
    const unsub = on('canvas:focus', (payload) => focusEvents.push(payload));

    renderFooter();
    const entry = await screen.findByTestId('flux-entry-1');
    expect(entry).not.toHaveAttribute('role', 'button');

    fireEvent.click(entry);
    expect(focusEvents).toEqual([]);

    unsub();
  });

  it('pressing Enter on a focused mission entry also emits canvas:focus (keyboard access)', async () => {
    mockQueryActivityFeed.mockResolvedValue([
      makeItem({ seq: 1, event_type: 'mission.started', mission_id: 'M9', payload_preview: '{}' }),
    ]);

    const focusEvents: Array<{ ref: string }> = [];
    const unsub = on('canvas:focus', (payload) => focusEvents.push(payload));

    renderFooter();
    const entry = await screen.findByTestId('flux-entry-1');
    fireEvent.keyDown(entry, { key: 'Enter' });

    expect(focusEvents).toEqual([{ ref: 'mission:M9' }]);
    unsub();
  });

  // FOUNDER NORTH STAR — the pressure pill must stay visible even with zero
  // real activity (an idle project can still be under machine pressure).
  it('stays visible (pill only) when there is no activity but the machine is under pressure', async () => {
    mockQueryActivityFeed.mockResolvedValue([]);
    setSystemPressureForTests({ level: 'high' });

    renderFooter();
    await act(async () => { await Promise.resolve(); });

    expect(screen.getByTestId('flux-footer')).toBeInTheDocument();
    expect(screen.getByTestId('system-pressure-badge')).toBeInTheDocument();
  });

  it('renders no pressure pill while pressure is normal, even with real activity', async () => {
    mockQueryActivityFeed.mockResolvedValue([
      makeItem({ seq: 1, event_type: 'mission.started', mission_id: 'M9', payload_preview: '{}' }),
    ]);

    renderFooter();
    await screen.findByTestId('flux-entry-1');

    expect(screen.queryByTestId('system-pressure-badge')).not.toBeInTheDocument();
  });

  // Memoisation fix: buildFeedEntries(items, t) used to run inline in the
  // render body of this always-mounted, 8s-polling footer, so ANY
  // unrelated re-render (e.g. the system-pressure subscription firing)
  // recomputed it even though `items` hadn't changed.
  it('does not recompute buildFeedEntries on a re-render triggered by an unrelated state change (system pressure)', async () => {
    mockQueryActivityFeed.mockResolvedValue([
      makeItem({ seq: 1, event_type: 'mission.started', mission_id: 'M9', payload_preview: '{}' }),
    ]);

    renderFooter();
    await screen.findByTestId('flux-entry-1');
    const callsAfterInitialRender = mockBuildFeedEntries.mock.calls.length;
    expect(callsAfterInitialRender).toBeGreaterThan(0);

    // Triggers subscribeSystemPressure's listener -> setPressure -> a
    // FluxFooter re-render, with the exact same `items` array reference
    // (no new poll happened) and the exact same `t` reference (no locale
    // change) — buildFeedEntries must NOT run again for this render.
    act(() => {
      setSystemPressureForTests({ level: 'high' });
    });
    await screen.findByTestId('system-pressure-badge');

    expect(mockBuildFeedEntries.mock.calls.length).toBe(callsAfterInitialRender);
  });
});
