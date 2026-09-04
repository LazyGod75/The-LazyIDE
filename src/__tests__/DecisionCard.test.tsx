/**
 * DecisionCard — tests for recommendation visibility, rationale always
 * shown, and answering as a click.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { I18nProvider } from '../i18n';
import { DecisionCard } from '../components/lazyManager/DecisionCard';
import type { DecisionWithRecommendation } from '../components/lazyManager/missionCharter';

function makeDecision(overrides: Partial<DecisionWithRecommendation> = {}): DecisionWithRecommendation {
  return {
    question: 'What cadence should we use?',
    options: ['1/hour', '3-5/day'],
    recommended: '3-5/day',
    rationale: '1/hour hits the platform rate ceiling and reads as automation.',
    ...overrides,
  };
}

function renderDecision(decision: DecisionWithRecommendation, index = 0) {
  const onAnswer = vi.fn();
  render(
    <I18nProvider>
      <DecisionCard decision={decision} index={index} onAnswer={onAnswer} />
    </I18nProvider>,
  );
  return onAnswer;
}

/** Same as `renderDecision`, but exposes `rerender` and lets the caller
 *  control `onAnswer`/`isQueued` — needed by the queue-aware tests below,
 *  which simulate a real parent re-render with an updated `isQueued` prop. */
function renderDecisionWithQueue(
  decision: DecisionWithRecommendation,
  overrides: Partial<React.ComponentProps<typeof DecisionCard>> = {},
) {
  const onAnswer = overrides.onAnswer ?? vi.fn();
  const utils = render(
    <I18nProvider>
      <DecisionCard decision={decision} index={0} onAnswer={onAnswer} {...overrides} />
    </I18nProvider>,
  );
  return { onAnswer, rerender: utils.rerender };
}

