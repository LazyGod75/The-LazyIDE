/**
 * MissionCharterCard — tests for the five-block charter rendering, local
 * block edits, and global validate/modify/reject.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { MissionCharterCard } from '../components/lazyManager/MissionCharterCard';
import type { CharterProposal, MissionCharter } from '../components/lazyManager/missionCharter';
import * as bus from '../lib/bus';

function makeCharter(overrides: Partial<MissionCharter> = {}): MissionCharter {
  return {
    objective: 'Grow the audience on a social surface',
    nature: { kind: 'recurring', cadence: '3-5 per day' },
    decisions: [
      {
        question: 'Publishing path?',
        options: ['Official API', 'Browser automation'],
        recommended: 'Official API',
        rationale: 'The API is stable; the browser path risks account flags.',
      },
    ],
    validationGates: {
      frozenOnce: ['template', 'tone'],
      superviseFirstN: 3,
    },
    learning: {
      measure: 'engagement rate',
      measureSource: 'platform analytics export',
      influences: 'topics, formats, schedule',
      killSwitch: 'metric drops 3 runs in a row',
    },
    ...overrides,
  };
}

function makeProposal(charter: MissionCharter, state: CharterProposal['state'] = 'pending'): CharterProposal {
  return { state, charterId: 'charter-1', charter };
}

function renderCard(proposal: CharterProposal, overrides: Partial<React.ComponentProps<typeof MissionCharterCard>> = {}) {
  const onAnswerDecision = vi.fn();
  const onValidate = vi.fn();
  const onReject = vi.fn();
  const utils = render(
    <I18nProvider>
      <MissionCharterCard
        charterProposal={proposal}
        onAnswerDecision={onAnswerDecision}
        onValidate={onValidate}
        onReject={onReject}
        {...overrides}
      />
    </I18nProvider>,
  );
  return { onAnswerDecision, onValidate, onReject, rerender: utils.rerender };
}

describe('MissionCharterCard', () => {
  it('renders all five blocks', () => {
    renderCard(makeProposal(makeCharter()));
    expect(screen.getByTestId('mission-charter-card')).toBeInTheDocument();
    expect(screen.getByTestId('mission-charter-block-objective')).toBeInTheDocument();
    expect(screen.getByTestId('mission-charter-block-nature')).toBeInTheDocument();
    expect(screen.getByTestId('mission-charter-block-decisions')).toBeInTheDocument();
    expect(screen.getByTestId('mission-charter-block-gates')).toBeInTheDocument();
    expect(screen.getByTestId('mission-charter-block-learning')).toBeInTheDocument();
    expect(screen.getByText(/Grow the audience/)).toBeInTheDocument();
  });

  it('shows the recurring cadence input pre-filled', () => {
    renderCard(makeProposal(makeCharter()));
    const cadenceInput = screen.getByTestId('mission-charter-cadence-input') as HTMLInputElement;
    expect(cadenceInput.value).toBe('3-5 per day');
  });

  it('switches nature kind directly in the card', () => {
    renderCard(makeProposal(makeCharter()));
    fireEvent.click(screen.getByTestId('mission-charter-nature-unique'));
    expect(screen.queryByTestId('mission-charter-cadence-input')).not.toBeInTheDocument();
  });

  it('disables the supervised-first-N gate directly in the card', () => {
    renderCard(makeProposal(makeCharter()));
    const toggle = screen.getByTestId('mission-charter-gate-supervised-toggle') as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    expect((screen.getByTestId('mission-charter-gate-supervised-count') as HTMLInputElement).disabled).toBe(true);
  });

  it('edits the objective inline', () => {
    renderCard(makeProposal(makeCharter()));
    fireEvent.click(screen.getByTestId('mission-charter-edit-objective'));
    const input = screen.getByTestId('mission-charter-objective-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'New objective text' } });
    fireEvent.blur(input);
    expect(screen.getByText('New objective text')).toBeInTheDocument();
  });

  it('answers a decision embedded in the charter', () => {
    const { onAnswerDecision } = renderCard(makeProposal(makeCharter()));
    fireEvent.click(screen.getByTestId('decision-option-0-0'));
    expect(onAnswerDecision).toHaveBeenCalledWith('Official API', 0);
  });

  // Real repro (2026-07-28): the manager re-asked an already-answered
  // decision right after Validate, because the Validate message never
  // restated which decisions had been answered. onValidate's second
  // argument is the fix's foundation — see missionCharterValidationMessage.
  // test.tsx for the actual message-text assertions.
  it('passes every answered decision (by index, exact text) to onValidate on Validate — including a free-text answer', () => {
    const charter = makeCharter({
      decisions: [
        {
          question: 'Publishing path?',
          options: ['Official API', 'Browser automation'],
          recommended: 'Official API',
          rationale: 'The API is stable; the browser path risks account flags.',
        },
        {
          question: 'Visual identity source?',
          options: ['Existing logo', 'Generate new'],
          recommended: 'Existing logo',
          rationale: 'Reusing the existing logo keeps brand consistency.',
        },
      ],
    });
    const { onValidate } = renderCard(makeProposal(charter));

    // Decision 0: answered via a preset option click.
    fireEvent.click(screen.getByTestId('decision-option-0-1'));
    // Decision 1: answered via the free-text escape hatch (2 options -> its
    // trigger sits at index 2).
    fireEvent.click(screen.getByTestId('decision-option-1-2'));
    fireEvent.change(screen.getByTestId('decision-freetext-input-1'), {
      target: { value: "Use the founder's own photos, never a generated logo" },
    });
    fireEvent.keyDown(screen.getByTestId('decision-freetext-input-1'), { key: 'Enter' });

    fireEvent.click(screen.getByTestId('mission-charter-validate'));

    expect(onValidate).toHaveBeenCalledTimes(1);
    const [, answeredDecisions] = onValidate.mock.calls[0] as [MissionCharter, Record<number, string>];
    expect(answeredDecisions).toEqual({
      0: 'Browser automation',
      1: "Use the founder's own photos, never a generated logo",
    });
  });

  it('omits an unclicked decision from answeredDecisions rather than fabricating an answer', () => {
    const { onValidate } = renderCard(makeProposal(makeCharter()));
    fireEvent.click(screen.getByTestId('mission-charter-validate'));
    const [, answeredDecisions] = onValidate.mock.calls[0] as [MissionCharter, Record<number, string>];
    expect(answeredDecisions).toEqual({});
  });

  it('calls onValidate with the edited charter on Validate', () => {
    const { onValidate } = renderCard(makeProposal(makeCharter()));
    fireEvent.click(screen.getByTestId('mission-charter-nature-permanent'));
    fireEvent.click(screen.getByTestId('mission-charter-validate'));
    expect(onValidate).toHaveBeenCalledTimes(1);
    const sent = onValidate.mock.calls[0][0] as MissionCharter;
    expect(sent.nature.kind).toBe('permanent');
  });

  it('clears frozenOnce items when the gate is disabled before validating', () => {
    const { onValidate } = renderCard(makeProposal(makeCharter()));
    fireEvent.click(screen.getByTestId('mission-charter-gate-frozen-toggle'));
    fireEvent.click(screen.getByTestId('mission-charter-validate'));
    const sent = onValidate.mock.calls[0][0] as MissionCharter;
    expect(sent.validationGates.frozenOnce).toEqual([]);
  });

  it('calls onReject when reject is clicked', () => {
    const { onReject } = renderCard(makeProposal(makeCharter()));
    fireEvent.click(screen.getByTestId('mission-charter-reject'));
    expect(onReject).toHaveBeenCalledOnce();
  });

  it('hides global action buttons once accepted', () => {
    renderCard(makeProposal(makeCharter(), 'accepted'));
    expect(screen.queryByTestId('mission-charter-validate')).not.toBeInTheDocument();
    expect(screen.queryByTestId('mission-charter-reject')).not.toBeInTheDocument();
  });

  it('renders without a decisions block when there are none', () => {
    renderCard(makeProposal(makeCharter({ decisions: [] })));
    expect(screen.queryByTestId('mission-charter-block-decisions')).not.toBeInTheDocument();
  });

  // Real repro (2026-07-28, founder test session): after clicking Validate,
  // the card kept reading "EN ATTENTE DE VALIDATION" and could be validated
  // again in a loop — the `charterProposal` PROP never flips (no dedicated
  // store method exists yet, see missionCharter.ts's INTEGRATION GAP doc
  // comment), so the card must resolve itself locally instead of trusting
  // the prop to ever change.
  describe('local optimistic resolution (bug fix: stuck-pending loop)', () => {
    it('leaves pending state and hides the action buttons immediately on Validate, even though the prop itself never changes', () => {
      renderCard(makeProposal(makeCharter())); // prop stays 'pending' throughout, deliberately
      expect(screen.getByTestId('mission-charter-state')).toHaveTextContent('Pending validation');

      fireEvent.click(screen.getByTestId('mission-charter-validate'));

      expect(screen.getByTestId('mission-charter-state')).toHaveTextContent('Accepted');
      expect(screen.queryByTestId('mission-charter-validate')).not.toBeInTheDocument();
      expect(screen.queryByTestId('mission-charter-reject')).not.toBeInTheDocument();
      expect(screen.queryByTestId('mission-charter-modify')).not.toBeInTheDocument();
    });

    it('does not call onValidate a second time — a re-render with the same still-pending prop does not re-arm the card', () => {
      const { onValidate } = renderCard(makeProposal(makeCharter()));
      fireEvent.click(screen.getByTestId('mission-charter-validate'));
      expect(onValidate).toHaveBeenCalledTimes(1);
      // The validate button is gone — there is nothing left to click again,
      // proving the card cannot be validated in a loop.
      expect(screen.queryByTestId('mission-charter-validate')).not.toBeInTheDocument();
    });

    it('leaves pending state and hides the action buttons immediately on Reject too', () => {
      const { onReject } = renderCard(makeProposal(makeCharter()));
      fireEvent.click(screen.getByTestId('mission-charter-reject'));

      expect(onReject).toHaveBeenCalledOnce();
      expect(screen.getByTestId('mission-charter-state')).toHaveTextContent('Rejected');
      expect(screen.queryByTestId('mission-charter-reject')).not.toBeInTheDocument();
      expect(screen.queryByTestId('mission-charter-validate')).not.toBeInTheDocument();
    });
  });

  // NEVER DEGRADE IN SILENCE (real user test, 2026-07-28 — see
  // useManagerActionQueue.ts's own doc comment for the full repro): the fix
  // above (local optimistic resolution) was itself the bug once Validate/
  // Reject started going through the action queue — a click made while the
  // manager was busy got QUEUED (not sent), yet the card jumped straight to
  // "Accepted" anyway. These tests cover the corrected contract: the card
  // must show an explicit "queued" state — never a false final result —
  // until the queued send actually goes out, and must stay fully actionable
  // if the click could not be taken in charge at all.
  describe('queue-aware resolution (bug fix: false "Accepted" while merely queued)', () => {
    it('shows an explicit "Queued" state — not "Accepted" — when Validate returns \'queued\'', () => {
      const onValidate = vi.fn().mockReturnValue('queued');
      renderCard(makeProposal(makeCharter()), { onValidate, isActionQueued: true });

      fireEvent.click(screen.getByTestId('mission-charter-validate'));

      expect(onValidate).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('mission-charter-state')).toHaveTextContent('Queued');
      expect(screen.getByTestId('mission-charter-state')).not.toHaveTextContent('Accepted');
      // Taken in charge (queued) — buttons still hide, same as the immediate
      // path, so a second click can never fire.
      expect(screen.queryByTestId('mission-charter-validate')).not.toBeInTheDocument();
    });

    it('promotes "Queued" to "Accepted" on its own the instant the queue actually flushes — no further user action', () => {
      const onValidate = vi.fn().mockReturnValue('queued');
      const { rerender } = renderCard(makeProposal(makeCharter()), { onValidate, isActionQueued: true });

      fireEvent.click(screen.getByTestId('mission-charter-validate'));
      expect(screen.getByTestId('mission-charter-state')).toHaveTextContent('Queued');

      // The manager frees up and the queued send actually goes out —
      // LazyManagerMessageList.tsx recomputes `isActionQueued` from the
      // real queue on every render; simulate that here.
      rerender(
        <I18nProvider>
          <MissionCharterCard
            charterProposal={makeProposal(makeCharter())}
            onAnswerDecision={vi.fn()}
            onValidate={onValidate}
            onReject={vi.fn()}
            isActionQueued={false}
          />
        </I18nProvider>,
      );

      expect(screen.getByTestId('mission-charter-state')).toHaveTextContent('Accepted');
      expect(onValidate).toHaveBeenCalledTimes(1); // still only the one click — promotion is NOT a re-send
    });

    it('stays fully actionable when Validate returns \'idle\' (could not be taken in charge)', () => {
      const onValidate = vi.fn().mockReturnValue('idle');
      renderCard(makeProposal(makeCharter()), { onValidate });

      fireEvent.click(screen.getByTestId('mission-charter-validate'));

      expect(screen.getByTestId('mission-charter-state')).toHaveTextContent('Pending validation');
      expect(screen.getByTestId('mission-charter-validate')).toBeInTheDocument();
    });

    it('shows a "Queued" decision line (not "Chosen") when answering a decision returns \'queued\'', () => {
      const onAnswerDecision = vi.fn().mockReturnValue('queued');
      renderCard(makeProposal(makeCharter()), { onAnswerDecision, isDecisionQueued: () => true });

      fireEvent.click(screen.getByTestId('decision-option-0-0'));

      expect(screen.getByTestId('decision-resolved-0')).toHaveTextContent('Queued');
      expect(screen.getByTestId('decision-resolved-0')).not.toHaveTextContent('Chosen');
    });
  });

  // NEVER DEGRADE IN SILENCE, round 2 (real user test, 2026-07-28 — see
  // useManagerActionQueue.ts's own doc comment for the full repro): the
  // queue-aware fix above closed the "queued -> false Accepted" gap, but
  // introduced its own: once the queue drains, it used to promote straight
  // to "Accepted" on the mere fact of draining, without confirming the send
  // actually reached the manager. These tests cover the real-result
  // counterpart: the card must NEVER settle on "Accepted"/"Rejected" when
  // the confirmed real result says the send was refused — it must revert to
  // fully actionable and say why.
  describe('real-result failure (bug fix, round 2: false "Accepted" on mere drain)', () => {
    it('never settles on "Accepted" when the queued Validate is confirmed refused — reverts to Pending and explains why', () => {
      const onValidate = vi.fn().mockReturnValue('queued');
      const { rerender } = renderCard(makeProposal(makeCharter()), { onValidate, isActionQueued: true });

      fireEvent.click(screen.getByTestId('mission-charter-validate'));
      expect(screen.getByTestId('mission-charter-state')).toHaveTextContent('Queued');

      // The queue drains, but the real result says the send was refused —
      // isActionQueued flips false AND isActionFailed flips true (never the
      // "isActionQueued false alone means resolved" assumption).
      rerender(
        <I18nProvider>
          <MissionCharterCard
            charterProposal={makeProposal(makeCharter())}
            onAnswerDecision={vi.fn()}
            onValidate={onValidate}
            onReject={vi.fn()}
            isActionQueued={false}
            isActionFailed={true}
          />
        </I18nProvider>,
      );

      expect(screen.getByTestId('mission-charter-state')).not.toHaveTextContent('Accepted');
      expect(screen.getByTestId('mission-charter-state')).toHaveTextContent('Pending validation');
      // The user must SEE why — buttons re-armed, an explicit error shown.
      expect(screen.getByTestId('mission-charter-validate')).toBeInTheDocument();
      expect(screen.getByTestId('mission-charter-send-error')).toBeInTheDocument();
    });

    it('clears the error and re-arms silently-fresh once a retry is attempted (isActionFailed drops back to false)', () => {
      const onValidate = vi.fn().mockReturnValue('sent');
      const { rerender } = renderCard(makeProposal(makeCharter()), { onValidate, isActionFailed: true });

      expect(screen.getByTestId('mission-charter-send-error')).toBeInTheDocument();

      fireEvent.click(screen.getByTestId('mission-charter-validate'));
      rerender(
        <I18nProvider>
          <MissionCharterCard
            charterProposal={makeProposal(makeCharter())}
            onAnswerDecision={vi.fn()}
            onValidate={onValidate}
            onReject={vi.fn()}
            isActionFailed={false}
          />
        </I18nProvider>,
      );

      expect(screen.queryByTestId('mission-charter-send-error')).not.toBeInTheDocument();
      expect(screen.getByTestId('mission-charter-state')).toHaveTextContent('Accepted');
    });

    it('reverts a decision from "Chosen" back to unanswered when isDecisionFailed confirms the answer was refused', () => {
      const onAnswerDecision = vi.fn().mockReturnValue('queued');
      const { rerender } = renderCard(makeProposal(makeCharter()), {
        onAnswerDecision,
        isDecisionQueued: () => true,
      });

      fireEvent.click(screen.getByTestId('decision-option-0-0'));
      expect(screen.getByTestId('decision-resolved-0')).toHaveTextContent('Queued');

      rerender(
        <I18nProvider>
          <MissionCharterCard
            charterProposal={makeProposal(makeCharter())}
            onAnswerDecision={onAnswerDecision}
            onValidate={vi.fn()}
            onReject={vi.fn()}
            isDecisionQueued={() => false}
            isDecisionFailed={() => true}
          />
        </I18nProvider>,
      );

      expect(screen.queryByTestId('decision-resolved-0')).not.toBeInTheDocument();
      expect(screen.getByTestId('decision-send-error-0')).toBeInTheDocument();
      // Re-armed: the option buttons are clickable again.
      expect(screen.getByTestId('decision-option-0-0')).not.toBeDisabled();
    });
  });

  // 2026-08 fifth verification pass (GraphProposalCard.tsx's own
  // `hasEmittedOnceRef` doc comment — auto-expand investigation) — same
  // stale-mount risk as GraphProposalCard: a charter card mounting FRESH
  // already resolved (e.g. a multi-conversation switch revealing older
  // history) must not fire a spurious 'manager:shrinkOverlay' that could
  // race and win over a genuinely pending proposal elsewhere in the same
  // render pass.
  describe('overlay expand/shrink (auto-expand investigation)', () => {
    it('does NOT emit manager:shrinkOverlay when a card mounts FRESH already resolved (stale historical remount, not a live transition)', () => {
      const emitSpy = vi.spyOn(bus, 'emit');
      renderCard(makeProposal(makeCharter(), 'accepted'));
      expect(emitSpy).not.toHaveBeenCalledWith('manager:shrinkOverlay', undefined);
    });

    it('emits manager:expandOverlay on mount when pending (unaffected by the stale-mount guard)', () => {
      const emitSpy = vi.spyOn(bus, 'emit');
      renderCard(makeProposal(makeCharter(), 'pending'));
      expect(emitSpy).toHaveBeenCalledWith('manager:expandOverlay', undefined);
    });

    it('emits manager:shrinkOverlay when an ALREADY-MOUNTED card resolves (real transition, not a stale mount)', () => {
      const emitSpy = vi.spyOn(bus, 'emit');
      const charter = makeCharter();
      const { rerender } = renderCard(makeProposal(charter, 'pending'));
      emitSpy.mockClear();
      rerender(
        <I18nProvider>
          <MissionCharterCard
            charterProposal={makeProposal(charter, 'accepted')}
            onAnswerDecision={vi.fn()}
            onValidate={vi.fn()}
            onReject={vi.fn()}
          />
        </I18nProvider>,
      );
      expect(emitSpy).toHaveBeenCalledWith('manager:shrinkOverlay', undefined);
    });
  });
});
