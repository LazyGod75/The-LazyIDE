/**
 * newMissionAutoMergeGate.test.tsx
 *
 * Root-cause regression for the "review missions never resolve despite
 * 'Merge : auto si vert'" defect (2026-08-02 zone audit).
 *
 * NewMissionModal.buildContract() used to hardcode `gates.humanApprove:
 * true` on EVERY mission it creates (no UI toggle) — see its own removed
 * comment: "no UI toggle for gates in this modal yet, so the contract
 * simply records the current default behavior rather than changing it".
 *
 * approveGate.ts's evaluateAutoMerge treats `contract.gates.humanApprove
 * === true` as a per-mission opt-out that ALWAYS wins over the project's
 * own approval mode (auto_green/full_auto) — by design, see its own doc
 * comment ("the mission's own explicit per-mission opt-out always wins").
 * That rule is correct; the bug is that every mission created through the
 * normal "New Mission" flow silently opted itself out, with no user
 * action and no visible indication, making a project's "auto si vert"
 * policy permanently inert for any mission launched this way.
 *
 * Same harness/mocks as newMissionDuration.test.tsx (same render helper,
 * same fr locale fixture, same fillTitleAndSubmit convention).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { NewMissionModal } from '../components/agents/NewMissionModal';
import { I18nProvider } from '../i18n';
import { fr } from '../i18n/locales/fr';
import { getEngineReadiness } from '../lib/models/entitlement';
import { evaluateAutoMerge, type AutoMergeMission } from '../components/agents/approveGate';
import type { JudgeVerdict, MissionContract } from '../lib/agents/types';

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

function greenVerdict(): JudgeVerdict {
  return {
    score: 95,
    passed: true,
    risk: 'low',
    reviewers: [
      { role: 'tester', verdict: 'approve', summary: '' },
      { role: 'reviewer', verdict: 'approve', summary: '' },
      { role: 'security', verdict: 'approve', summary: '' },
    ],
    createdAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  localStorage.setItem('lazy.locale', 'fr');
  mockedReadiness.mockReturnValue({ mode: 'cli', ready: true });
});

describe('NewMissionModal — default contract must not defeat the project auto-merge mode', () => {
  it('submits gates.humanApprove: false by default (no UI toggle exists to set it any other way)', () => {
    renderModal();
    fillTitleAndSubmit();

    expect(mockAddMission).toHaveBeenCalledTimes(1);
    const contract = mockAddMission.mock.calls[0][0].contract as MissionContract;
    expect(contract.gates.humanApprove).toBe(false);
  });

  it('a mission created with the modal default contract IS auto-merge eligible in a project set to auto_green, once its verdict comes back green', () => {
    renderModal();
    fillTitleAndSubmit();

    const contract = mockAddMission.mock.calls[0][0].contract as MissionContract;
    // "Résultats des tests" is checked by default in the modal, so the
    // contract requires a 'test_run' proof — satisfied here the same way a
    // real run would (runtime.ts's parseProofBlocks / managedAgent.ts's
    // attach_proof tool), so this test isolates the humanApprove floor
    // rather than accidentally re-testing the (separate, correct)
    // proof-of-work gate.
    const reviewMission: AutoMergeMission = {
      status: 'review',
      judgeVerdict: greenVerdict(),
      contract,
      proofs: [{ kind: 'test_run', command: 'npm test', exitCode: 0, outputPath: 'out.log' }],
    };

    const decision = evaluateAutoMerge(reviewMission, 'auto_green');
    expect(decision.eligible).toBe(true);
  });
});
