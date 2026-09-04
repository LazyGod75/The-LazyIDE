/* contextMeter.test.ts — unit tests for the smart-zone context meter. */
import { describe, it, expect } from 'vitest';
import {
  measureContext,
  summarizeContext,
  SMART_ZONE_FRACTION,
  DEFAULT_WINDOW_TOKENS,
} from '../contextMeter';

describe('measureContext', () => {
  it('computes the smart-zone budget from the window', () => {
    const meter = measureContext({});
    expect(meter.windowTokens).toBe(DEFAULT_WINDOW_TOKENS);
    expect(meter.smartZoneTokens).toBe(Math.round(DEFAULT_WINDOW_TOKENS * SMART_ZONE_FRACTION));
  });

  it('measures each component against its budget', () => {
    const meter = measureContext({
      systemPrompt: 'x'.repeat(4000), // ~1000 tokens
      rulesBlock: 'a'.repeat(800), // ~200 tokens
    });
    const sys = meter.components.find((c) => c.component === 'systemPrompt')!;
    const rules = meter.components.find((c) => c.component === 'rules')!;
    expect(sys.tokens).toBeGreaterThan(0);
    expect(rules.tokens).toBeGreaterThan(0);
    expect(rules.budget).toBeGreaterThan(0);
  });

  it('flags over-budget components', () => {
    const meter = measureContext({
      rulesBlock: 'x'.repeat(12000), // ~3000 tokens vs 1200 budget
    });
    const rules = meter.components.find((c) => c.component === 'rules')!;
    expect(rules.overBudget).toBe(true);
  });

  it('detects the allocation problem when static fills exceed the smart zone', () => {
    const huge = 'x'.repeat(400_000); // ~100k tokens
    const meter = measureContext({ systemPrompt: huge });
    expect(meter.allocationProblem).toBe(true);
    expect(meter.staticTokens).toBeGreaterThan(meter.smartZoneTokens);
  });

  it('counts history tokens into the total but not the static sum', () => {
    const meter = measureContext({ systemPrompt: 'hello' }, { historyTokens: 5000 });
    expect(meter.staticTokens).toBeLessThan(5000);
    expect(meter.totalUsedTokens).toBeGreaterThanOrEqual(5000);
  });
});

describe('summarizeContext', () => {
  it('produces a readable summary line', () => {
    const meter = measureContext({});
    const s = summarizeContext(meter);
    expect(s.length).toBeGreaterThan(0);
  });
});
