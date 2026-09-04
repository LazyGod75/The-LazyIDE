/**
 * missionCardReason.test.tsx
 *
 * v0.1.5 W2.5 — queue and failure reasons visible on mission cards.
 * FailedCard must show Mission.statusReason prominently; QueuedCard shows
 * statusReason when present, and otherwise a soft "slow start" hint once the
 * mission has been sitting in the queue for more than 30 seconds (computed
 * at render, refreshed by a light 15s tick — no store writes).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React from 'react';
import { MissionCard } from '../components/agents/MissionCard';
import { I18nProvider } from '../i18n';
import { fr } from '../i18n/locales/fr';
import type { Mission } from '../lib/agents/types';

function makeMission(overrides: Partial<Mission>): Mission {
  return {
    id: 'm-test-1',
    title: 'Mission de test',
    status: 'queued',
    model: 'claude-sonnet-5',
    ...overrides,
  };
}

function renderCard(mission: Mission) {
  return render(
    <I18nProvider>
      <MissionCard mission={mission} onClick={() => {}} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('lazy.locale', 'fr');
});

describe('FailedCard — status reason', () => {
  it('shows statusReason prominently when present', () => {
    renderCard(
      makeMission({
        status: 'failed',
        statusReason: 'La mission a échoué : [plan-compile] boom kaput',
      }),
    );

    expect(screen.getByText('La mission a échoué : [plan-compile] boom kaput')).toBeInTheDocument();
  });

  it('renders without a reason exactly as before (no empty reason row)', () => {
    renderCard(makeMission({ status: 'failed' }));

    expect(screen.getByText(fr['agents.card.failed'])).toBeInTheDocument();
    expect(screen.queryByTestId('mission-status-reason')).not.toBeInTheDocument();
  });
});

// UI surfacing (Continuation Doctrine reversal, 2026-08-02, real M9/M10
// incident — see agentsStore.tsx's retryMission doc comment): the worktree
// chip already shown on running/review cards is the cheap, existing spot to
// make "which base branch did this worktree start from" visible instead of
// invisible — a native tooltip on the SAME chip, no new visible element.
describe('RunningCard/ReviewCard — worktree chip surfaces baseBranch as a tooltip', () => {
  it('running mission with a baseBranch shows it as the worktree chip\'s tooltip', () => {
    renderCard(
      makeMission({
        status: 'running',
        worktree: 'agent/M9-harden-auth',
        baseBranch: 'agent/M6-integrer-le-scaffold-existant-',
      }),
    );

    const chip = screen.getByText('agent/M9-harden-auth');
    expect(chip).toHaveAttribute(
      'title',
      fr['agents.card.startedFrom'].replace('{branch}', 'agent/M6-integrer-le-scaffold-existant-'),
    );
  });

  it('running mission with no baseBranch shows the worktree chip with no tooltip (no regression)', () => {
    renderCard(makeMission({ status: 'running', worktree: 'agent/M9-harden-auth' }));

    const chip = screen.getByText('agent/M9-harden-auth');
    expect(chip).not.toHaveAttribute('title');
  });
});

describe('QueuedCard — status reason and slow-start hint', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows statusReason when present', () => {
    renderCard(makeMission({ status: 'queued', statusReason: 'File en pause' }));

    expect(screen.getByText('File en pause')).toBeInTheDocument();
  });

  it('fresh mission (just created) shows no slow-start hint', () => {
    renderCard(makeMission({ status: 'queued', createdAt: Date.now() }));

    expect(screen.queryByText(fr['agents.card.slowStartHint'])).not.toBeInTheDocument();
  });

  it('mission queued for more than 30s shows the slow-start hint', () => {
    renderCard(makeMission({ status: 'queued', createdAt: Date.now() - 60_000 }));

    expect(screen.getByText(fr['agents.card.slowStartHint'])).toBeInTheDocument();
  });

  it('hint appears via the light re-render tick without any store write', () => {
    vi.useFakeTimers();
    renderCard(makeMission({ status: 'queued', createdAt: Date.now() }));

    expect(screen.queryByText(fr['agents.card.slowStartHint'])).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(45_000);
    });

    expect(screen.getByText(fr['agents.card.slowStartHint'])).toBeInTheDocument();
  });
});
