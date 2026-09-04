import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { CodeLiveFiles } from '../components/editor/codespace/CodeLiveFiles';
import type { FleetMission, FleetProject } from '../lib/agents/fleetMissions';

function mission(overrides: Partial<FleetMission> = {}): FleetMission {
  return {
    id: 'm1',
    title: 'Review docs',
    status: 'review',
    stage: 'code',
    model: 'sonnet',
    updatedMs: Date.now(),
    urgent: false,
    agentName: 'Judge',
    ...overrides,
  };
}

function project(missions: FleetMission[]): FleetProject {
  return { projectId: 'p1', root: '/tmp/docs', name: 'Lazy-Docs', missions };
}

describe('CodeLiveFiles', () => {
  it('renders nothing when the fleet has no per-file activity', () => {
    const { container } = render(
      <I18nProvider>
        <CodeLiveFiles fleetProjects={[project([])]} onFileOpen={vi.fn()} />
      </I18nProvider>,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('lists a review file and opens it on click', () => {
    const onFileOpen = vi.fn();
    render(
      <I18nProvider>
        <CodeLiveFiles
          fleetProjects={[project([
            mission({ diffFiles: [{ filename: 'commands-git.mdx', added: 1, removed: 0 }] }),
          ])]}
          onFileOpen={onFileOpen}
        />
      </I18nProvider>,
    );
    expect(screen.getByTestId('code-live-files')).toBeInTheDocument();
    expect(screen.getByTestId('code-live-file-row')).toHaveAttribute('data-kind', 'review');
    expect(screen.getByTestId('code-live-file-row')).toHaveTextContent('commands-git.mdx');
    expect(screen.getByTestId('code-live-file-cursor').textContent).toMatch(/Lazy-Docs/);
    fireEvent.click(screen.getByTestId('code-live-file-row'));
    expect(onFileOpen).toHaveBeenCalledWith(
      expect.stringMatching(/commands-git\.mdx$/),
      'commands-git.mdx',
    );
  });
});
