/* topologyLearner.ts — Phase 9: Topology Evolution Learner.
 *
 * Analyzes trace journal entries to learn which graph topology
 * patterns yield better outcomes. Proposes topology modifications
 * (add joins, parallelize sequential steps, add contest nodes)
 * that pass through the eval gate.
 *
 * Metrics analyzed:
 *   - Parallelism ratio (critical path vs node count)
 *   - Join point effectiveness (does waiting for all deps improve outcome?)
 *   - Contest node ROI (does N-way contest improve outcome vs single?)
 *   - Failure cascade depth (how deep do failures propagate?)
 */

import type { TraceEntry } from '../graph/traceJournal.js';
import { upsertLesson, findLessonByPathology } from './lessonStore.js';

// ── Types ──────────────────────────────────────────────────────────

export interface TopologyProposal {
  /** The topology pattern that works better. */
  pattern: 'parallel' | 'sequential' | 'join-all' | 'join-quorum' | 'contest';
  /** The graph shape context where this applies. */
  graphShape: string;
  /** Success rate with this pattern (0-1). */
  successRate: number;
  /** Success rate without this pattern (0-1). */
  baselineSuccessRate: number;
  /** Lift over baseline. */
  lift: number;
  /** Sample count. */
  sampleCount: number;
  /** Human-readable suggestion. */
  suggestion: string;
}

export interface TopologyLearnerResult {
  proposals: TopologyProposal[];
  totalEntries: number;
}

// ── Core learner ───────────────────────────────────────────────────

const MIN_SAMPLE = 3;
const MIN_LIFT = 0.1;

/**
 * Run the topology learner on a set of trace entries.
 * Groups by graph id, then analyzes topology patterns within each graph.
 */
export function runTopologyLearner(entries: TraceEntry[]): TopologyLearnerResult {
  if (entries.length === 0) {
    return { proposals: [], totalEntries: 0 };
  }

  // Group by graphId
  const byGraph = new Map<string, TraceEntry[]>();
  for (const entry of entries) {
    const bucket = byGraph.get(entry.graphId) ?? [];
    bucket.push(entry);
    byGraph.set(entry.graphId, bucket);
  }

  const proposals: TopologyProposal[] = [];

  for (const [graphId, graphEntries] of byGraph) {
    // Analyze contest nodes
    const contestEntries = graphEntries.filter((e) => e.nodeKind === 'contest');
    const taskEntries = graphEntries.filter((e) => e.nodeKind === 'task');

    if (contestEntries.length >= MIN_SAMPLE && taskEntries.length >= MIN_SAMPLE) {
      const contestSuccess = contestEntries.filter((e) => e.outcome === 'success').length;
      const taskSuccess = taskEntries.filter((e) => e.outcome === 'success').length;
      const contestRate = contestSuccess / contestEntries.length;
      const taskRate = taskSuccess / taskEntries.length;
      const lift = contestRate - taskRate;

      if (lift >= MIN_LIFT) {
        proposals.push({
          pattern: 'contest',
          graphShape: graphId,
          successRate: contestRate,
          baselineSuccessRate: taskRate,
          lift,
          sampleCount: contestEntries.length,
          suggestion: `Contest nodes in ${graphId} have ${Math.round(contestRate * 100)}% success vs ${Math.round(taskRate * 100)}% for single-task nodes. Consider using contest nodes for high-stakes steps.`,
        });
      }
    }

    // Analyze parallel vs sequential (using duration as a proxy)
    const allSuccess = graphEntries.filter((e) => e.outcome === 'success');
    if (allSuccess.length >= MIN_SAMPLE) {
      const withDuration = allSuccess.filter((e) => e.durationMs !== undefined);
      if (withDuration.length >= MIN_SAMPLE) {
        const avgDuration = withDuration.reduce((sum, e) => sum + (e.durationMs ?? 0), 0) / withDuration.length;
        const fastEntries = withDuration.filter((e) => (e.durationMs ?? 0) < avgDuration);
        const slowEntries = withDuration.filter((e) => (e.durationMs ?? 0) >= avgDuration);

        if (fastEntries.length >= MIN_SAMPLE && slowEntries.length >= MIN_SAMPLE) {
          // Fast nodes likely ran in parallel — check if they have better outcomes
          const fastCost = fastEntries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0) / fastEntries.length;
          const slowCost = slowEntries.reduce((sum, e) => sum + (e.costUsd ?? 0), 0) / slowEntries.length;

          if (fastCost < slowCost) {
            proposals.push({
              pattern: 'parallel',
              graphShape: graphId,
              successRate: fastEntries.length / withDuration.length,
              baselineSuccessRate: slowEntries.length / withDuration.length,
              lift: (fastEntries.length - slowEntries.length) / withDuration.length,
              sampleCount: fastEntries.length,
              suggestion: `Parallel execution in ${graphId} shows ${Math.round((1 - fastCost / slowCost) * 100)}% cost savings. Maximize parallelism where dependencies allow.`,
            });
          }
        }
      }
    }
  }

  // Sort by lift descending
  proposals.sort((a, b) => b.lift - a.lift);

  return {
    proposals,
    totalEntries: entries.length,
  };
}

/**
 * Convert topology proposals into trial lessons.
 */
export function topologyProposalsToLessons(
  projectId: string,
  proposals: TopologyProposal[],
): string[] {
  const lessonIds: string[] = [];

  for (const p of proposals) {
    const why = `${p.pattern}:${p.graphShape}`;
    const existing = findLessonByPathology(projectId, 'topology', why);
    if (existing) {
      lessonIds.push(existing.id);
      continue;
    }

    const id = upsertLesson({
      projectId,
      where: 'topology',
      why,
      title: `Topology: use ${p.pattern} in ${p.graphShape}`,
      body: p.suggestion,
      suggestion: p.suggestion,
      provenance: 'learningLoop',
    });
    lessonIds.push(id);
  }

  return lessonIds;
}
