/**
 * SpacesRail.dismissal.test.tsx — founder bug fix audit (2026-07-22): the
 * same close-then-reopen race CockpitRailPopover.tsx/CanvasFloatingButtons.tsx
 * already got fixed (useDismissable.ts) also affected the sidebar's avatar
 * menu (AvatarPopover, internal to SpacesRail.tsx) — it's portaled to
 * `document.body`, so its own outside-pointerdown listener used to see the
 * avatar toggle button as "outside" (different DOM subtree), closing the
 * popover, followed by the button's own onClick toggle (reading the
 * now-stale closed state) reopening it. Now goes through the shared
 * useDismissable hook with a `triggerRef` — see AvatarPopover's usage in
 * SpacesRail.tsx.
 *
 * SpacesRail pulls in real app/auth/toast context — mocked here to the
 * minimum shape this component actually reads, same convention
 * AccountChip.test.tsx uses for its own dependencies.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { SpacesRail } from '../components/SpacesRail';

afterEach(cleanup);

vi.mock('../app/AppContext', () => ({
  useAppContext: () => ({
    platform: { name: 'web' },
    openProjects: [],
    activeProjectId: null,
    switchProject: vi.fn(),
    openProject: vi.fn(),
  }),
}));

vi.mock('../lib/auth', () => ({
  useAuth: () => ({
    user: { email: 'founder@example.com' },
    signOut: vi.fn(),
  }),
}));

vi.mock('../components/ui', () => ({
  useToast: () => ({ toast: vi.fn() }),
  useToastSafe: () => vi.fn(),
}));

function renderRail() {
  return render(
    <I18nProvider>
      <SpacesRail activeSpace="home" agentCount={0} onSpaceChange={vi.fn()} showTeamTab={false} />
    </I18nProvider>,
  );
}

describe('SpacesRail — avatar menu dismissal (founder bug fix)', () => {
  it('opens on click', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.getByRole('menu', { name: 'Account menu' })).toBeInTheDocument();
  });

  it('re-clicking the same avatar button while open closes it (does not reopen)', () => {
    renderRail();
    const avatar = screen.getByRole('button', { name: 'Account menu' });

    fireEvent.click(avatar);
    expect(screen.getByRole('menu', { name: 'Account menu' })).toBeInTheDocument();

    // Real browsers fire pointerdown before click for a single re-click —
    // fire both explicitly (fireEvent.click alone can't reproduce the race
    // this is guarding against, see useDismissable.test.tsx).
    fireEvent.pointerDown(avatar);
    fireEvent.click(avatar);

    expect(screen.queryByRole('menu', { name: 'Account menu' })).not.toBeInTheDocument();
  });

  it('clicking outside the menu closes it', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.getByRole('menu', { name: 'Account menu' })).toBeInTheDocument();

    fireEvent.pointerDown(document.body);

    expect(screen.queryByRole('menu', { name: 'Account menu' })).not.toBeInTheDocument();
  });

  it('pressing Escape closes it', () => {
    renderRail();
    fireEvent.click(screen.getByRole('button', { name: 'Account menu' }));
    expect(screen.getByRole('menu', { name: 'Account menu' })).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('menu', { name: 'Account menu' })).not.toBeInTheDocument();
  });
});
