import { describe, it, expect } from 'vitest';
import { compilePlan } from '../lib/agents/stageContract';

const mission = {
  id: 'M-adapt',
  title: 'Ship auth',
  agentTask: 'Ship auth',
  agentName: 'coder',
  isOrchestrator: false,
  model: 'sonnet',
};

describe('compilePlan — structured brain adaptations (not word sniffing)', () => {
  it('does not add extra_security just because a snippet mentions "auth"', () => {
    const plan = compilePlan({
      mission,
      brainRecall: {
        nodes: [{ id: 'n1', title: 'Login form copy', snippet: 'auth button label', score: 1 }],
        tokensSaved: 0,
        injectedContext: '',
      },
    });
    expect(plan.adaptations.some((a) => a.kind === 'extra_security')).toBe(false);
    expect(plan.adaptations.some((a) => a.kind === 'brain_context')).toBe(true);
  });

  it('adds extra_security for a tagged security note', () => {
    const plan = compilePlan({
      mission,
      brainRecall: {
        nodes: [{
          id: 'n2',
          title: '[security] XSS in markdown',
          snippet: 'data-cerveau-type="security"',
          score: 1,
          cluster: 'code/security',
        }],
        tokensSaved: 0,
        injectedContext: '',
      },
    });
    expect(plan.adaptations.some((a) => a.kind === 'extra_security')).toBe(true);
  });

  it('adds reinforced_testing for a [test] learning title, not a random "test failed" sentence', () => {
    const sniffed = compilePlan({
      mission,
      brainRecall: {
        nodes: [{ id: 'n3', title: 'README', snippet: 'the test failed last week', score: 1 }],
        tokensSaved: 0,
        injectedContext: '',
      },
    });
    expect(sniffed.adaptations.some((a) => a.kind === 'reinforced_testing')).toBe(false);

    const tagged = compilePlan({
      mission,
      brainRecall: {
        nodes: [{ id: 'n4', title: '[test_insight] coverage gap', snippet: '', score: 1 }],
        tokensSaved: 0,
        injectedContext: '',
      },
    });
    expect(tagged.adaptations.some((a) => a.kind === 'reinforced_testing')).toBe(true);
  });
});
