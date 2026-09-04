/**
 * Phase 10 tests — self-synthesizing macros.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { synthesizeMacros, macrosToLessons, buildMacroContext } from '../lib/agents/lessons/macroSynthesizer';
import { clearProjectLessons, getTrialLessons } from '../lib/agents/lessons/lessonStore';
import type { TraceEntry } from '../lib/agents/graph/traceJournal';

const PROJECT = 'test-phase10';

beforeEach(() => {
  clearProjectLessons(PROJECT);
});

function makeEntry(
  runId: string,
  nodeId: string,
  label: string,
  outcome: 'success' | 'failure',
  ts: number,
  agent = 'Coder',
): TraceEntry {
  return {
    ts,
    runId,
    graphId: 'g1',
    nodeId,
    nodeKind: 'task',
    nodeLabel: label,
    status: outcome === 'success' ? 'done' : 'failed',
    outcome,
    attempt: 1,
    missionIds: [`m-${nodeId}`],
    stepContract: { agent, model: 'sonnet', effort: 'medium' },
  };
}

describe('synthesizeMacros', () => {
  it('returns empty for no entries', () => {
    const result = synthesizeMacros([]);
    expect(result.templates).toHaveLength(0);
  });

  it('returns empty for single run (no recurrence)', () => {
    const entries = [
      makeEntry('r1', 'n1', 'auth module', 'success', 1000),
      makeEntry('r1', 'n2', 'security review', 'success', 2000),
      makeEntry('r1', 'n3', 'deploy staging', 'success', 3000),
    ];
    const result = synthesizeMacros(entries);
    expect(result.templates).toHaveLength(0);
  });

  it('detects recurring 2-gram pattern across runs', () => {
    const entries = [
      // Run 1: auth → security → deploy
      makeEntry('r1', 'n1', 'auth module', 'success', 1000),
      makeEntry('r1', 'n2', 'security review', 'success', 2000),
      makeEntry('r1', 'n3', 'deploy staging', 'success', 3000),
      // Run 2: auth → security → deploy (same pattern)
      makeEntry('r2', 'n4', 'auth module', 'success', 1000),
      makeEntry('r2', 'n5', 'security review', 'success', 2000),
      makeEntry('r2', 'n6', 'deploy staging', 'success', 3000),
    ];
    const result = synthesizeMacros(entries);
    expect(result.templates.length).toBeGreaterThan(0);
    expect(result.totalRuns).toBe(2);
  });

  it('does not synthesize macros with poor success rates', () => {
    const entries = [
      // Run 1: all failures
      makeEntry('r1', 'n1', 'auth module', 'failure', 1000),
      makeEntry('r1', 'n2', 'security review', 'failure', 2000),
      // Run 2: all failures
      makeEntry('r2', 'n3', 'auth module', 'failure', 1000),
      makeEntry('r2', 'n4', 'security review', 'failure', 2000),
    ];
    const result = synthesizeMacros(entries);
    expect(result.templates).toHaveLength(0);
  });

  it('macro nodes contain agent info', () => {
    const entries = [
      makeEntry('r1', 'n1', 'auth module', 'success', 1000, 'Architect'),
      makeEntry('r1', 'n2', 'security review', 'success', 2000, 'Reviewer'),
      makeEntry('r2', 'n3', 'auth module', 'success', 1000, 'Architect'),
      makeEntry('r2', 'n4', 'security review', 'success', 2000, 'Reviewer'),
    ];
    const result = synthesizeMacros(entries);
    expect(result.templates.length).toBeGreaterThan(0);
    const template = result.templates[0];
    expect(template.nodes.length).toBeGreaterThan(0);
    expect(template.nodes[0].agentName).toBe('Architect');
  });
});

describe('macrosToLessons', () => {
  it('creates trial lessons from templates', () => {
    const entries = [
      makeEntry('r1', 'n1', 'auth module', 'success', 1000, 'Architect'),
      makeEntry('r1', 'n2', 'security review', 'success', 2000, 'Reviewer'),
      makeEntry('r2', 'n3', 'auth module', 'success', 1000, 'Architect'),
      makeEntry('r2', 'n4', 'security review', 'success', 2000, 'Reviewer'),
    ];
    const result = synthesizeMacros(entries);
    const ids = macrosToLessons(PROJECT, result.templates);
    expect(ids.length).toBeGreaterThan(0);

    const trials = getTrialLessons(PROJECT);
    expect(trials.some((t) => t.where === 'macro')).toBe(true);
  });

  it('does not duplicate lessons for same pattern', () => {
    const entries = [
      makeEntry('r1', 'n1', 'auth module', 'success', 1000, 'Architect'),
      makeEntry('r1', 'n2', 'security review', 'success', 2000, 'Reviewer'),
      makeEntry('r2', 'n3', 'auth module', 'success', 1000, 'Architect'),
      makeEntry('r2', 'n4', 'security review', 'success', 2000, 'Reviewer'),
    ];
    const result = synthesizeMacros(entries);
    macrosToLessons(PROJECT, result.templates);
    macrosToLessons(PROJECT, result.templates);

    const trials = getTrialLessons(PROJECT).filter((t) => t.where === 'macro');
    // Should not duplicate — each unique pattern creates one lesson
    const uniqueWhys = new Set(trials.map((t) => t.why));
    expect(trials.length).toBe(uniqueWhys.size);
  });
});

describe('buildMacroContext', () => {
  it('returns empty string for no templates', () => {
    expect(buildMacroContext([])).toBe('');
  });

  it('lists templates with occurrence counts', () => {
    const entries = [
      makeEntry('r1', 'n1', 'auth module', 'success', 1000, 'Architect'),
      makeEntry('r1', 'n2', 'security review', 'success', 2000, 'Reviewer'),
      makeEntry('r2', 'n3', 'auth module', 'success', 1000, 'Architect'),
      makeEntry('r2', 'n4', 'security review', 'success', 2000, 'Reviewer'),
    ];
    const result = synthesizeMacros(entries);
    const ctx = buildMacroContext(result.templates);
    expect(ctx).toContain('Synthesized macros');
    expect(ctx).toContain('trial');
  });
});
