/**
 * FleetMap.test.tsx — regression coverage for a real, observed Cockpit UI
 * bug: the Fleet Map rail popover rendered "1 missions · 0 running · 1
 * blocked" for a project with exactly one mission — no singular agreement
 * on the "missions" count. Fixed via the same pluralKey convention as the
 * Brain timeline fix (see i18nPlural.test.ts / brainTimelinePlural.test.tsx).
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { FleetMap, type FleetProject } from '../components/agents/orchestrator/FleetMap';
import type { Mission } from '../lib/agents/types';

function makeMission(id: string, status: Mission['status']): Mission {
  return { id, title: `Mission ${id}`, status } as Mission;
}

describe('FleetMap — mission-count pluralization', () => {
  it('renders the SINGULAR form for exactly one mission ("1 mission", not "1 missions")', () => {
    const projects: FleetProject[] = [
      { id: 'p1', name: 'Project One', missions: [makeMission('m1', 'queued')] },
    ];

    render(
      <I18nProvider>
        <FleetMap projects={projects} />
      </I18nProvider>,
    );

    expect(screen.getByText(/^1 mission ·/)).toBeInTheDocument();
    expect(screen.queryByText(/1 missions/)).toBeNull();
  });

  it('renders the PLURAL form for more than one mission', () => {
    const projects: FleetProject[] = [
      { id: 'p1', name: 'Project One', missions: [makeMission('m1', 'queued'), makeMission('m2', 'running')] },
    ];

    render(
      <I18nProvider>
        <FleetMap projects={projects} />
      </I18nProvider>,
    );

    expect(screen.getByText(/^2 missions ·/)).toBeInTheDocument();
  });

  it('also agrees on the running/blocked segments in the same row', () => {
    const projects: FleetProject[] = [
      {
        id: 'p1',
        name: 'Project One',
        missions: [makeMission('m1', 'running'), makeMission('m2', 'failed')],
      },
    ];

    render(
      <I18nProvider>
        <FleetMap projects={projects} />
      </I18nProvider>,
    );

    expect(screen.getByText('2 missions · 1 running · 1 blocked')).toBeInTheDocument();
  });

  it('uses design-system tokens instead of leftover Tailwind slates', () => {
    const projects: FleetProject[] = [
      { id: 'p1', name: 'Project One', missions: [makeMission('m1', 'running')] },
    ];
    render(
      <I18nProvider>
        <FleetMap projects={projects} />
      </I18nProvider>,
    );
    const row = screen.getByTestId('fleet-map-project');
    expect(row.className).not.toMatch(/bg-slate-800/);
    expect(row.style.background).toContain('--color-panel-2');
  });
});
