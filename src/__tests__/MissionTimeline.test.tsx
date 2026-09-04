/**
 * MissionTimeline.test.tsx
 *
 * Verifies the Gantt view builds rows/bars/day-headers from REAL missions
 * (no hardcoded M1..M7 fixture rows, no hardcoded "Lun 16" day headers, no
 * hardcoded dependency arrows) and shows an honest empty state when there
 * are no missions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { MissionTimeline } from '../components/agents/MissionTimeline';
import type { Mission } from '../lib/agents/types';

vi.mock('../i18n', () => ({
  useI18n: () => ({
    t: (key: string) => key,
    locale: 'en',
    setLocale: vi.fn(),
    LOCALES: [],
  }),
  // Spinner (components/ui/Skeleton.tsx) uses useI18nOptional, not useI18n.
  useI18nOptional: () => ({
    t: (key: string) => key,
    locale: 'en',
    setLocale: vi.fn(),
    LOCALES: [],
  }),
}));

const FIXED_NOW = new Date(2026, 5, 17, 12, 0, 0); // Jun 17 2026, local time

function baseMission(overrides: Partial<Mission> = {}): Mission {
  return {
    id: 'm-1',
    title: 'Untitled mission',
    status: 'running',
    model: 'sonnet',
    ...overrides,
  };
}

function compiledPlanAt(date: Date) {
  return {
    graph: { stages: [], entryStageId: '', completionStageId: '' },
    createdAt: date.toISOString(),
    brainAdapted: false,
    adaptations: [],
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('MissionTimeline — empty state', () => {
  it('shows the honest empty state instead of an empty fake Gantt when there are no missions', () => {
    render(<MissionTimeline missions={[]} onMissionClick={vi.fn()} />);
    expect(screen.getByTestId('agents-timeline')).toBeInTheDocument();
    expect(screen.getByText('agents.board.emptyTitle')).toBeInTheDocument();
  });
});

describe('MissionTimeline — real rows', () => {
  it('renders a row for a real mission using its own id/title, not hardcoded M1..M7', () => {
    const mission = baseMission({
      id: 'real-42',
      title: 'Add rate limiting',
      compiledPlan: compiledPlanAt(FIXED_NOW),
    });
    render(<MissionTimeline missions={[mission]} onMissionClick={vi.fn()} />);
    expect(screen.getByText('real-42 · Add rate limiting')).toBeInTheDocument();
    expect(screen.queryByText(/^M7 ·/)).not.toBeInTheDocument();
    expect(screen.queryByText(/^M3 ·/)).not.toBeInTheDocument();
  });

  it('does not draw a bar for a mission with no real timing signal yet', () => {
    const mission = baseMission({ id: 'queued-1', title: 'Not started yet', status: 'queued' });
    render(<MissionTimeline missions={[mission]} onMissionClick={vi.fn()} />);
    expect(screen.getByText('queued-1 · Not started yet')).toBeInTheDocument();
    expect(screen.queryByTestId('gantt-bar-queued-1')).not.toBeInTheDocument();
  });

  it('draws a positioned bar for a mission with a real start time and real duration', () => {
    const mission = baseMission({
      id: 'done-1',
      title: 'Finished mission',
      status: 'done',
      compiledPlan: compiledPlanAt(FIXED_NOW),
      agentMetrics: { durationMs: 60_000, inputTokens: 100, outputTokens: 50, costUsd: 0.02, toolCount: 3 },
    });
    render(<MissionTimeline missions={[mission]} onMissionClick={vi.fn()} />);
    const bar = screen.getByTestId('gantt-bar-done-1');
    expect(bar).toBeInTheDocument();
    expect(bar.style.left).toMatch(/%$/);
    expect(bar.style.width).toMatch(/%$/);
  });

  it('extends a running mission bar up to "now" rather than a fixed width', () => {
    const mission = baseMission({
      id: 'running-1',
      title: 'In flight',
      status: 'running',
      compiledPlan: compiledPlanAt(FIXED_NOW),
    });
    render(<MissionTimeline missions={[mission]} onMissionClick={vi.fn()} />);
    expect(screen.getByTestId('gantt-bar-running-1')).toBeInTheDocument();
  });
});

describe('MissionTimeline — real dependency arrows', () => {
  it('draws no dependency arrows when no real mission declares dependsOn', () => {
    const missions = [
      baseMission({ id: 'a', title: 'A', compiledPlan: compiledPlanAt(FIXED_NOW) }),
      baseMission({ id: 'b', title: 'B', compiledPlan: compiledPlanAt(FIXED_NOW) }),
    ];
    const { container } = render(<MissionTimeline missions={missions} onMissionClick={vi.fn()} />);
    // Scope to direct children of <svg> — the arrowhead <marker> definition
    // also contains a <path>, nested under <defs>, which would otherwise
    // be miscounted as a dependency arrow.
    expect(container.querySelectorAll('svg > path')).toHaveLength(0);
  });

  it('draws a real dependency arrow derived from Mission.dependsOn', () => {
    const missions = [
      baseMission({ id: 'base', title: 'Base mission', compiledPlan: compiledPlanAt(FIXED_NOW) }),
      baseMission({
        id: 'dependent',
        title: 'Depends on base',
        compiledPlan: compiledPlanAt(FIXED_NOW),
        dependsOn: ['base'],
      }),
    ];
    const { container } = render(<MissionTimeline missions={missions} onMissionClick={vi.fn()} />);
    // Scope to direct children of <svg> — the arrowhead <marker> definition
    // also contains a <path>, nested under <defs>, which would otherwise
    // be miscounted as a dependency arrow.
    expect(container.querySelectorAll('svg > path')).toHaveLength(1);
  });
});
