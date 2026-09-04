/**
 * AppShell.test.tsx
 *
 * Regression tests for the space keep-alive fix (SpacesLayer, exported
 * from AppShell.tsx). Switching spaces used to unmount + remount the
 * whole space subtree on every navigation (the wrapper div was keyed on
 * `space`), so each visit re-ran that space's "on mount" data effects —
 * BrainSpace re-fetched its graph/health/brain-info, HomeSpace re-loaded
 * missions, etc. — every single time, not just the first. SpacesLayer now
 * keeps every space that has ever been active permanently mounted and
 * toggles visibility via CSS `display`, so revisiting a space reuses its
 * existing instance instead of remounting it.
 *
 * All 8 space modules are replaced with a trivial mount-counting stub —
 * this file only asserts the KEEP-ALIVE MECHANISM itself (mount once,
 * never again on revisit; hidden via display:none rather than unmounted),
 * not any individual space's own data-fetching behavior (already covered
 * by its own dedicated test file, e.g. BrainSpace.test.tsx, HomeSpace has
 * no dedicated file but its mission-load effect is unaffected by this
 * change in shape, only in how often it fires).
 *
 * Wrapped in the real I18nProvider (not mocked) because the shared
 * Suspense fallback (SpaceFallback -> Spinner) reads useI18n() — cheap and
 * self-contained, same convention as MemoryPanel.test.tsx etc.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { useEffect, type ReactElement } from 'react';
import { SpacesLayer } from '../components/AppShell';
import { I18nProvider } from '../i18n';
import type { SpaceId } from '../app/AppContext';

// ── Mount-counting stubs ──────────────────────────────────────────────

const mountCounts: Record<string, number> = {};

function resetMountCounts(): void {
  for (const key of Object.keys(mountCounts)) delete mountCounts[key];
}

function makeSpaceStub(id: string) {
  return function SpaceStub() {
    // useEffect (fires once per real mount), never on a plain re-render —
    // mirrors how a real space's "on mount" data fetch behaves.
    useEffect(() => {
      mountCounts[id] = (mountCounts[id] ?? 0) + 1;
    }, []);
    return <div data-testid={`space-${id}`}>{id} content</div>;
  };
}

vi.mock('../spaces/CodeSpace', () => ({ CodeSpace: makeSpaceStub('code') }));
vi.mock('../spaces/AgentsSpace', () => ({ AgentsSpace: makeSpaceStub('agents') }));
vi.mock('../spaces/BrainSpace', () => ({ BrainSpace: makeSpaceStub('brain') }));
vi.mock('../spaces/ReviewSpace', () => ({ ReviewSpace: makeSpaceStub('review') }));
vi.mock('../spaces/TerminalsSpace', () => ({ TerminalsSpace: makeSpaceStub('terminals') }));
vi.mock('../spaces/SettingsSpace', () => ({ SettingsSpace: makeSpaceStub('settings') }));
vi.mock('../spaces/TeamSpace', () => ({ TeamSpace: makeSpaceStub('team') }));
vi.mock('../spaces/HomeSpace', () => ({ HomeSpace: makeSpaceStub('home') }));

beforeEach(() => {
  resetMountCounts();
});

function spaces(activeSpace: SpaceId, showTeamTab: boolean): ReactElement {
  return (
    <I18nProvider>
      <SpacesLayer activeSpace={activeSpace} showTeamTab={showTeamTab} />
    </I18nProvider>
  );
}

// Waits for a space's stub to be MOUNTED — both its DOM node present AND
// its mount-counting effect having actually fired. Checking only
// `findByTestId` is NOT enough: that resolves as soon as the DOM commits,
// but useEffect is a passive effect that can flush a tick later, so under
// a loaded full-suite run there is a real (if narrow) window where the DOM
// node exists but the mount count hasn't been incremented yet. Waiting on
// both together (via a single waitFor) closes that race instead of
// racing it with a longer findByTestId timeout alone.
async function waitForSpaceMounted(id: SpaceId, expectedCount = 1): Promise<void> {
  await waitFor(
    () => {
      expect(screen.getByTestId(`space-${id}`)).toBeInTheDocument();
      expect(mountCounts[id]).toBe(expectedCount);
    },
    { timeout: 5000 },
  );
}

describe('SpacesLayer — keep-alive (no remount-refetch on revisit)', () => {
  it('mounts the initial space exactly once', async () => {
    render(spaces('home', false));
    await waitForSpaceMounted('home');
  });

  it('mounts a newly visited space without remounting the previous one', async () => {
    const { rerender } = render(spaces('home', false));
    await waitForSpaceMounted('home');

    rerender(spaces('brain', false));
    await waitForSpaceMounted('brain');

    expect(mountCounts.home).toBe(1); // unchanged — home was NOT remounted
  });

  it('revisiting a space reuses its existing instance instead of remounting it', async () => {
    const { rerender } = render(spaces('home', false));
    await waitForSpaceMounted('home');

    rerender(spaces('brain', false));
    await waitForSpaceMounted('brain');

    rerender(spaces('home', false));
    expect(screen.getByTestId('space-home')).toBeInTheDocument();
    expect(mountCounts.home).toBe(1); // still 1 — this is the actual bug fix

    rerender(spaces('brain', false));
    expect(screen.getByTestId('space-brain')).toBeInTheDocument();
    expect(mountCounts.brain).toBe(1); // still 1 on the second revisit too
  });

  it('switching away hides the previous space via display:none instead of unmounting it', async () => {
    const { rerender } = render(spaces('home', false));
    await waitForSpaceMounted('home');

    rerender(spaces('brain', false));
    await waitForSpaceMounted('brain');

    // Both DOM nodes still exist...
    const homeEl = screen.getByTestId('space-home');
    const brainEl = screen.getByTestId('space-brain');
    expect(homeEl).toBeInTheDocument();
    expect(brainEl).toBeInTheDocument();

    // ...but only the active one is visible.
    expect(homeEl.parentElement).toHaveStyle({ display: 'none' });
    expect(brainEl.parentElement).toHaveStyle({ display: 'flex' });
  });

  it('keeps accumulating visited spaces across many switches without ever remounting an old one', async () => {
    const order: SpaceId[] = ['home', 'code', 'agents', 'brain', 'review', 'code', 'home', 'brain'];
    const { rerender } = render(spaces(order[0], false));
    await waitForSpaceMounted(order[0]);

    for (const space of order.slice(1)) {
      rerender(spaces(space, false));
      await waitForSpaceMounted(space);
    }

    expect(mountCounts.home).toBe(1);
    expect(mountCounts.code).toBe(1);
    expect(mountCounts.agents).toBe(1);
    expect(mountCounts.brain).toBe(1);
    expect(mountCounts.review).toBe(1);
  });

  it('renders the "team" space only when showTeamTab is true', async () => {
    const { rerender } = render(spaces('team', false));
    expect(screen.queryByTestId('space-team')).toBeNull();

    rerender(spaces('team', true));
    await waitForSpaceMounted('team');
  });

  it('navigating away from "team" and back does not remount it (showTeamTab held constant, as it is for the whole time a real user can reach the tab at all)', async () => {
    const { rerender } = render(spaces('team', true));
    await waitForSpaceMounted('team');

    rerender(spaces('code', true));
    await waitForSpaceMounted('code');

    rerender(spaces('team', true));
    expect(screen.getByTestId('space-team')).toBeInTheDocument();
    expect(mountCounts.team).toBe(1); // unchanged — same keep-alive guarantee as every other space
  });
});
