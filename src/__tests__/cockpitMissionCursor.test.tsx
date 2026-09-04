import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { CompactMissionCard } from '../components/agents/cockpit/CompactMissionCard';
import { UrgentMissionCard } from '../components/agents/cockpit/UrgentMissionCard';
import type { FleetMission } from '../lib/agents/fleetMissions';

function mission(overrides: Partial<FleetMission> = {}): FleetMission {
  return {
    id: 'm-run',
    title: 'Fix login',
    status: 'running',
    stage: 'code',
    model: 'sonnet',
    updatedMs: Date.now(),
    urgent: false,
    agentName: 'Coder',
    liveAction: 'Write: Write {"file_path":"src/auth.ts","content":"x"}',
    ...overrides,
  };
}

describe('CompactMissionCard cursor', () => {
  it('names the agent and the file, never raw JSON', () => {
    render(
      <I18nProvider>
        <CompactMissionCard mission={mission()} onOpen={() => {}} />
      </I18nProvider>,
    );
    const cursor = screen.getByTestId('compact-mission-cursor');
    expect(cursor).toHaveTextContent('Coder · writes auth.ts');
    expect(cursor.textContent).not.toContain('{');
  });
});

describe('UrgentMissionCard cursor', () => {
  it('keeps a blocked question as a question, prefixed by who', () => {
    render(
      <I18nProvider>
        <UrgentMissionCard
          mission={mission({ pendingQuestion: 'Overwrite auth.rs?' })}
          kind="permission"
          rank={1}
          onOpen={() => {}}
          actions={[]}
          onAction={() => {}}
        />
      </I18nProvider>,
    );
    const cursor = screen.getByTestId('urgent-mission-cursor');
    expect(cursor).toHaveTextContent('Coder · Overwrite auth.rs?');
    expect(cursor.textContent).not.toContain('{');
  });
});
