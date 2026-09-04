/**
 * canvasGatePopover.test.tsx — fix/canvas-ux R4d, dogfood defect #1
 * (BLOQUANT): the review gate's reject-with-feedback textarea (and the
 * ask_user answer textarea) used to render INLINE inside MissionNode's card
 * body, which nodeChrome.tsx's `NodeCard` caps at a fixed `maxHeight` with
 * `overflow: hidden` — opening the form pushed the submit button past that
 * height and clipped it, unclickable at every zoom (R3 dogfood
 * screenshots d13/d14/d19).
 *
 * Proves the fix (chrome/GateFeedbackPopover.tsx, wired from
 * nodes/MissionNode.tsx): the form now renders via `createPortal` straight
 * to `document.body` — structurally OUTSIDE the card's own DOM subtree (and
 * therefore outside any `overflow: hidden`/zoom-transform ancestor a real
 * canvas viewport would apply), so its submit button can never be clipped
 * and is always hit-testable regardless of canvas zoom.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { I18nProvider } from '../i18n';
import type { FleetMission } from '../lib/agents/fleetMissions';
import type { MissionNodeData } from '../components/agents/canvas/canvasTypes';
import { MissionNodeCard } from '../components/agents/canvas/nodes/MissionNode';

const retryMissionSpy = vi.fn();
const approveMissionSpy = vi.fn().mockResolvedValue(undefined);
const interveneMissionSpy = vi.fn();
const resolveProjectRootSpy = vi.fn().mockResolvedValue('/fixtures/p1');
// MissionNode.tsx's handleGateApprove resolves the mission's OWN project
// root (bug audit wave — see agentsStore.tsx's resolveMissionRepoPath doc
// comment), not resolveProjectRoot (the ACTIVE project) — kept in the mock
// even though no test in this file clicks the approve gate button yet, so
// the mock's shape doesn't silently drift from the real module.
const resolveMissionRepoPathSpy = vi.fn().mockResolvedValue('/fixtures/p1');

vi.mock('../components/agents/agentsStore', () => ({
  useAgentsStoreOptional: () => ({
    missions: [],
    retryMission: retryMissionSpy,
    approveMission: approveMissionSpy,
    interveneMission: interveneMissionSpy,
    stopMission: vi.fn(),
  }),
  useAgentsStoreActionsOptional: () => ({
    retryMission: retryMissionSpy,
    approveMission: approveMissionSpy,
    interveneMission: interveneMissionSpy,
    stopMission: vi.fn(),
  }),
  useAgentsStoreMissionsOptional: () => [],
  resolveProjectRoot: () => resolveProjectRootSpy(),
  resolveMissionRepoPath: () => resolveMissionRepoPathSpy(),
}));

function makeMission(overrides: Partial<FleetMission> = {}): FleetMission {
  return {
    id: 'm1',
    title: 'Fix login bug',
    status: 'review',
    stage: 'review',
    model: 'sonnet-4.6',
    updatedMs: Date.now(),
    urgent: false,
    ...overrides,
  };
}

function makeMissionData(missionOverrides: Partial<FleetMission> = {}): MissionNodeData {
  return { mission: makeMission(missionOverrides), projectId: 'p1', isActiveProject: true };
}

beforeEach(() => {
  retryMissionSpy.mockClear();
  approveMissionSpy.mockClear();
  interveneMissionSpy.mockClear();
});

describe('MissionNodeCard — reject-feedback gate popover (fix/canvas-ux R4d defect #1)', () => {
  it('portals the feedback form to document.body — never a descendant of the (overflow-hidden) card', () => {
    const data = makeMissionData();
    render(
      <I18nProvider>
        <MissionNodeCard data={data} zoomLevel="full" />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId(`mission-node-gate-reject-open-${data.mission.id}`));

    const popover = screen.getByTestId('gate-feedback-popover');
    expect(popover.parentElement).toBe(document.body);
    // Never nested inside the card's own gate row (the thing that used to
    // clip it via NodeCard's `overflow: hidden`).
    const card = screen.getByTestId(`mission-node-${data.mission.id}`);
    expect(card.contains(popover)).toBe(false);
  });

  it('submit is disabled until real text is typed, then calls retryMission with the real feedback and closes', () => {
    const data = makeMissionData();
    render(
      <I18nProvider>
        <MissionNodeCard data={data} zoomLevel="full" />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId(`mission-node-gate-reject-open-${data.mission.id}`));
    const submit = screen.getByTestId(`mission-node-gate-reject-submit-${data.mission.id}`);
    expect(submit).toBeDisabled();

    const textarea = screen.getByTestId(`mission-node-gate-feedback-input-${data.mission.id}`);
    fireEvent.change(textarea, { target: { value: 'Please add error handling.' } });
    expect(submit).not.toBeDisabled();

    fireEvent.click(submit);
    expect(retryMissionSpy).toHaveBeenCalledWith('m1', { feedback: 'Please add error handling.' });
    expect(screen.queryByTestId('gate-feedback-popover')).not.toBeInTheDocument();
  });

  it('Escape cancels the popover without submitting', () => {
    const data = makeMissionData();
    render(
      <I18nProvider>
        <MissionNodeCard data={data} zoomLevel="full" />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId(`mission-node-gate-reject-open-${data.mission.id}`));
    fireEvent.change(screen.getByTestId(`mission-node-gate-feedback-input-${data.mission.id}`), {
      target: { value: 'draft feedback' },
    });
    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByTestId('gate-feedback-popover')).not.toBeInTheDocument();
    expect(retryMissionSpy).not.toHaveBeenCalled();
  });

  it('outside click cancels the popover (never a stuck overlay)', () => {
    const data = makeMissionData();
    render(
      <I18nProvider>
        <div data-testid="outside-sentinel" />
        <MissionNodeCard data={data} zoomLevel="full" />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId(`mission-node-gate-reject-open-${data.mission.id}`));
    expect(screen.getByTestId('gate-feedback-popover')).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByTestId('outside-sentinel'));
    expect(screen.queryByTestId('gate-feedback-popover')).not.toBeInTheDocument();
  });

  it('the approve/reject row itself never grows the card (no textarea inline, ever)', () => {
    const data = makeMissionData();
    render(
      <I18nProvider>
        <MissionNodeCard data={data} zoomLevel="full" />
      </I18nProvider>,
    );
    // Before AND after opening feedback, the gate row itself carries only
    // the two trigger buttons — the textarea lives exclusively in the
    // portaled popover, never inline.
    expect(screen.queryByTestId(`mission-node-gate-feedback-input-${data.mission.id}`)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId(`mission-node-gate-reject-open-${data.mission.id}`));
    const gateRow = screen.getByTestId(`mission-node-gate-${data.mission.id}`);
    expect(gateRow.querySelector('textarea')).toBeNull();
  });
});

// fix/canvas-card-declutter (owner repro, 2026-08-14 screenshot: a review
// card with a rejected verdict rendered FIVE action buttons at once — Merger,
// Diff, Promouvoir, Approuver, Rejeter avec feedback — two of which
// (Merger/Approuver) call the exact same `approveMission` primitive under
// different labels). This file already mocks a real `useAgentsStoreOptional`
// (see module header), the exact condition (`agentsStore` present) the fix
// gates on — the ideal place to lock in the de-duplicated button set.
describe('MissionNodeCard — review-gate quick-action de-duplication (fix/canvas-card-declutter)', () => {
  it('drops the redundant "merge" quick action once the dedicated approve/reject gate row is showing, but keeps diff/promote', () => {
    const rejected = makeMissionData({
      judgeVerdict: { score: 30, passed: false, risk: 'high', reviewers: [], createdAt: new Date().toISOString() },
    });
    render(
      <I18nProvider>
        <MissionNodeCard data={rejected} zoomLevel="full" />
      </I18nProvider>,
    );

    // The gate row's own approve/reject buttons are the ONE place "approve
    // this mission" lives now.
    expect(screen.getByTestId(`mission-node-gate-approve-${rejected.mission.id}`)).toBeInTheDocument();
    expect(screen.getByTestId(`mission-node-gate-reject-open-${rejected.mission.id}`)).toBeInTheDocument();
    // The quick-action row's redundant "merge" button is gone...
    expect(screen.queryByTestId(`mission-node-action-${rejected.mission.id}-merge`)).not.toBeInTheDocument();
    // ...but the quick-action row's OTHER actions (not covered by the gate
    // row) are still reachable: inspect the diff, or escalate to a stronger
    // model given the rejection.
    expect(screen.getByTestId(`mission-node-action-${rejected.mission.id}-diff`)).toBeInTheDocument();
    expect(screen.getByTestId(`mission-node-action-${rejected.mission.id}-promote`)).toBeInTheDocument();
  });

  // The mirror case — no agentsStore, so no gate row, so 'merge' must stay
  // (never silently stranding the action with nowhere else to reach it) — is
  // already covered by canvasNodes.test.tsx's own pre-existing 'merge'
  // assertions (that file mounts MissionNodeCard with no store, same as
  // every other test there), and continues to pass unchanged against this
  // fix: the de-duplication above is conditional on `agentsStore` being
  // present, exactly the condition those tests don't provide.
});

// fix/canvas-ux R6a BLOQUANT #2 — the portal fix above only ever clamped the
// LEFT edge; `top` was unconditionally `anchorRect.bottom + 6`. A gate row
// near the BOTTOM of a short viewport (real repro: 844px viewport, submit
// button rendered at y=851) pushed the popover itself below the fold.
describe('MissionNodeCard — reject-feedback popover flips/clamps to stay on-screen (fix/canvas-ux R6a BLOQUANT #2)', () => {
  const originalInnerHeight = window.innerHeight;
  const originalInnerWidth = window.innerWidth;

  afterEach(() => {
    Object.defineProperty(window, 'innerHeight', { value: originalInnerHeight, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: originalInnerWidth, configurable: true });
  });

  it('flips ABOVE the anchor when the gate row sits near the bottom of a short viewport', () => {
    Object.defineProperty(window, 'innerHeight', { value: 844, configurable: true });
    Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });

    const data = makeMissionData();
    render(
      <I18nProvider>
        <MissionNodeCard data={data} zoomLevel="full" />
      </I18nProvider>,
    );

    const gateRow = screen.getByTestId(`mission-node-gate-${data.mission.id}`);
    // jsdom has no real layout engine — getBoundingClientRect is stubbed
    // (canvasTestEnv.ts's own header notes the same limitation elsewhere),
    // so the anchor rect itself is mocked directly, matching the real
    // repro's own numbers (an anchor row bottom near the viewport bottom).
    vi.spyOn(gateRow, 'getBoundingClientRect').mockReturnValue({
      top: 820, bottom: 838, left: 300, right: 560, width: 260, height: 18, x: 300, y: 820, toJSON: () => ({}),
    });
    // The popover's OWN measured height (post-mount) — enough that
    // "below" would push it past the 844px viewport bottom.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(120);
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(260);

    fireEvent.click(screen.getByTestId(`mission-node-gate-reject-open-${data.mission.id}`));
    const popover = screen.getByTestId('gate-feedback-popover');
    const top = parseFloat(popover.style.top);
    const left = parseFloat(popover.style.left);

    // Flipped above the anchor (top < anchor's own top), and fully on-screen.
    expect(top).toBeLessThan(820);
    expect(top).toBeGreaterThanOrEqual(0);
    expect(top + 120).toBeLessThanOrEqual(844);
    expect(left + 260).toBeLessThanOrEqual(1440);

    vi.restoreAllMocks();
  });
});

describe('MissionNodeCard — ask_user answer popover (same fix, defect #1 sibling)', () => {
  function makePendingQuestionData(): MissionNodeData {
    return makeMissionData({ status: 'running', stage: 'code', pendingQuestion: 'write server/auth.rs ?' });
  }

  it('portals the answer form to document.body and submits through interveneMission', () => {
    const data = makePendingQuestionData();
    render(
      <I18nProvider>
        <MissionNodeCard data={data} zoomLevel="full" />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByTestId(`mission-node-answer-open-${data.mission.id}`));
    const popover = screen.getByTestId('gate-feedback-popover');
    expect(popover.parentElement).toBe(document.body);

    fireEvent.change(screen.getByTestId(`mission-node-answer-input-${data.mission.id}`), {
      target: { value: 'Yes, go ahead.' },
    });
    fireEvent.click(screen.getByTestId(`mission-node-answer-submit-${data.mission.id}`));
    expect(interveneMissionSpy).toHaveBeenCalledWith('m1', 'Yes, go ahead.');
  });
});
