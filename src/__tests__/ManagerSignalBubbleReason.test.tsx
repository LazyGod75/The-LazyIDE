/**
 * ManagerSignalBubbleReason.test.tsx — direct, isolated unit tests for
 * components/agents/cockpit/ManagerSignalBubble.tsx's 'failed' text.
 *
 * SURFACE-THE-REASON DEFECT (real user report, live repro 2026-08-15): the
 * manager rail's fleet signal for a failed mission read only a bare
 * "M27 (LazySite-internet) a échoué." with NO reason anywhere — the user
 * could not tell whether to retry, merge (if the deliverable survived), or
 * investigate. Same precedent as commit 4464446, which surfaced merge-block
 * reasons verbatim with a remedy action instead of a bare "Bloquée" chip.
 *
 * Fixed in ManagerSignalBubble.tsx: a 'failed' signal now interpolates the
 * mission's own `statusReason` into the bubble text when one is recorded,
 * falling back to the old bare phrasing only when there truly is none.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import { ManagerSignalBubble } from '../components/agents/cockpit/ManagerSignalBubble';
import type { ManagerSignal } from '../components/agents/cockpit/managerSignals';
import type { FleetMission } from '../lib/agents/fleetMissions';

function failedMission(overrides: Partial<FleetMission> = {}): FleetMission {
  return {
    id: 'M27',
    title: 'Add enableZoom prop',
    status: 'failed',
    stage: 'code',
    model: 'sonnet',
    updatedMs: 0,
    urgent: true,
    ...overrides,
  };
}

function failedSignal(mission: FleetMission): ManagerSignal {
  return {
    id: `failed:${mission.id}`,
    kind: 'failed',
    mission,
    projectId: 'p1',
    projectName: 'LazySite-internet',
    buttons: [
      { key: 'retry', labelKey: 'cockpit.action.retry', variant: 'primary' },
      { key: 'diff', labelKey: 'cockpit.action.logs', variant: 'outline' },
    ],
  };
}

function renderBubble(signal: ManagerSignal) {
  return render(
    <I18nProvider>
      <ManagerSignalBubble signal={signal} onAnswer={() => {}} onAction={() => {}} />
    </I18nProvider>,
  );
}

describe('ManagerSignalBubble — failed signal surfaces the real reason', () => {
  beforeEach(() => {
    localStorage.setItem('lazy.locale', 'fr');
  });

  afterEach(() => {
    localStorage.removeItem('lazy.locale');
  });

  it('shows the mission statusReason verbatim when one is recorded', () => {
    const signal = failedSignal(
      failedMission({ statusReason: 'Évaluation interrompue par un redémarrage — les modifications sont conservées, prêtes à être revues ou fusionnées' }),
    );
    renderBubble(signal);

    const bubble = screen.getByTestId('manager-signal-failed:M27');
    expect(bubble.textContent).toContain('M27');
    expect(bubble.textContent).toContain('LazySite-internet');
    expect(bubble.textContent).toContain(
      'Évaluation interrompue par un redémarrage — les modifications sont conservées, prêtes à être revues ou fusionnées',
    );
  });

  it('falls back to the bare phrasing when the mission carries no statusReason', () => {
    const signal = failedSignal(failedMission({ statusReason: undefined }));
    renderBubble(signal);

    const bubble = screen.getByTestId('manager-signal-failed:M27');
    expect(bubble.textContent).toContain('a échoué');
  });

  it('falls back to the bare phrasing when statusReason is an empty/whitespace-only string', () => {
    const signal = failedSignal(failedMission({ statusReason: '   ' }));
    renderBubble(signal);

    const bubble = screen.getByTestId('manager-signal-failed:M27');
    expect(bubble.textContent).toContain('a échoué');
  });

  it('a review signal is unaffected by this fix (still the plain review text, no reason interpolation)', () => {
    const mission = failedMission({ status: 'review', statusReason: 'should not appear' });
    const signal: ManagerSignal = {
      id: `review:${mission.id}`,
      kind: 'review',
      mission,
      projectId: 'p1',
      projectName: 'LazySite-internet',
      buttons: [
        { key: 'merge', labelKey: 'cockpit.action.merge', variant: 'primary' },
        { key: 'diff', labelKey: 'cockpit.action.diff', variant: 'outline' },
      ],
    };
    renderBubble(signal);

    const bubble = screen.getByTestId('manager-signal-review:M27');
    expect(bubble.textContent).not.toContain('should not appear');
    expect(bubble.textContent).toContain('prêt pour revue');
  });
});
