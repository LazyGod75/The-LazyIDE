/**
 * SpacesRail.switchProjectFailure.test.tsx — B2 fix (silent-failure audit):
 * ProjectsSection's project-switch click handler used to be
 * `switchProject(project.id).catch(() => {})` — a failed switch (Tauri IPC
 * error, project removed from disk, etc.) left NO trace anywhere: no
 * console.error, no toast, no visual change. A user clicking a project icon
 * and seeing nothing happen had no way to know why, and neither did support
 * reading logs afterward.
 *
 * Fixed: the catch now logs the error with context (project id) via
 * console.error AND shows a toast — the target project is by construction
 * already present in openProjects (ProjectsSection only renders switch
 * buttons for already-open projects), so "it already exists in the app" is
 * always true here, matching REVUE-ARTISANAT.md Lot B item err-1's
 * requirement for visible feedback in that case.
 *
 * This test asserts the NEW behavior (RED before the fix: no console.error
 * call was ever made, since the catch handler was empty).
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { SpacesRail } from '../components/SpacesRail';
import type { ProjectEntry } from '../app/AppContext';

afterEach(cleanup);

const switchProjectMock = vi.fn();
const toastMock = vi.fn();

const projectA: ProjectEntry = { id: 'proj-a', root: '/repo/a', brainId: null, active: true, gitInitNote: null };
const projectB: ProjectEntry = { id: 'proj-b', root: '/repo/b', brainId: null, active: false, gitInitNote: null };

vi.mock('../app/AppContext', () => ({
  useAppContext: () => ({
    platform: { name: 'web' },
    openProjects: [projectA, projectB],
    activeProjectId: 'proj-a',
    switchProject: switchProjectMock,
    openProject: vi.fn(),
  }),
}));

vi.mock('../lib/auth', () => ({
  useAuth: () => ({ user: { email: 'founder@example.com' }, signOut: vi.fn() }),
}));

vi.mock('../components/ui', () => ({
  useToast: () => ({ toast: toastMock }),
  useToastSafe: () => toastMock,
}));

function renderRail() {
  return render(
    <I18nProvider>
      <SpacesRail activeSpace="home" agentCount={0} onSpaceChange={vi.fn()} showTeamTab={false} />
    </I18nProvider>,
  );
}

describe('SpacesRail — ProjectsSection switchProject failure', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    switchProjectMock.mockReset();
    toastMock.mockReset();
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('logs the error with the project id when switchProject rejects', async () => {
    const failure = new Error('IPC unavailable');
    switchProjectMock.mockRejectedValue(failure);
    renderRail();

    fireEvent.click(screen.getByRole('button', { name: 'b' }));

    await waitFor(() => {
      expect(consoleErrorSpy).toHaveBeenCalled();
    });
    const call = consoleErrorSpy.mock.calls.find((args) =>
      args.some((arg) => typeof arg === 'string' && arg.includes('switchProject')),
    );
    expect(call).toBeDefined();
    expect(JSON.stringify(call)).toContain('proj-b');
  });

  it('shows a visible toast when switchProject rejects for an already-open project', async () => {
    switchProjectMock.mockRejectedValue(new Error('IPC unavailable'));
    renderRail();

    fireEvent.click(screen.getByRole('button', { name: 'b' }));

    await waitFor(() => {
      expect(toastMock).toHaveBeenCalled();
    });
  });

  it('does not log or toast on a successful switch (nominal path unchanged)', async () => {
    switchProjectMock.mockResolvedValue(undefined);
    renderRail();

    fireEvent.click(screen.getByRole('button', { name: 'b' }));

    await waitFor(() => {
      expect(switchProjectMock).toHaveBeenCalledWith('proj-b');
    });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    expect(toastMock).not.toHaveBeenCalled();
  });
});
