/* brainSavings.test.ts — src/lib/journal/brainSavings.ts's pure "Brain" card
   read-model. Synthetic JournalEventRow fixtures only (no I/O). */

import { describe, it, expect } from 'vitest';
import { buildBrainSavings } from '../lib/journal/brainSavings';
import type { JournalEventRow, JournalEventType } from '../lib/journal/eventTypes';

let seqCounter = 0;

function row(
  type: JournalEventType,
  tsMs: number,
  payload: Record<string, unknown> = {},
  overrides: Partial<JournalEventRow> = {},
): JournalEventRow {
  seqCounter += 1;
  return {
    seq: seqCounter,
    ts_ms: tsMs,
    project_id: 'proj-1',
    mission_id: 'm-1',
    agent_id: null,
    run_id: null,
    actor: 'system',
    type,
    payload: JSON.stringify(payload),
    tokens_in: 0,
    tokens_out: 0,
    cost_usd: 0,
    ...overrides,
  };
}

describe('buildBrainSavings', () => {
  it('reports an honest all-zero summary with hasActivity false when the journal has no brain/cache events', () => {
    const summary = buildBrainSavings([row('mission.created', 1_000, { title: 'X' })]);
    expect(summary).toEqual({ recallCount: 0, cacheReadTokens: 0, hasActivity: false });
  });

  it('counts every brain.recalled event', () => {
    const events = [
      row('brain.recalled', 1_000, { query: 'q1', nodeIds: ['n1'] }),
      row('brain.recalled', 2_000, { query: 'q2', nodeIds: ['n2', 'n3'] }),
      row('brain.recalled', 3_000, { query: 'q3', nodeIds: [] }),
    ];
    const summary = buildBrainSavings(events);
    expect(summary.recallCount).toBe(3);
    expect(summary.hasActivity).toBe(true);
  });

  it('sums cacheReadInputTokens across every spend.tokens event', () => {
    const events = [
      row('spend.tokens', 1_000, { tokensIn: 100, tokensOut: 50, costUsd: 0.01, source: 'real', cacheReadInputTokens: 500 }),
      row('spend.tokens', 2_000, { tokensIn: 80, tokensOut: 20, costUsd: 0.02, source: 'real', cacheReadInputTokens: 1500 }),
    ];
    const summary = buildBrainSavings(events);
    expect(summary.cacheReadTokens).toBe(2000);
    expect(summary.hasActivity).toBe(true);
  });

  it('treats a spend.tokens event with no cacheReadInputTokens field as contributing 0, never NaN', () => {
    const events = [row('spend.tokens', 1_000, { tokensIn: 10, tokensOut: 5, costUsd: 0.001, source: 'real' })];
    const summary = buildBrainSavings(events);
    expect(summary.cacheReadTokens).toBe(0);
    expect(summary.hasActivity).toBe(false);
  });

  it('combines recalls and cache tokens from a mixed event stream', () => {
    const events = [
      row('brain.recalled', 1_000, { query: 'q', nodeIds: ['n1'] }),
      row('spend.tokens', 1_500, { tokensIn: 10, tokensOut: 5, costUsd: 0.001, source: 'real', cacheReadInputTokens: 300 }),
      row('mission.completed', 2_000, {}),
    ];
    const summary = buildBrainSavings(events);
    expect(summary).toEqual({ recallCount: 1, cacheReadTokens: 300, hasActivity: true });
  });

  it('never fabricates a contextInjectedTokens or dollar-saved figure — the summary shape only ever carries recallCount/cacheReadTokens/hasActivity', () => {
    const summary = buildBrainSavings([row('brain.recalled', 1_000, { query: 'q', nodeIds: ['n1'] })]);
    expect(Object.keys(summary).sort()).toEqual(['cacheReadTokens', 'hasActivity', 'recallCount']);
  });
});
