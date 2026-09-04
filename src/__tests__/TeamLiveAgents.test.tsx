import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { TeamLiveAgents } from '../components/team/redesign/TeamLiveAgents';
import type { FleetMission, FleetProject } from '../lib/agents/fleetMissions';

function mission(overrides: Partial<FleetMission> = {}): FleetMission {
  return {
    id: 'm-run',
    title: 'Fix login',
    status: 'running',
    stage: 'code',
    model: 'sonnet',
    updatedMs: 100,
    urgent: false,
    agentName: 'Coder',
    liveAction: 'Write: Write {"file_path":"src/auth.ts"}',
    ...overrides,
  };
}

function project(missions: FleetMission[]): FleetProject {
  return { projectId: 'p1', root: '/tmp/p1', name: 'lazy', missions };
}

describe('TeamLiveAgents', () => {
  it('shows the honest empty state when nothing is running', () => {
    render(
      <I18nProvider>
        <TeamLiveAgents projects={[project([])]} />
      </I18nProvider>,
    );
    expect(screen.getByTestId('team-live-agents-empty')).toHaveTextContent(
      'No agent is working right now',
    );
  });

  it('renders a running agent with status + file cursor from liveAction, not JSON', () => {
    render(
      <I18nProvider>
        <TeamLiveAgents projects={[project([mission()])]} />
      </I18nProvider>,
    );
    const row = screen.getByTestId('team-live-agent-row');
    expect(row).toHaveAttribute('data-status', 'running');
    expect(screen.getByTestId('team-live-agent-status')).toHaveTextContent('Running');
    expect(screen.getByTestId('team-live-agent-cursor')).toHaveTextContent(/auth\.ts/);
    expect(screen.getByTestId('team-live-agent-cursor').textContent).not.toContain('{');
    expect(row).toHaveTextContent('Coder');
  });

  it('falls back to a real diffFiles basename when liveAction is empty (review agents)', () => {
    render(
      <I18nProvider>
        <TeamLiveAgents
          projects={[project([
            mission({
              status: 'review',
              liveAction: '',
              diffFiles: [{ filename: 'src/pricing.ts', added: 2, removed: 0 }],
            }),
          ])]}
        />
      </I18nProvider>,
    );
    expect(screen.getByTestId('team-live-agent-cursor')).toHaveTextContent(/pricing\.ts/);
  });

  it('review with a stale liveAction still shows the real file, not the leftover tool line', () => {
    render(
      <I18nProvider>
        <TeamLiveAgents
          projects={[project([
            mission({
              status: 'review',
              liveAction: 'Running reviewer sub-agent…',
              diffFiles: [{ filename: 'src/auth.ts', added: 2, removed: 0 }],
            }),
          ])]}
        />
      </I18nProvider>,
    );
    const cursor = screen.getByTestId('team-live-agent-cursor');
    expect(cursor).toHaveTextContent(/auth\.ts/);
    expect(cursor).toHaveTextContent(/In review/);
    expect(cursor.textContent).not.toContain('Running reviewer');
  });
});
