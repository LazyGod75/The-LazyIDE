import { describe, it, expect } from 'vitest';
import { computeHeuristicRisk } from '../lib/review/risk';

// ── computeHeuristicRisk (DiffDrawer.tsx's risk badge, ReviewSpace.tsx's
// heuristic risk panel via the computeChangeRisk adapter) ──────────────

describe('computeHeuristicRisk', () => {
  it('reports low risk with no reasons for an unremarkable diff', () => {
    const risk = computeHeuristicRisk({ title: 'fix: typo in comment', content: 'const x = 1;', removed: 2 });
    expect(risk.level).toBe('low');
    expect(risk.reasons).toEqual([]);
  });

  it('reports medium risk with one reason when a single signal fires', () => {
    const risk = computeHeuristicRisk({ title: 'feat: add login', content: 'const token = readAuthToken();', removed: 3 });
    expect(risk.level).toBe('medium');
    expect(risk.reasons).toEqual(['touches auth/credentials']);
  });

  it('reports high risk when two or more signals fire', () => {
    const risk = computeHeuristicRisk({
      title: 'feat: billing webhook',
      content: 'const secret = process.env.STRIPE_SECRET; await charge(card);',
      removed: 0,
    });
    expect(risk.level).toBe('high');
    expect(risk.reasons).toEqual(['touches auth/credentials', 'touches payment/PII']);
  });

  it('flags a large deletion as its own risk signal', () => {
    const risk = computeHeuristicRisk({ title: 'chore: cleanup', content: 'removed dead code', removed: 40 });
    expect(risk.level).toBe('medium');
    expect(risk.reasons).toEqual(['large deletion (40 lines)']);
  });

  it('scans the title as well as the content for auth/payment signals', () => {
    const risk = computeHeuristicRisk({ title: 'fix: rotate stripe secret', content: 'no matches here', removed: 0 });
    expect(risk.level).toBe('high');
    expect(risk.reasons).toEqual(['touches auth/credentials', 'touches payment/PII']);
  });
});
