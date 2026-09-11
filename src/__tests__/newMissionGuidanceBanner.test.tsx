/**
 * newMissionGuidanceBanner.test.tsx
 *
 * G8 task-selection guardrail wiring: NewMissionModal calls
 * classifyMissionFit() on the live task text and shows a discreet warning
 * banner when the verdict is 'risky' or 'poor-fit' — never blocking submit.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { NewMissionModal } from '../components/agents/NewMissionModal';
import { I18nProvider } from '../i18n';

const mockAddMission = vi.fn();

vi.mock('../components/agents/agentsStore', () => ({
  useAgentsStore: () => ({ addMission: mockAddMission }),
  useAgentsStoreActions: () => ({ addMission: mockAddMission }),
  useAgentsStoreMissionsOptional: () => null,
}));

vi.mock('../app/AppContext', () => ({
  useAppContext: () => ({ projectRoot: 'C:\\proj\\demo' }),
}));

vi.mock('../lib/bus', () => ({
  emit: vi.fn(),
  on: vi.fn(() => () => {}),
}));

function renderModal() {
  render(
    <I18nProvider>
      <NewMissionModal isOpen onClose={() => {}} />
    </I18nProvider>,
  );
}

function typeTask(text: string) {
  const textarea = document.getElementById('nm-prompt') as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: text } });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('lazy.locale', 'fr');
});

describe('NewMissionModal — mission-fit guidance banner', () => {
  it('shows no banner while the task text is empty', () => {
    renderModal();
    expect(screen.queryByTestId('mission-fit-banner')).toBeNull();
  });

  it('shows no banner for a mechanical, well-scoped task (good-fit)', () => {
    renderModal();
    typeTask('Refactor class components to hooks and update the tests');
    expect(screen.queryByTestId('mission-fit-banner')).toBeNull();
  });

  it('shows the banner for an open-ended task (risky)', () => {
    renderModal();
    typeTask('Improve the codebase');
    expect(screen.getByTestId('mission-fit-banner')).toBeInTheDocument();
  });

  it('shows the banner for a high-taste UI task (poor-fit)', () => {
    renderModal();
    typeTask('Refine the landing page animation and visual polish');
    expect(screen.getByTestId('mission-fit-banner')).toBeInTheDocument();
  });
});
