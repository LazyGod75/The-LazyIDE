/**
 * missionBoardScroll.test.tsx
 *
 * Cockpit fix: a Kanban column with many missions (7+, e.g. "EN REVUE")
 * must stay reachable via an internal scrollbar instead of being clipped
 * by the board's overflowY:hidden root. Regression coverage for the fix in
 * MissionBoard.tsx — columns stretch to the board's full height
 * (alignItems: 'stretch') and each column's card list is a
 * flex:1 / minHeight:0 / overflowY:auto scroll region bounded by that
 * height, instead of growing unbounded and being cut off.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { MissionBoard } from '../components/agents/MissionBoard';
import { I18nProvider } from '../i18n';
import type { Mission } from '../lib/agents/types';

function makeReviewMissions(count: number): Mission[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `m-review-${i}`,
    title: `Review mission ${i}`,
    status: 'review' as const,
    model: 'Sonnet 4.6',
  }));
}

function renderBoard(missions: Mission[]) {
  return render(
    <I18nProvider>
      <MissionBoard missions={missions} onMissionClick={() => {}} />
    </I18nProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('lazy.locale', 'en');
});

describe('MissionBoard — column scroll affordance', () => {
  it('renders every mission in a heavily-populated column, not just the first few', () => {
    renderBoard(makeReviewMissions(15));

    for (let i = 0; i < 15; i++) {
      expect(screen.getByText(`Review mission ${i}`)).toBeInTheDocument();
    }
  });

  it("gives each column's card list its own bounded scroll region (overflow-y:auto inside a flex:1/min-height:0 box)", () => {
    renderBoard(makeReviewMissions(15));

    const cardsList = screen.getByTestId('mission-column-cards-review');
    const style = cardsList.getAttribute('style') ?? '';
    expect(style).toMatch(/overflow-y:\s*auto/i);
    expect(style).toMatch(/flex:\s*1/);
    expect(style).toMatch(/min-height:\s*0/i);
  });

  it('keeps the board horizontally scrollable across columns', () => {
    renderBoard(makeReviewMissions(3));

    const board = screen.getByTestId('agents-board');
    const style = board.getAttribute('style') ?? '';
    expect(style).toMatch(/overflow-x:\s*auto/i);
    // Columns stretch to the board height so their card lists can bound
    // their own scroll, instead of the old flex-start (content-height) layout.
    expect(style).toMatch(/align-items:\s*stretch/i);
  });

  it('per-column empty placeholder is localized, not hardcoded French', () => {
    renderBoard([{ id: 'm1', title: 'Only one', status: 'running', model: 'Sonnet 4.6' }]);

    // The 'queued'/'done'/'failed'/'cancelled' columns have zero missions and
    // must show the localized (en) placeholder, never a raw "Aucune mission".
    expect(screen.queryByText('Aucune mission')).not.toBeInTheDocument();
    expect(screen.getAllByText('No missions').length).toBeGreaterThan(0);
  });

  it('board-wide empty state still renders when there are zero missions at all', () => {
    renderBoard([]);

    expect(screen.getByText('No active mission')).toBeInTheDocument();
  });
});
