/**
 * MissionDetailCheckpoints.test.tsx — UI wiring for graph/forkFromCheckpoint.ts
 * (previously no entry point at all): lists a mission's checkpoints and forks
 * a new run from one via the agents store's forkMissionFromCheckpoint.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { MissionDetailCheckpoints } from '../components/agents/MissionDetailCheckpoints';
import type { Mission } from '../lib/agents/types';

vi.mock('../i18n', () => ({
  useI18n: () => ({
    t: (key: string, vars?: Record<string, string>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    locale: 'en',
    setLocale: vi.fn(),
    LOCALES: [],
  }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({
    t: (key: string, vars?: Record<string, string>) => (vars ? `${key} ${JSON.stringify(vars)}` : key),
    locale: 'en',
    setLocale: vi.fn(),
    LOCALES: [],
  }),
}));

const toastSpy = vi.fn();
vi.mock('../components/ui', () => ({
  useToast: () => ({ toast: toastSpy }),
}));

const mockListCheckpoints = vi.fn();
vi.mock('../lib/agents/graph/checkpointStore', () => ({
  listCheckpoints: (...args: unknown[]) => mockListCheckpoints(...args),
}));

const forkMissionFromCheckpointSpy = vi.fn();
vi.mock('../components/agents/agentsStore', () => ({
  useAgentsStore: () => ({ forkMissionFromCheckpoint: forkMissionFromCheckpointSpy }),
}));

function makeMission(overrides: Partial<Mission> = {}): Mission {
  return { id: 'm1', title: 'Test mission', status: 'running', model: 'sonnet', ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MissionDetailCheckpoints', () => {
  it('renders nothing and never calls listCheckpoints when the mission has no repoRoot', async () => {
    const { container } = render(<MissionDetailCheckpoints mission={makeMission()} />);
    await Promise.resolve();
    expect(mockListCheckpoints).not.toHaveBeenCalled();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the mission has a repoRoot but no checkpoints yet', async () => {
    mockListCheckpoints.mockResolvedValue([]);
    const { container } = render(<MissionDetailCheckpoints mission={makeMission({ repoRoot: '/repo' })} />);
    await waitFor(() => expect(mockListCheckpoints).toHaveBeenCalledWith('/repo', 'm1'));
    expect(container).toBeEmptyDOMElement();
  });

  it('lists checkpoints and forks the selected one on click', async () => {
    mockListCheckpoints.mockResolvedValue([
      { id: 'cp-1', runId: 'm1', engine: 'managed', stateRef: 'cp-1.json', summary: { turn: 3, label: 'After tool: write_file' }, createdAt: 1_000_000 },
    ]);
    forkMissionFromCheckpointSpy.mockResolvedValue({ newRunId: 'run-forked', newGraphRun: {}, forkCheckpointId: 'cp-fork-1' });

    render(<MissionDetailCheckpoints mission={makeMission({ repoRoot: '/repo' })} />);

    await waitFor(() => expect(screen.getByTestId('checkpoint-row-cp-1')).toBeInTheDocument());
    expect(screen.getByText('After tool: write_file')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('fork-checkpoint-btn-cp-1'));

    await waitFor(() => expect(forkMissionFromCheckpointSpy).toHaveBeenCalledWith('m1', 'cp-1'));
    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('forkedToast'), 'success'),
    );
  });

  it('shows an error toast when the fork call rejects', async () => {
    mockListCheckpoints.mockResolvedValue([
      { id: 'cp-1', runId: 'm1', engine: 'managed', stateRef: 'cp-1.json', summary: { turn: 1 }, createdAt: 1_000_000 },
    ]);
    forkMissionFromCheckpointSpy.mockRejectedValue(new Error('checkpoint not found'));

    render(<MissionDetailCheckpoints mission={makeMission({ repoRoot: '/repo' })} />);
    await waitFor(() => expect(screen.getByTestId('fork-checkpoint-btn-cp-1')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('fork-checkpoint-btn-cp-1'));

    await waitFor(() =>
      expect(toastSpy).toHaveBeenCalledWith(expect.stringContaining('checkpoint not found'), 'error'),
    );
  });
});
