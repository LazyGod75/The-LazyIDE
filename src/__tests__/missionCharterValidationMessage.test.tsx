/**
 * formatCharterValidationMessage — decisions recap.
 *
 * Real repro this covers: the manager emits a charter with decisions, the
 * user answers each one (a preset option click sends its own EARLIER turn,
 * see DecisionCard.tsx), then clicks "Valider" — the Validate message used
 * to carry only objective/nature/gates, with NO trace of which decisions
 * had already been answered. The manager then re-proposed a fresh charter
 * re-asking the very same question right after validation. This message
 * must now restate every decision and its exact answer (including a
 * free-text one), and explicitly flag any decision left unanswered instead
 * of silently omitting it.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import { I18nProvider, useI18n } from '../i18n';
import { formatCharterValidationMessage } from '../components/lazyManager/missionCharter';
import type { MissionCharter } from '../components/lazyManager/missionCharter';

function makeCharter(): MissionCharter {
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
      {
        question: 'Visual identity source?',
        options: ['Existing logo', 'Generate new'],
        recommended: 'Existing logo',
        rationale: 'Reusing the existing logo keeps brand consistency.',
      },
    ],
    validationGates: { frozenOnce: [], superviseFirstN: undefined },
    learning: { measure: 'engagement rate', measureSource: 'platform analytics', influences: 'topics, timing', killSwitch: 'metric drops 3 runs in a row' },
  };
}

function Harness({ answered, testid }: { answered: Record<number, string>; testid: string }) {
  const { t } = useI18n();
  return <div data-testid={testid}>{formatCharterValidationMessage(makeCharter(), answered, t)}</div>;
}

function renderMessage(answered: Record<number, string>) {
  render(
    <I18nProvider>
      <Harness testid="validation-message" answered={answered} />
    </I18nProvider>,
  );
  return screen.getByTestId('validation-message').textContent ?? '';
}

describe('formatCharterValidationMessage', () => {
  it('restates both answered decisions verbatim, including a free-text answer', () => {
    const text = renderMessage({
      0: 'Browser automation',
      1: "Use the founder's own photos, never a generated logo",
    });
    expect(text).toContain('Publishing path?');
    expect(text).toContain('Browser automation');
    expect(text).toContain('Visual identity source?');
    expect(text).toContain("Use the founder's own photos, never a generated logo");
  });

  it('flags a decision with no recorded answer explicitly instead of omitting it', () => {
    const text = renderMessage({ 0: 'Browser automation' });
    expect(text).toContain('Publishing path?');
    expect(text).toContain('Browser automation');
    // The second decision was never answered — it must still be NAMED, not dropped.
    expect(text).toContain('Visual identity source?');
    expect(text.toLowerCase()).toMatch(/not answered|non répondue|no respondida|noch nicht|尚未回答|未回答/);
  });

  it('still carries objective/nature/gates when there are no decisions at all', () => {
    function NoDecisions() {
      const { t } = useI18n();
      const charter: MissionCharter = { ...makeCharter(), decisions: [] };
      return <div data-testid="msg">{formatCharterValidationMessage(charter, {}, t)}</div>;
    }
    render(
      <I18nProvider>
        <NoDecisions />
      </I18nProvider>,
    );
    const text = screen.getByTestId('msg').textContent ?? '';
    expect(text).toContain('Grow the audience on a social surface');
  });
});