describe('DecisionCard', () => {
  it('renders question, rationale (always visible), and options', () => {
    renderDecision(makeDecision());
    expect(screen.getByText('What cadence should we use?')).toBeInTheDocument();
    expect(screen.getByTestId('decision-rationale-0')).toHaveTextContent(/rate ceiling/);
    expect(screen.getByTestId('decision-option-0-0')).toBeInTheDocument();
    expect(screen.getByTestId('decision-option-0-1')).toBeInTheDocument();
  });

  it('marks the recommended option', () => {
    renderDecision(makeDecision());
    const recommended = screen.getByTestId('decision-option-0-1');
    expect(recommended).toHaveAttribute('data-recommended');
    const notRecommended = screen.getByTestId('decision-option-0-0');
    expect(notRecommended).not.toHaveAttribute('data-recommended');
  });

  it('answers the manager as if the option had been typed, on click', () => {
    const onAnswer = renderDecision(makeDecision());
    fireEvent.click(screen.getByTestId('decision-option-0-0'));
    expect(onAnswer).toHaveBeenCalledWith('1/hour', 0);
  });

  it('shows the resolved choice and disables further clicks', () => {
    renderDecision(makeDecision());
    fireEvent.click(screen.getByTestId('decision-option-0-0'));
    expect(screen.getByTestId('decision-resolved-0')).toHaveTextContent('1/hour');
    expect(screen.getByTestId('decision-option-0-1')).toBeDisabled();
  });

  it('forwards the decision index so a multi-decision charter can tell them apart', () => {
    const onAnswer = renderDecision(makeDecision(), 2);
    fireEvent.click(screen.getByTestId('decision-option-2-0'));
    expect(onAnswer).toHaveBeenCalledWith('1/hour', 2);
  });

  // Free-text escape hatch (real founder feedback: "j'ai que 3 choix,
  // j'aimerais bien avoir une quatrieme option ou j'ecris ce que je veux").
  describe('free-text escape hatch', () => {
    it('always renders the "other" entry last, one past the real options', () => {
      renderDecision(makeDecision());
      // makeDecision() has 2 options (indices 0,1) — the free-text trigger
      // must sit at index 2, after both.
      expect(screen.getByTestId('decision-option-0-2')).toBeInTheDocument();
      expect(screen.getByTestId('decision-option-0-2')).toHaveTextContent(/Autre|Other/i);
    });

    it('opens a focused input on click and forwards the typed sentence unchanged, exactly like a normal option', () => {
      const onAnswer = renderDecision(makeDecision());
      fireEvent.click(screen.getByTestId('decision-option-0-2'));
      const input = screen.getByTestId('decision-freetext-input-0') as HTMLInputElement;
      expect(input).toHaveFocus();
      fireEvent.change(input, { target: { value: '2 par semaine, jamais le week-end' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onAnswer).toHaveBeenCalledWith('2 par semaine, jamais le week-end', 0);
    });

    it('submitting via the visible submit button forwards the same free sentence', () => {
      const onAnswer = renderDecision(makeDecision());
      fireEvent.click(screen.getByTestId('decision-option-0-2'));
      const input = screen.getByTestId('decision-freetext-input-0');
      fireEvent.change(input, { target: { value: 'never on weekends' } });
      fireEvent.click(screen.getByTestId('decision-freetext-submit-0'));
      expect(onAnswer).toHaveBeenCalledWith('never on weekends', 0);
    });

    it('Escape cancels free-text entry and returns to the option list untouched', () => {
      const onAnswer = renderDecision(makeDecision());
      fireEvent.click(screen.getByTestId('decision-option-0-2'));
      const input = screen.getByTestId('decision-freetext-input-0');
      fireEvent.change(input, { target: { value: 'partial draft' } });
      fireEvent.keyDown(input, { key: 'Escape' });
      expect(screen.queryByTestId('decision-freetext-input-0')).not.toBeInTheDocument();
      expect(screen.getByTestId('decision-option-0-0')).not.toBeDisabled();
      expect(screen.getByTestId('decision-option-0-2')).toBeInTheDocument();
      expect(onAnswer).not.toHaveBeenCalled();
    });

    it('shows the free-text answer as the resolved choice, same testid/treatment as a preset option', () => {
      renderDecision(makeDecision());
      fireEvent.click(screen.getByTestId('decision-option-0-2'));
      fireEvent.change(screen.getByTestId('decision-freetext-input-0'), {
        target: { value: '2 par semaine, jamais le week-end' },
      });
      fireEvent.keyDown(screen.getByTestId('decision-freetext-input-0'), { key: 'Enter' });
      expect(screen.getByTestId('decision-resolved-0')).toHaveTextContent('2 par semaine, jamais le week-end');
      // Back to the (now disabled) option list — the free-text input is gone.
      expect(screen.queryByTestId('decision-freetext-input-0')).not.toBeInTheDocument();
      expect(screen.getByTestId('decision-option-0-0')).toBeDisabled();
    });

    it('ignores an empty submission and stays in free-text mode', () => {
      const onAnswer = renderDecision(makeDecision());
      fireEvent.click(screen.getByTestId('decision-option-0-2'));
      fireEvent.keyDown(screen.getByTestId('decision-freetext-input-0'), { key: 'Enter' });
      expect(onAnswer).not.toHaveBeenCalled();
      expect(screen.getByTestId('decision-freetext-input-0')).toBeInTheDocument();
    });
  });

  // NEVER DEGRADE IN SILENCE (useManagerActionQueue.ts) — same bug-class fix
  // as MissionCharterCard.test.tsx's own "queue-aware resolution" describe
  // block: answering while the manager is busy is QUEUED, not sent — this
  // card must show that explicitly (never a false "Chosen: X"), and must
  // stay actionable if the answer could not be taken in charge at all.
  describe('queue-aware resolution (bug fix: false "Chosen" while merely queued)', () => {
    it('shows an explicit "Queued: <option>" line — not "Chosen" — when the answer returns \'queued\'', () => {
      const onAnswer = vi.fn().mockReturnValue('queued');
      renderDecisionWithQueue(makeDecision(), { onAnswer, isQueued: true });

      fireEvent.click(screen.getByTestId('decision-option-0-0'));

      expect(onAnswer).toHaveBeenCalledWith('1/hour', 0);
      expect(screen.getByTestId('decision-resolved-0')).toHaveTextContent('Queued: 1/hour');
      // Taken in charge (queued) — options still hide, same as immediate.
      expect(screen.getByTestId('decision-option-0-1')).toBeDisabled();
    });

    it('promotes "Queued" to "Chosen" on its own the instant the queue actually flushes', () => {
      const onAnswer = vi.fn().mockReturnValue('queued');
      const { rerender } = renderDecisionWithQueue(makeDecision(), { onAnswer, isQueued: true });

      fireEvent.click(screen.getByTestId('decision-option-0-0'));
      expect(screen.getByTestId('decision-resolved-0')).toHaveTextContent('Queued: 1/hour');

      rerender(
        <I18nProvider>
          <DecisionCard decision={makeDecision()} index={0} onAnswer={onAnswer} isQueued={false} />
        </I18nProvider>,
      );

      expect(screen.getByTestId('decision-resolved-0')).toHaveTextContent('Chosen: 1/hour');
      expect(onAnswer).toHaveBeenCalledTimes(1); // promotion is not a re-send
    });

    it('stays fully actionable when the answer returns \'idle\' (could not be taken in charge)', () => {
      const onAnswer = vi.fn().mockReturnValue('idle');
      renderDecisionWithQueue(makeDecision(), { onAnswer });

      fireEvent.click(screen.getByTestId('decision-option-0-0'));

      expect(screen.queryByTestId('decision-resolved-0')).not.toBeInTheDocument();
      expect(screen.getByTestId('decision-option-0-0')).not.toBeDisabled();
      expect(screen.getByTestId('decision-option-0-1')).not.toBeDisabled();
    });
  });
});
