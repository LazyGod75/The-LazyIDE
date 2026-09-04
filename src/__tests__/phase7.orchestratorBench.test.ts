/**
 * Phase 7 tests — orchestrator bench runs deterministically in fixture mode.
 */

import { describe, it, expect } from 'vitest';
import { runOrchestratorBench } from '../../bench/lib/orchestrator.mjs';

describe('Phase 7 — orchestrator bench (fixture mode)', () => {
  it('runs without errors in fixture mode', async () => {
    const result = await runOrchestratorBench({ live: false });
    expect(result).toBeDefined();
    expect(result.name).toBe('orchestrator');
  });

  it('loads 5 fixture scenarios', async () => {
    const result = await runOrchestratorBench({ live: false });
    expect(result.scenarios).toBe(5);
  });

  it('produces routing accuracy score between 0 and 1', async () => {
    const result = await runOrchestratorBench({ live: false });
    expect(result.routingAccuracy.score).toBeGreaterThan(0);
    expect(result.routingAccuracy.score).toBeLessThanOrEqual(1);
  });

  it('produces topology efficiency score between 0 and 1', async () => {
    const result = await runOrchestratorBench({ live: false });
    expect(result.topologyEfficiency.score).toBeGreaterThanOrEqual(0);
    expect(result.topologyEfficiency.score).toBeLessThanOrEqual(1);
  });

  it('produces macro reuse score between 0 and 1', async () => {
    const result = await runOrchestratorBench({ live: false });
    expect(result.macroReuse.score).toBeGreaterThanOrEqual(0);
    expect(result.macroReuse.score).toBeLessThanOrEqual(1);
  });

  it('skips prompt quality in fixture mode', async () => {
    const result = await runOrchestratorBench({ live: false });
    expect(result.promptQuality.skipped).toBe(true);
    expect(result.promptQuality.score).toBeNull();
  });

  it('produces overall score as weighted average', async () => {
    const result = await runOrchestratorBench({ live: false });
    expect(result.overall).toBeGreaterThan(0);
    expect(result.overall).toBeLessThanOrEqual(1);
  });

  it('produces per-scenario breakdown', async () => {
    const result = await runOrchestratorBench({ live: false });
    expect(result.perScenario!).toHaveLength(5);
    expect(result.perScenario![0].id).toBe('routing-basic');
  });

  it('routing-basic scenario has 100% routing accuracy (3/3 correct)', async () => {
    const result = await runOrchestratorBench({ live: false });
    const basic = result.perScenario!.find((s) => s.id === 'routing-basic');
    expect(basic!.routing.correct).toBe(3);
    expect(basic!.routing.total).toBe(3);
    expect(basic!.routing.score).toBe(1);
  });

  it('routing-misassigned scenario has 2/3 routing accuracy', async () => {
    const result = await runOrchestratorBench({ live: false });
    const misassigned = result.perScenario!.find((s) => s.id === 'routing-misassigned');
    expect(misassigned!.routing.correct).toBe(2);
    expect(misassigned!.routing.total).toBe(3);
    expect(misassigned!.routing.score).toBeCloseTo(2 / 3, 2);
  });
});
