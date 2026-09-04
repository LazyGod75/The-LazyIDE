/**
 * Tests for loopMetrics.ts — generic external-metric ingestion + synthesis
 * (spec §6).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  recordExternalMetric,
  getMetricsForMission,
  getMetricsForLoop,
  synthesizeMetricTrend,
  formatMetricSynthesisText,
  type ExternalMetricEntry,
} from '../lib/agents/loopMetrics';

const files = new Map<string, string>();

const readFile = vi.fn(async (path: string): Promise<string> => {
  const content = files.get(path);
  if (content === undefined) throw new Error('not found');
  return content;
});
const writeFile = vi.fn(async (path: string, content: string): Promise<void> => {
  files.set(path, content);
});
const createDir = vi.fn().mockResolvedValue(undefined);

vi.mock('../lib/platform', () => ({
  getPlatform: () => ({ fs: { readFile, writeFile, createDir } }),
}));

beforeEach(() => {
  files.clear();
  readFile.mockClear();
  writeFile.mockClear();
  createDir.mockClear();
});

const REPO = '/repo';

describe('recordExternalMetric / getMetricsForMission / getMetricsForLoop', () => {
  it('attaches a named metric to a past execution and reads it back', async () => {
    await recordExternalMetric(REPO, { missionId: 'M1', loopId: 'L1', metricName: 'engagement', source: 'manual', value: 3.2 });
    const entries = await getMetricsForMission(REPO, 'M1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ missionId: 'M1', loopId: 'L1', metricName: 'engagement', source: 'manual', value: 3.2 });
    expect(typeof entries[0].recordedAt).toBe('string');
  });

  it('is append-only — recording a second metric never removes the first', async () => {
    await recordExternalMetric(REPO, { missionId: 'M1', loopId: 'L1', metricName: 'engagement', source: 'manual', value: 1 });
    await recordExternalMetric(REPO, { missionId: 'M2', loopId: 'L1', metricName: 'engagement', source: 'manual', value: 2 });
    const entries = await getMetricsForLoop(REPO, 'L1', 'engagement');
    expect(entries.map((e) => e.value)).toEqual([1, 2]);
  });

  it('narrows getMetricsForLoop to the named metric when given one', async () => {
    await recordExternalMetric(REPO, { missionId: 'M1', loopId: 'L1', metricName: 'engagement', source: 'manual', value: 1 });
    await recordExternalMetric(REPO, { missionId: 'M1', loopId: 'L1', metricName: 'reach', source: 'manual', value: 100 });
    const engagementOnly = await getMetricsForLoop(REPO, 'L1', 'engagement');
    expect(engagementOnly).toHaveLength(1);
    expect(engagementOnly[0].metricName).toBe('engagement');
  });

  it('never returns metrics from a different loop', async () => {
    await recordExternalMetric(REPO, { missionId: 'M1', loopId: 'L1', metricName: 'engagement', source: 'manual', value: 1 });
    await recordExternalMetric(REPO, { missionId: 'M2', loopId: 'L2', metricName: 'engagement', source: 'manual', value: 5 });
    const l1Entries = await getMetricsForLoop(REPO, 'L1');
    expect(l1Entries.map((e) => e.missionId)).toEqual(['M1']);
  });

  it('accepts a fully generic metric name/source — never validated against a fixed list', async () => {
    const entry = await recordExternalMetric(REPO, {
      missionId: 'M1',
      metricName: 'anything_the_user_names',
      source: 'a-webhook-nobody-anticipated',
      value: 42,
    });
    expect(entry.metricName).toBe('anything_the_user_names');
  });
});

function entry(missionId: string, value: number, metricName = 'engagement'): ExternalMetricEntry {
  return { missionId, metricName, source: 'manual', value, recordedAt: new Date(2026, 0, 1).toISOString() };
}

describe('synthesizeMetricTrend', () => {
  it('returns count 0 for no history at all', () => {
    expect(synthesizeMetricTrend([], 'engagement')).toEqual({ metricName: 'engagement', count: 0 });
  });

  it('reports only `latest` for a single data point — never fabricates a decline', () => {
    const result = synthesizeMetricTrend([entry('M1', 10)], 'engagement');
    expect(result).toEqual({ metricName: 'engagement', count: 1, latest: 10 });
    expect(result.declinePct).toBeUndefined();
  });

  it('computes a negative declinePct when the recent half is lower than the older half', () => {
    const entries = [entry('M1', 10), entry('M2', 10), entry('M3', 5), entry('M4', 5)];
    const result = synthesizeMetricTrend(entries, 'engagement');
    expect(result.priorAverage).toBe(10);
    expect(result.recentAverage).toBe(5);
    expect(result.declinePct).toBe(-50);
  });

  it('computes a positive declinePct (growth) when the recent half is higher', () => {
    const entries = [entry('M1', 5), entry('M2', 5), entry('M3', 10), entry('M4', 10)];
    const result = synthesizeMetricTrend(entries, 'engagement');
    expect(result.declinePct).toBe(100);
  });

  it('ignores entries for a different metric name', () => {
    const entries = [entry('M1', 10, 'engagement'), entry('M1', 999, 'reach')];
    const result = synthesizeMetricTrend(entries, 'engagement');
    expect(result.count).toBe(1);
    expect(result.latest).toBe(10);
  });
});

describe('formatMetricSynthesisText', () => {
  it('returns null for an empty synthesis (never fabricates text from zero data)', () => {
    expect(formatMetricSynthesisText({ metricName: 'engagement', count: 0 })).toBeNull();
  });

  it('formats a compact block including the trend when available', () => {
    const text = formatMetricSynthesisText({
      metricName: 'engagement',
      count: 4,
      latest: 5,
      recentAverage: 5,
      priorAverage: 10,
      declinePct: -50,
    });
    expect(text).toContain('engagement');
    expect(text).toContain('latest 5');
    expect(text).toContain('-50.0%');
  });

  it('formats without a trend percentage clause when declinePct is unavailable', () => {
    const text = formatMetricSynthesisText({ metricName: 'engagement', count: 1, latest: 5 });
    expect(text).toContain('latest 5');
    expect(text).not.toContain('vs previous');
    expect(text).not.toContain('%');
  });
});
