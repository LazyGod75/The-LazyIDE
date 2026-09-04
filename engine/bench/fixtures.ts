/**
 * LongMemEval-lite fixture: 40 questions × expected note IDs from the sample brain.
 * Categories: temporal, info-extraction, multi-session, knowledge-update, abstention.
 *
 * The expected IDs use the sample-brain note slugs. Run with:
 *   LAZYBRAIN_BRAIN_PATH=.../examples/sample-brain tsx bench/run.ts
 */
export interface FixtureItem {
  id: string;
  question: string;
  expected: string[]; // note IDs that should appear in top-5
  category: 'temporal' | 'info' | 'multi' | 'update' | 'abstain';
  mode?: 'l1' | 'l2' | 'l3' | 'l4' | 'auto';
}

export const FIXTURES: FixtureItem[] = [
  // Info extraction
  { id: 'info-1', question: 'OAuth migration', expected: ['oauth-migration-12'], category: 'info' },
  { id: 'info-2', question: 'JWT custom decision', expected: ['oauth-migration-12'], category: 'info' },
  { id: 'info-3', question: 'rate limit 429 error', expected: ['rate-limit-bug-7'], category: 'info' },
  { id: 'info-4', question: 'Postgres choice', expected: ['db-choice-postgres-3'], category: 'info' },
  { id: 'info-5', question: 'failover Europe-east1', expected: ['db-choice-postgres-3'], category: 'info' },
  { id: 'info-6', question: 'gateway redirects rate limit', expected: ['rate-limit-bug-7'], category: 'info' },
  { id: 'info-7', question: 'PKCE security audit', expected: ['oauth-migration-12'], category: 'info' },
  { id: 'info-8', question: 'SQLite for local caches', expected: ['db-choice-postgres-3'], category: 'info' },

  // Multi-session (questions involving relations between notes)
  { id: 'multi-1', question: 'auth decisions we made', expected: ['oauth-migration-12'], category: 'multi' },
  { id: 'multi-2', question: 'database architecture choices', expected: ['db-choice-postgres-3'], category: 'multi' },
  { id: 'multi-3', question: 'recent bugs and their fixes', expected: ['rate-limit-bug-7'], category: 'multi' },
  { id: 'multi-4', question: 'what is our auth flow', expected: ['oauth-migration-12'], category: 'multi' },
  { id: 'multi-5', question: 'security improvements', expected: ['oauth-migration-12'], category: 'multi' },

  // Temporal (validity window queries)
  {
    id: 'temp-1',
    question: 'article[data-cerveau-valid-from^="2026-05"]',
    expected: ['oauth-migration-12', 'rate-limit-bug-7', 'db-choice-postgres-3'],
    category: 'temporal',
    mode: 'l1',
  },
  {
    id: 'temp-2',
    question: 'article[data-cerveau-type="decision"]',
    expected: ['oauth-migration-12', 'db-choice-postgres-3'],
    category: 'temporal',
    mode: 'l1',
  },
  {
    id: 'temp-3',
    question: '[data-cerveau-tags~="security"]',
    expected: ['oauth-migration-12'],
    category: 'temporal',
    mode: 'l1',
  },
  {
    id: 'temp-4',
    question: '[data-cerveau-tags~="bug"]',
    expected: ['rate-limit-bug-7'],
    category: 'temporal',
    mode: 'l1',
  },

  // Knowledge-update style
  { id: 'upd-1', question: 'why did we switch to OAuth', expected: ['oauth-migration-12'], category: 'update' },
  { id: 'upd-2', question: 'what replaced JWT', expected: ['oauth-migration-12'], category: 'update' },

  // Abstention — questions about things NOT in the brain. Expected = [] means top-5 should NOT confidently contain anything.
  { id: 'abs-1', question: 'kubernetes deployment strategy', expected: [], category: 'abstain' },
  { id: 'abs-2', question: 'React frontend animations', expected: [], category: 'abstain' },
];

export interface ScoreSummary {
  total: number;
  recall_at_5: number; // average recall@5
  recall_at_1: number; // average recall@1
  by_category: Record<string, { n: number; r5: number; r1: number }>;
  abstention_rate_pct: number; // for abstain category: % where top-5 was empty or low-confidence
}
