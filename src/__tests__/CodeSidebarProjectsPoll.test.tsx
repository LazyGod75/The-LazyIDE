/**
 * CodeSidebarProjectsPoll.test.tsx — Fix 3 (hidden-space poll gating).
 * AppShell.tsx keeps every visited Space mounted (display:none on inactive
 * ones, never unmounted) — ProjectRow's git-status poll (GIT_POLL_MS) used
 * to keep firing forever even while the Code space is hidden behind another.
 * Proves the poll only actually runs while the Code space is the active one,
 * and that a host with no AppProvider ancestor (this file's own sibling
 * suite, CodeSidebarProjectsContextMenu.test.tsx, renders ProjectRow
 * standalone) is unaffected — never a behavior regression for that suite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor, act } from '@testing-library/react';
import React from 'react';
import { ProjectRow } from '../components/editor/codespace/CodeSidebarProjects';
import type { Platform, DirEntry, GitStatus } from '../lib/platform/types';
import type { ProjectEntry, SpaceId } from '../app/AppContext';

vi.mock('../i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
  }),
}));

vi.mock('../components/ui', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock('../lib/bus', () => ({ emit: vi.fn() }));

// Controls what useAppContextOptional() returns for this file's tests —
// `undefined` reproduces "no AppProvider ancestor" (the standalone-render
// case this fix must leave unaffected).
let mockActiveSpace: SpaceId | undefined;
vi.mock('../app/AppContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../app/AppContext')>();
  return {
    ...actual,
    useAppContextOptional: () => (mockActiveSpace === undefined ? null : { activeSpace: mockActiveSpace }),
  };
});

afterEach(() => {
  vi.clearAllMocks();
});

const ROOT = 'C:/repo';

function makeProject(): ProjectEntry {
  return { id: 'proj-1', root: ROOT, brainId: null, active: true, gitInitNote: null };
}

function makePlatform(gitStatus: GitStatus, dirEntries: Record<string, DirEntry[]> = {}): Platform {
  return {
    name: 'tauri',
    fs: { readDir: vi.fn((p: string) => Promise.resolve(dirEntries[p] ?? [])) },
    git: { status: vi.fn().mockResolvedValue(gitStatus) },
  } as unknown as Platform;
}

function renderRow(platform: Platform) {
  return render(
    <ProjectRow
      project={makeProject()}
      fleet={undefined}
      platform={platform}
      activeTabPath={null}
      isExpanded
      onToggleExpanded={vi.fn()}
      onFileOpen={vi.fn()}
    />
  );
}

describe('ProjectRow git-status poll — gated on the Code space being active (Fix 3)', () => {
  beforeEach(() => {
    mockActiveSpace = undefined;
  });

  it('polls when the Code space is active', async () => {
    mockActiveSpace = 'code';
    const platform = makePlatform({ branch: 'main', ahead: 0, behind: 0, files: [] });
    renderRow(platform);

    await waitFor(() => expect(platform.git.status).toHaveBeenCalledTimes(1));
  });

  it('does NOT poll when a DIFFERENT space is active', async () => {
    mockActiveSpace = 'agents';
    const platform = makePlatform({ branch: 'main', ahead: 0, behind: 0, files: [] });
    renderRow(platform);

    // Give any (incorrect) async poll a chance to fire before asserting it
    // never did.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(platform.git.status).not.toHaveBeenCalled();
  });

  it('still polls when rendered with no AppProvider ancestor at all (fail-open — never a regression for a standalone render)', async () => {
    mockActiveSpace = undefined;
    const platform = makePlatform({ branch: 'main', ahead: 0, behind: 0, files: [] });
    renderRow(platform);

    await waitFor(() => expect(platform.git.status).toHaveBeenCalledTimes(1));
  });

  it('starts polling once the active space switches TO code', async () => {
    mockActiveSpace = 'agents';
    const platform = makePlatform({ branch: 'main', ahead: 0, behind: 0, files: [] });
    const { rerender } = render(
      <ProjectRow
        project={makeProject()}
        fleet={undefined}
        platform={platform}
        activeTabPath={null}
        isExpanded
        onToggleExpanded={vi.fn()}
        onFileOpen={vi.fn()}
      />
    );
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(platform.git.status).not.toHaveBeenCalled();

    mockActiveSpace = 'code';
    rerender(
      <ProjectRow
        project={makeProject()}
        fleet={undefined}
        platform={platform}
        activeTabPath={null}
        isExpanded
        onToggleExpanded={vi.fn()}
        onFileOpen={vi.fn()}
      />
    );

    await waitFor(() => expect(platform.git.status).toHaveBeenCalledTimes(1));
  });
});

// ── F7 fix: collapsed rows must still resolve a real branch ──────────────
//
// Before this fix, the branch fetch itself was gated on `isExpanded` — a
// COLLAPSED project's header (always visible, unlike the file tree below it)
// never fetched at all, so its `branch ?? '…'` fallback rendered a
// permanently-unresolved "…" for the row's entire lifetime, indistinguishable
// from a genuine loading state. Now every row does a one-shot fetch
// regardless of expansion; only the recurring GIT_POLL_MS poll stays
// expand-gated.

describe('ProjectRow branch fetch — resolves even when collapsed (F7 fix)', () => {
  beforeEach(() => {
    mockActiveSpace = 'code';
  });

  it('fetches the branch once for a COLLAPSED row (no poll), and renders the resolved branch — not a stuck "…"', async () => {
    const platform = makePlatform({ branch: 'main', ahead: 0, behind: 0, files: [] });

    const { getByText, getByTitle, queryByText } = render(
      <ProjectRow
        project={makeProject()}
        fleet={undefined}
        platform={platform}
        activeTabPath={null}
        isExpanded={false}
        onToggleExpanded={vi.fn()}
        onFileOpen={vi.fn()}
      />
    );

    // The project-color dot is discoverable via tooltip as an identity color,
    // not a status indicator (colorForProject.ts derives it purely from the
    // project id — see this suite's own sibling file for that contract).
    expect(getByTitle('codespace.projects.colorDotTooltip:repo')).toBeTruthy();

    // Before the fetch resolves, the "…" placeholder is shown with an
    // explaining title — never a bare, unexplained ellipsis.
    expect(getByText('…').title).toBe('codespace.projects.branchLoading');

    await waitFor(() => expect(platform.git.status).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(getByText('main').title).toBe('codespace.projects.branchTooltip:main'));

    // The "…" placeholder is gone once the real branch is known.
    expect(queryByText('…')).toBeNull();

    // No recurring poll while collapsed — a second call would only ever
    // come from the GIT_POLL_MS interval, which must stay expand-gated.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(platform.git.status).toHaveBeenCalledTimes(1);
  });

  it('does NOT fetch when a different space is active, even when collapsed', async () => {
    mockActiveSpace = 'agents';
    const platform = makePlatform({ branch: 'main', ahead: 0, behind: 0, files: [] });

    render(
      <ProjectRow
        project={makeProject()}
        fleet={undefined}
        platform={platform}
        activeTabPath={null}
        isExpanded={false}
        onToggleExpanded={vi.fn()}
        onFileOpen={vi.fn()}
      />
    );

    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(platform.git.status).not.toHaveBeenCalled();
  });
});
