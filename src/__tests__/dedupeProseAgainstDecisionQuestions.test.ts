/**
 * dedupeProseAgainstDecisionQuestions — item 6 fix (real user QA,
 * 2026-08-01, verbatim: "a question about installer packaging appeared as
 * a summary paragraph AND again as the question body"). A
 * propose_mission_charter turn's prose can restate a charter decision's
 * `question` verbatim; MissionCharterCard then renders that SAME question
 * again via DecisionCard. This strips the duplicated paragraph from the
 * prose, leaving DecisionCard as the one interactive place it's shown.
 */
import { describe, it, expect } from 'vitest';
import { dedupeProseAgainstDecisionQuestions } from '../components/agents/agentsStore';
import type { DecisionWithRecommendation } from '../lib/agents/types';

function decision(question: string): DecisionWithRecommendation {
  return { question, options: ['A', 'B'], recommended: 'A', rationale: 'because' };
}

describe('dedupeProseAgainstDecisionQuestions', () => {
  it('strips a prose paragraph that exactly restates a decision question', () => {
    const prose = [
      'Voici mon analyse de la situation.',
      'Dois-je empaqueter en NSIS ou en MSI ?',
    ].join('\n\n');
    const result = dedupeProseAgainstDecisionQuestions(prose, [decision('Dois-je empaqueter en NSIS ou en MSI ?')]);
    expect(result).toBe('Voici mon analyse de la situation.');
  });

  it('strips a paragraph that CONTAINS a decision question (question embedded in a longer sentence)', () => {
    const prose = 'Avant de continuer : dois-je empaqueter en NSIS ou en MSI ? Ça détermine le pipeline.';
    const result = dedupeProseAgainstDecisionQuestions(prose, [decision('dois-je empaqueter en NSIS ou en MSI ?')]);
    expect(result).toBe('');
  });

  it('leaves a paragraph that only mentions the same topic without restating the question untouched', () => {
    const prose = 'Je vais réfléchir au packaging de l\'installeur.';
    const result = dedupeProseAgainstDecisionQuestions(prose, [decision('Dois-je empaqueter en NSIS ou en MSI ?')]);
    expect(result).toBe(prose);
  });

  it('is a no-op when there are no decisions at all', () => {
    const prose = 'Texte normal, rien à dédupliquer.';
    expect(dedupeProseAgainstDecisionQuestions(prose, undefined)).toBe(prose);
    expect(dedupeProseAgainstDecisionQuestions(prose, [])).toBe(prose);
  });

  it('handles multiple decisions, stripping only the paragraphs that duplicate one of them', () => {
    const prose = [
      'Résumé général du plan.',
      'Question 1 : NSIS ou MSI ?',
      'Question 2 : auto-update ou manuel ?',
      'Une note qui ne duplique rien.',
    ].join('\n\n');
    const result = dedupeProseAgainstDecisionQuestions(prose, [
      decision('Question 1 : NSIS ou MSI ?'),
      decision('Question 2 : auto-update ou manuel ?'),
    ]);
    expect(result).toBe(['Résumé général du plan.', 'Une note qui ne duplique rien.'].join('\n\n'));
  });

  it('A6 — strips a paraphrased restatement of the decision question (trigram fingerprint)', () => {
    const prose = [
      'Voici mon analyse.',
      'Est-ce que je dois empaqueter en NSIS ou bien en MSI ?',
      'Ensuite on enchaîne sur le graph.',
    ].join('\n\n');
    const result = dedupeProseAgainstDecisionQuestions(
      prose,
      [decision('Dois-je empaqueter en NSIS ou en MSI ?')],
    );
    expect(result).toBe(['Voici mon analyse.', 'Ensuite on enchaîne sur le graph.'].join('\n\n'));
  });
});
