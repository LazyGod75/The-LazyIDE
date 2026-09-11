/**
 * newMissionDuration.test.tsx
 *
 * W-GUARD UI — the "Durée max" select in NewMissionModal (mirrors the
 * budget cap field's presentation/state pattern). Same harness as
 * newMissionPreflight.test.tsx (same render helper, same fr locale fixture,
 * same fillTitleAndSubmit convention).
 *
 * Covers:
 *   - default ('unlimited') submits a contract with NO maxDurationMs key
 *     (absent, not undefined-but-present — no behavior change).
 *   - selecting an option writes the matching maxDurationMs (ms) onto the
 *     contract at submit time.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { NewMissionModal } from '../components/agents/NewMissionModal';
import { I18nProvider } from '../i18n';
import { fr } from '../i18n/locales/fr';
import { getEngineReadiness } from '../lib/models/entitlement';

const mockAddMission = vi.fn();

vi.mock('../lib/models/entitlement', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/models/entitlement')>();
  return { ...actual, getEngineReadiness: vi.fn() };
});

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

const mockedReadiness = vi.mocked(getEngineReadiness);

function renderModal(onClose = vi.fn()) {
  render(
    <I18nProvider>
      <NewMissionModal isOpen onClose={onClose} />
    </I18nProvider>,
  );
  return onClose;
}

function fillTitleAndSubmit(title = 'Ma mission de test') {
  const input = document.getElementById('nm-title') as HTMLInputElement;
  fireEvent.change(input, { target: { value: title } });
  fireEvent.click(screen.getByText(fr['agents.modal.submit']));
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('lazy.locale', 'fr');
  mockedReadiness.mockReturnValue({ mode: 'cli', ready: true });
});

describe('NewMissionModal — duration cap select (W-GUARD UI)', () => {
  it('renders all 6 options, defaulting to "unlimited"', () => {
    renderModal();

    const select = document.getElementById('nm-duration-cap') as HTMLSelectElement;
    expect(select.value).toBe('unlimited');
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      'unlimited', '15m', '30m', '1h', '2h', '4h',
    ]);
  });

  it('default submit writes NO maxDurationMs key onto the contract', () => {
    renderModal();

    fillTitleAndSubmit('Mission duree par defaut');

    expect(mockAddMission).toHaveBeenCalledTimes(1);
    const contract = mockAddMission.mock.calls[0][0].contract;
    expect('maxDurationMs' in contract).toBe(false);
  });

  it('selecting "30 min" writes maxDurationMs = 1_800_000 onto the contract', () => {
    renderModal();

    fireEvent.change(document.getElementById('nm-duration-cap') as HTMLSelectElement, {
      target: { value: '30m' },
    });
    fillTitleAndSubmit('Mission duree 30 min');

    expect(mockAddMission).toHaveBeenCalledTimes(1);
    const contract = mockAddMission.mock.calls[0][0].contract;
    expect(contract.maxDurationMs).toBe(30 * 60_000);
  });

  it('selecting "4 h" writes maxDurationMs = 14_400_000 onto the contract', () => {
    renderModal();

    fireEvent.change(document.getElementById('nm-duration-cap') as HTMLSelectElement, {
      target: { value: '4h' },
    });
    fillTitleAndSubmit('Mission duree 4h');

    expect(mockAddMission).toHaveBeenCalledTimes(1);
    const contract = mockAddMission.mock.calls[0][0].contract;
    expect(contract.maxDurationMs).toBe(4 * 60 * 60_000);
  });
});
