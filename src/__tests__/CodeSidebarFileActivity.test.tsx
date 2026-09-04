import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { ProjectRow } from '../components/editor/codespace/CodeSidebarProjects';
import type { Platform, DirEntry } from '../lib/platform/types';
import type { ProjectEntry } from '../app/AppContext';
import type { FleetMission, FleetProject } from '../lib/agents/fleetMissions';

vi.mock('../i18n', () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
  }),
  useI18nOptional: () => ({
    t: (key: string, params?: Record<string, string | number>) =>
      params ? `${key}:${Object.values(params).join(',')}` : key,
  }),
}));

vi.mock('../components/ui', () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const ROOT = 'C:/repo';

function makeProject(): ProjectEntry {
  return { id: 'proj-1', root: ROOT, brainId: null, active: true, gitInitNote: null };
}

function makePlatform(dirEntries: Record<string, DirEntry[]>): Platform {
  return {
    name: 'web',
    fs: {
      readDir: vi.fn((p: string) => Promise.resolve(dirEntries[p] ?? [])),
    },
    git: { status: vi.fn() },
  } as unknown as Platform;
}

function mission(overrides: Partial<FleetMission> = {}): FleetMission {
  return {
    id: 'm1',
    title: 'Fix login',
    status: 'running',
    stage: 'code',
    model: 'sonnet',
    agentName: 'Coder',
    updatedMs: 1,
    urgent: false,
    ...overrides,
  };
}

function fleet(missions: FleetMission[]): FleetProject {
  return { projectId: 'p1', root: ROOT, name: 'repo', missions };
}

function renderWithMissions(missions: FleetMission[]) {
  const platform = makePlatform({
    [ROOT]: [{ name: 'a.ts', path: `${ROOT}/a.ts`, isDir: false }],
  });
  return render(
    <ProjectRow
      project={makeProject()}
      fleet={fleet(missions)}
      platform={platform}
      activeTabPath={null}
      isExpanded
      onToggleExpanded={vi.fn()}
      onFileOpen={vi.fn()}
    />,
  );
}

describe('Code sidebar file-activity cursor', () => {
  it('names the running agent on the file it is actually writing', async () => {
    renderWithMissions([mission({ liveAction: '▊ écrit a.ts…' })]);
    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument());
    const cursor = screen.getByTestId('code-file-activity-cursor');
    expect(cursor.textContent).toContain('Coder');
    expect(cursor.textContent).toContain('a.ts');
    expect(screen.getByTestId('code-file-activity-dot')).toHaveAttribute('data-kind', 'run');
  });

  it('paints a pending question as warning, not failure', async () => {
    renderWithMissions([
      mission({
        diffFiles: [{ filename: 'a.ts', added: 1, removed: 0 }],
        pendingQuestion: 'Overwrite a.ts?',
      }),
    ]);
    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument());
    expect(screen.getByTestId('code-file-activity-dot')).toHaveAttribute('data-kind', 'question');
    expect(screen.getByTestId('code-file-activity-cursor').textContent).toContain('Overwrite a.ts?');
  });

  it('does not invent a cursor on a file no mission touches', async () => {
    renderWithMissions([mission({ liveAction: '▊ écrit other.ts…' })]);
    await waitFor(() => expect(screen.getByText('a.ts')).toBeInTheDocument());
    expect(screen.queryByTestId('code-file-activity-dot')).toBeNull();
    expect(screen.queryByTestId('code-file-activity-cursor')).toBeNull();
  });
});
