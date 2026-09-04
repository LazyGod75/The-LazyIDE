/**
 * LiveMissionPanel.test.tsx — R7 (living surfaces). Every value this panel
 * renders is a real accessor (see the component's own header) — these tests
 * pin down the two edges that matter: (1) the honest degradation when
 * `fullMission` isn't resolvable (no fabricated plan/timeline content), and
 * (2) the real behavior when it IS available (last-12 timeline tail, plan
 * steps, diff stat, quick actions).
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import type { FleetMission } from '../lib/agents/fleetMissions';
import type { ActionEvent, Mission } from '../lib/agents/types';
import { LiveMissionPanel } from '../components/agents/canvas/nodes/LiveMissionPanel';

// jsdom does not implement scrollIntoView (same stub as
// MissionDetailTranscript.test.tsx/MessageList.test.tsx) — the panel
// auto-scrolls its timeline tail to the newest entry.
beforeAll(() => {
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

function makeFleetMission(overrides: Partial<FleetMission> = {}): FleetMission {
  return {
    id: 'm1',
    title: 'payment-flow-stripe',
    status: 'running',
    stage: 'code',
    model: 'sonnet 4.6',
    updatedMs: Date.now(),
    urgent: false,
    ...overrides,
  };
}

function timelineEvent(i: number): ActionEvent {
  return { time: `12:0${i % 10}`, text: `step ${i}` };
}

function renderPanel(mission: FleetMission, fullMission?: Mission, onAdjustPlan?: (text: string) => void) {
  const onOpen = vi.fn();
  const onCollapse = vi.fn();
  render(
    <I18nProvider>
      <LiveMissionPanel
        mission={mission}
        fullMission={fullMission}
        width={520}
        height={420}
        quickActions={[{ key: 'merge', label: 'Merger', onSelect: vi.fn() }]}
        onOpen={onOpen}
        onCollapse={onCollapse}
        onAdjustPlan={onAdjustPlan}
      />
    </I18nProvider>,
  );
  return { onOpen, onCollapse };
}

describe('LiveMissionPanel — honest degradation (no fullMission resolvable)', () => {
  it('renders the honest "no plan/timeline" fallbacks instead of fabricating content', () => {
    renderPanel(makeFleetMission());

    expect(screen.getByTestId('live-mission-panel-plan-empty')).toBeInTheDocument();
    expect(screen.getByTestId('live-mission-panel-timeline-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('live-mission-panel-timeline-m1')).not.toBeInTheDocument();
  });

  it('still shows real FleetMission-level facts (live line, diff stat) — these never need fullMission', () => {
    renderPanel(makeFleetMission({ liveAction: '▊ écrit PaymentSheet.tsx…', diffAdded: 164, diffRemoved: 38 }));

    expect(screen.getByTestId('live-mission-panel-live-line')).toHaveTextContent('écrit PaymentSheet.tsx');
    expect(screen.getByTestId('live-mission-panel-diff-stat')).toHaveTextContent('+164');
    expect(screen.getByTestId('live-mission-panel-diff-stat')).toHaveTextContent('38');
  });
});

describe('LiveMissionPanel — with a resolvable fullMission (active-project mission)', () => {
  it('shows the last 12 timeline entries only (spec: "auto-scrolling last ~12 entries")', () => {
    const actionTimeline: ActionEvent[] = Array.from({ length: 20 }, (_, i) => timelineEvent(i));
    const fullMission = { id: 'm1', title: 'x', status: 'running', model: 'sonnet', actionTimeline } as Mission;

    renderPanel(makeFleetMission(), fullMission);

    const container = screen.getByTestId('live-mission-panel-timeline-m1');
    expect(container).toHaveTextContent('step 19');
    expect(container).not.toHaveTextContent('step 7'); // entries 0-7 are outside the last-12 tail
  });

  it('renders real plan steps via the shared MissionDetailPlan component', () => {
    const fullMission = {
      id: 'm1',
      title: 'x',
      status: 'running',
      model: 'sonnet',
      planSteps: [{ label: 'Écrire les tests', state: 'in_progress' }],
    } as Mission;

    renderPanel(makeFleetMission(), fullMission);

    expect(screen.queryByTestId('live-mission-panel-plan-empty')).not.toBeInTheDocument();
    expect(screen.getByText('Écrire les tests')).toBeInTheDocument();
  });
});

describe('LiveMissionPanel — header controls', () => {
  it('open/collapse buttons call their callbacks', () => {
    const { onOpen, onCollapse } = renderPanel(makeFleetMission());

    fireEvent.click(screen.getByTestId('live-mission-panel-open-m1'));
    fireEvent.click(screen.getByTestId('live-mission-panel-collapse-m1'));

    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onCollapse).toHaveBeenCalledTimes(1);
  });

  it('renders the passed-in quick actions and fires their onSelect', () => {
    const onSelect = vi.fn();
    render(
      <I18nProvider>
        <LiveMissionPanel
          mission={makeFleetMission()}
          width={520}
          height={420}
          quickActions={[{ key: 'merge', label: 'Merger', onSelect }]}
          onOpen={vi.fn()}
          onCollapse={vi.fn()}
        />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId('live-mission-panel-action-m1-merge'));
    expect(onSelect).toHaveBeenCalledTimes(1);
  });
});

// W-CLOSE row 5 (canvas scorecard "LangGraph interrupt-and-patch" gap,
// honest v1: edit the paused mission's REMAINING PLAN, then resume via the
// existing intervene primitive — MissionNode.tsx's own wiring composes
// interveneMission + resumeMission; this suite only proves the PANEL's own
// affordance and its callback contract).
describe('LiveMissionPanel — « Ajuster » plan-patch affordance (W-CLOSE row 5)', () => {
  it('is absent when the mission is not paused, even if onAdjustPlan is supplied', () => {
    renderPanel(makeFleetMission({ paused: false }), undefined, vi.fn());
    expect(screen.queryByTestId('live-mission-panel-adjust-plan-m1')).not.toBeInTheDocument();
  });

  it('is absent on a paused mission when no onAdjustPlan handler is supplied', () => {
    renderPanel(makeFleetMission({ paused: true }));
    expect(screen.queryByTestId('live-mission-panel-adjust-plan-m1')).not.toBeInTheDocument();
  });

  it('opens a textarea pre-filled with the current plan steps, and calls onAdjustPlan with the edited text on Reprendre', () => {
    const onAdjustPlan = vi.fn();
    const fullMission = {
      id: 'm1',
      title: 'x',
      status: 'running',
      model: 'sonnet',
      planSteps: [
        { label: 'Écrire les tests', state: 'done' },
        { label: 'Implémenter', state: 'in_progress' },
      ],
    } as Mission;
    renderPanel(makeFleetMission({ paused: true }), fullMission, onAdjustPlan);

    fireEvent.click(screen.getByTestId('live-mission-panel-adjust-plan-m1'));
    const textarea = screen.getByTestId('live-mission-panel-adjust-plan-textarea-m1') as HTMLTextAreaElement;
    expect(textarea.value).toBe('Écrire les tests\nImplémenter');

    fireEvent.change(textarea, { target: { value: 'Écrire les tests\nImplémenter autrement\nAjouter un test de régression' } });
    fireEvent.click(screen.getByTestId('live-mission-panel-adjust-plan-resume-m1'));

    expect(onAdjustPlan).toHaveBeenCalledTimes(1);
    expect(onAdjustPlan).toHaveBeenCalledWith('Écrire les tests\nImplémenter autrement\nAjouter un test de régression');
  });

  it('Annuler discards the edit without calling onAdjustPlan', () => {
    const onAdjustPlan = vi.fn();
    renderPanel(makeFleetMission({ paused: true }), undefined, onAdjustPlan);

    fireEvent.click(screen.getByTestId('live-mission-panel-adjust-plan-m1'));
    fireEvent.click(screen.getByTestId('live-mission-panel-adjust-plan-cancel-m1'));

    expect(onAdjustPlan).not.toHaveBeenCalled();
    expect(screen.getByTestId('live-mission-panel-adjust-plan-m1')).toBeInTheDocument(); // affordance reappears
  });
});
