/**
 * KpiGroup.test.tsx — QA B16.
 *
 * The Bandeau's 5 KPI tiles were entirely non-clickable. The "crédits" tile
 * is B1's separate scope (see AccountChip.tsx/AccountPopover) — this suite
 * covers the other 4: décisions, agents, mergées, brain. Each is wired to a
 * real handler passed down from Cockpit.tsx (see its own doc comment for
 * exactly what each one does); KpiGroup itself only has to expose them as
 * real, keyboard-accessible buttons and call them on click/Enter/Space.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { KpiGroup } from '../components/agents/cockpit/KpiGroup';
import type { FleetProject } from '../lib/agents/fleetMissions';

function renderKpiGroup(overrides: Partial<React.ComponentProps<typeof KpiGroup>> = {}) {
  const projects: FleetProject[] = [];
  return render(
    <I18nProvider>
      <KpiGroup projects={projects} pendingDecisions={0} {...overrides} />
    </I18nProvider>,
  );
}

describe('KpiGroup — clickable tiles (QA B16)', () => {
  it('décisions/agents/mergées/brain tiles are real buttons when a handler is passed', () => {
    renderKpiGroup({
      onDecisionsClick: vi.fn(),
      onAgentsClick: vi.fn(),
      onMergedClick: vi.fn(),
      onBrainClick: vi.fn(),
    });
    for (const testId of ['kpi-decisions', 'kpi-agents', 'kpi-merged', 'kpi-brain']) {
      const tile = screen.getByTestId(testId);
      expect(tile).toHaveAttribute('role', 'button');
      expect(tile).toHaveAttribute('tabIndex', '0');
    }
  });

  it('clicking the décisions tile calls onDecisionsClick', () => {
    const onDecisionsClick = vi.fn();
    renderKpiGroup({ onDecisionsClick });
    fireEvent.click(screen.getByTestId('kpi-decisions'));
    expect(onDecisionsClick).toHaveBeenCalledTimes(1);
  });

  it('clicking the agents tile calls onAgentsClick', () => {
    const onAgentsClick = vi.fn();
    renderKpiGroup({ onAgentsClick });
    fireEvent.click(screen.getByTestId('kpi-agents'));
    expect(onAgentsClick).toHaveBeenCalledTimes(1);
  });

  it('clicking the mergées tile calls onMergedClick', () => {
    const onMergedClick = vi.fn();
    renderKpiGroup({ onMergedClick });
    fireEvent.click(screen.getByTestId('kpi-merged'));
    expect(onMergedClick).toHaveBeenCalledTimes(1);
  });

  it('clicking the brain tile calls onBrainClick', () => {
    const onBrainClick = vi.fn();
    renderKpiGroup({ onBrainClick });
    fireEvent.click(screen.getByTestId('kpi-brain'));
    expect(onBrainClick).toHaveBeenCalledTimes(1);
  });

  it('Enter and Space also activate a tile (keyboard-accessible, not mouse-only)', () => {
    const onBrainClick = vi.fn();
    renderKpiGroup({ onBrainClick });
    const tile = screen.getByTestId('kpi-brain');
    fireEvent.keyDown(tile, { key: 'Enter' });
    fireEvent.keyDown(tile, { key: ' ' });
    expect(onBrainClick).toHaveBeenCalledTimes(2);
  });

  it('a tile with no handler passed is not a button (no role/tabIndex, no crash on click)', () => {
    renderKpiGroup();
    const tile = screen.getByTestId('kpi-decisions');
    expect(tile).not.toHaveAttribute('role');
    expect(tile).not.toHaveAttribute('tabIndex');
    expect(() => fireEvent.click(tile)).not.toThrow();
  });

  it('the credits tile (B1 scope, unrelated to B16) never gets these testids', () => {
    renderKpiGroup();
    expect(screen.queryByTestId('kpi-credits')).not.toBeInTheDocument();
  });
});
