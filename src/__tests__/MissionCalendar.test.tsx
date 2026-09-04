/**
 * MissionCalendar.test.tsx
 *
 * Verifies the calendar renders REAL missions on a REAL week (no hardcoded
 * "Mon 16 .. Sun 22" fixture week, no isToday pinned to a fixed date, no
 * dependency on the mock-only `calendarDate` field) and shows an honest
 * empty state when there are no missions.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { MissionCalendar } from '../components/agents/MissionCalendar';
import type { Mission } from '../lib/agents/types';

// i18n mock — returns the translation key itself so assertions are
// locale-agnostic, and pins `locale` so Intl weekday formatting is
// deterministic (English short weekday names).
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

// Local-time constructor (year, monthIndex, day, hour) avoids any UTC/local
// timezone ambiguity when asserting on date-of-month numbers later.
const FIXED_NOW = new Date(2026, 5, 17, 12, 0, 0); // Jun 17 2026, 12:00 local

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

describe('MissionCalendar — empty state', () => {
  it('shows the honest empty state instead of an empty fake week when there are no missions', () => {
    render(<MissionCalendar missions={[]} onMissionClick={vi.fn()} />);
    expect(screen.getByTestId('agents-calendar')).toBeInTheDocument();
    expect(screen.getByText('agents.board.emptyTitle')).toBeInTheDocument();
    expect(screen.getByText('agents.board.emptySubtitle')).toBeInTheDocument();
  });
});

describe('MissionCalendar — real "today"', () => {
  it('marks the real current date as today (not a hardcoded date)', () => {
    render(<MissionCalendar missions={[baseMission()]} onMissionClick={vi.fn()} />);
    expect(screen.getByText(String(FIXED_NOW.getDate()))).toBeInTheDocument();
    expect(screen.getByText('home.today')).toBeInTheDocument();
  });

  it('renders localized weekday labels via Intl, not hardcoded French day names', () => {
    render(<MissionCalendar missions={[baseMission()]} onMissionClick={vi.fn()} />);
    // locale is mocked to 'en' — a real Mon..Sun week always contains a Monday.
    expect(screen.getByText('Mon')).toBeInTheDocument();
  });
});

describe('MissionCalendar — real mission placement', () => {
  it('shows a mission with no real timestamp under today (honest fallback, not dropped)', () => {
    render(
      <MissionCalendar
        missions={[baseMission({ id: 'queued-1', title: 'Freshly queued mission' })]}
        onMissionClick={vi.fn()}
      />,
    );
    expect(screen.getByText('Freshly queued mission')).toBeInTheDocument();
    expect(screen.getByText('queued-1')).toBeInTheDocument();
  });

  it('places a mission on the day derived from its real compiledPlan.createdAt', () => {
    const mission = baseMission({
      id: 'real-7',
      title: 'Compiled mission',
      compiledPlan: compiledPlanAt(FIXED_NOW),
    });
    render(<MissionCalendar missions={[mission]} onMissionClick={vi.fn()} />);
    expect(screen.getByText('Compiled mission')).toBeInTheDocument();
    expect(screen.getByText('real-7')).toBeInTheDocument();
  });

  it('does not show a mission whose real timestamp falls outside the displayed week', () => {
    const longAgo = new Date(FIXED_NOW);
    longAgo.setDate(longAgo.getDate() - 30);
    const mission = baseMission({
      id: 'old-1',
      title: 'Very old mission',
      compiledPlan: compiledPlanAt(longAgo),
    });
    render(<MissionCalendar missions={[mission]} onMissionClick={vi.fn()} />);
    expect(screen.queryByText('Very old mission')).not.toBeInTheDocument();
  });

  it('never renders the old hardcoded mock mission ids (M1..M7)', () => {
    render(
      <MissionCalendar
        missions={[baseMission({ id: 'real-only', title: 'Only real mission' })]}
        onMissionClick={vi.fn()}
      />,
    );
    expect(screen.queryByText('M1')).not.toBeInTheDocument();
    expect(screen.queryByText('M7')).not.toBeInTheDocument();
  });
});
