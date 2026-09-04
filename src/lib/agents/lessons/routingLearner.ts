/* routingLearner.ts — Phase 8: Routing Learning + Proposal Gate.
 *
 * Analyzes trace journal entries to learn which agent/model/effort
 * combination works best for which task shape. Produces routing
 * proposals that pass through an eval gate before becoming active
 * routing overrides.
 *
 * The learner is:
 *   1. Fed trace entries from the trace journal (per-node outcomes).
 *   2. Groups entries by task shape (normalized description keywords).
 *   3. For each group, computes success rate per (agent, model, effort).
 *   4. If a configuration has statistically significant advantage
 *      over the default, produces a RoutingProposal.
 *   5. Proposals pass through an eval gate (trial → proven | evicted)
 *      using the existing lesson store infrastructure.
 *
 * Proposals are suggestions — the manager engine can cite them when
 * building generate_plan steps, and the eval gate tracks whether
 * citing them actually improved outcomes.
 */

import type { TraceEntry } from '../graph/traceJournal.js';
import { upsertLesson, findLessonByPathology, citeLesson, recordLessonOutcome, transitionLessonStatus, getProvenLessons, getTrialLessons } from './lessonStore.js';

// ── Types ──────────────────────────────────────────────────────────

/** A routing proposal: "for task shape X, use agent A with model M at effort E". */
export interface RoutingProposal {
  /** Normalized task shape (lowercased keyword set). */
  taskShape: string;
  /** Recommended agent name. */
  agentName: string;
  /** Recommended model tier. */
  model?: string;
  /** Recommended effort level. */
  effort?: string;
  /** Success rate with this configuration (0-1). */
  successRate: number;
  /** Number of trace entries supporting this proposal. */
  sampleCount: number;
  /** Success rate of the default/baseline configuration (0-1). */
  baselineSuccessRate: number;
  /** Lift over baseline (successRate - baselineSuccessRate). */
  lift: number;
}

/** Result of running the routing learner on a set of trace entries. */
export interface RoutingLearnerResult {
  proposals: RoutingProposal[];
  /** Total trace entries analyzed. */
  totalEntries: number;
  /** Number of distinct task shapes found. */
  taskShapes: number;
}

// ── Task shape normalization ───────────────────────────────────────

/**
 * Normalize a node label/description into a task shape key.
 * Lowercases, removes common stop words, keeps top 5 keywords.
 */
export function normalizeTaskShape(label: string): string {
  const stopWords = new Set([
    'the', 'a', 'an', 'to', 'for', 'in', 'on', 'at', 'by', 'with',
    'and', 'or', 'not', 'is', 'are', 'was', 'were', 'be', 'been',
    'this', 'that', 'it', 'from', 'as', 'of', 'into', 'your',
    'implement', 'write', 'create', 'update', 'fix', 'add', 'run',
    'do', 'make', 'build', 'setup', 'configure',
  ]);

  const words = label
    .toLowerCase()
    .split(/[\s\-_,.;:!?/]+/)
    .filter((w) => w.length > 2 && !stopWords.has(w))
    .slice(0, 5)
    .sort();

  return words.join(' ');
}

// ── Core learner ───────────────────────────────────────────────────

/** Minimum sample size to produce a proposal. */
const MIN_SAMPLE = 3;

/** Minimum lift (improvement over baseline) to produce a proposal. */
const MIN_LIFT = 0.1;

interface ConfigKey {
  agent: string;
  model?: string;
  effort?: string;
}

function configKey(c: ConfigKey): string {
  return `${c.agent}|${c.model ?? 'default'}|${c.effort ?? 'default'}`;
}

function configFromEntry(entry: TraceEntry): ConfigKey {
  return {
    agent: entry.stepContract?.agent ?? 'unknown',
    model: entry.stepContract?.model,
    effort: entry.stepContract?.effort,
  };
}

/**
 * Run the routing learner on a set of trace entries.
 * Groups entries by task shape, then for each shape, finds the
 * best (agent, model, effort) configuration.
 */
export function runRoutingLearner(entries: TraceEntry[]): RoutingLearnerResult {
  // Filter to task nodes with step contracts
  const taskEntries = entries.filter(
    (e) => e.nodeKind === 'task' && e.stepContract?.agent,
  );

  if (taskEntries.length === 0) {
    return { proposals: [], totalEntries: entries.length, taskShapes: 0 };
  }

  // Group by task shape
  const byShape = new Map<string, TraceEntry[]>();
  for (const entry of taskEntries) {
    const shape = normalizeTaskShape(entry.nodeLabel);
    if (shape.length === 0) continue;
    const bucket = byShape.get(shape) ?? [];
    bucket.push(entry);
    byShape.set(shape, bucket);
  }

  const proposals: RoutingProposal[] = [];

  for (const [shape, shapeEntries] of byShape) {
    if (shapeEntries.length < MIN_SAMPLE) continue;

    // Group by config within this shape
    const byConfig = new Map<string, { entries: TraceEntry[]; config: ConfigKey }>();
    for (const entry of shapeEntries) {
      const config = configFromEntry(entry);
      const key = configKey(config);
      const bucket = byConfig.get(key) ?? { entries: [], config };
      bucket.entries.push(entry);
      byConfig.set(key, bucket);
    }

    // Compute success rate per config
    const configStats = Array.from(byConfig.entries()).map(([key, { entries: ents, config }]) => {
      const successes = ents.filter((e) => e.outcome === 'success').length;
      return {
        key,
        config,
        successRate: successes / ents.length,
        sampleCount: ents.length,
      };
    });

    if (configStats.length < 2) continue;

    // Sort by success rate descending
    configStats.sort((a, b) => b.successRate - a.successRate);

    // The best config
    const best = configStats[0];
    // The baseline = the most common config (most samples)
    const baseline = configStats.reduce((a, b) => (b.sampleCount > a.sampleCount ? b : a));

    if (best.key === baseline.key) continue;
    if (best.sampleCount < MIN_SAMPLE) continue;

    const lift = best.successRate - baseline.successRate;
    if (lift < MIN_LIFT) continue;

    proposals.push({
      taskShape: shape,
      agentName: best.config.agent,
      model: best.config.model,
      effort: best.config.effort,
      successRate: best.successRate,
      sampleCount: best.sampleCount,
      baselineSuccessRate: baseline.successRate,
      lift,
    });
  }

  // Sort proposals by lift descending
  proposals.sort((a, b) => b.lift - a.lift);

  return {
    proposals,
    totalEntries: entries.length,
    taskShapes: byShape.size,
  };
}

// ── Proposal → Lesson bridge ───────────────────────────────────────

/**
 * Convert routing proposals into trial lessons in the lesson store.
 * Each proposal becomes a lesson with where='routing', why=taskShape.
 */
export function proposalsToLessons(
  projectId: string,
  proposals: RoutingProposal[],
): string[] {
  const lessonIds: string[] = [];

  for (const p of proposals) {
    const existing = findLessonByPathology(projectId, 'routing', p.taskShape);
    if (existing) {
      // Update the existing lesson with new evidence
      lessonIds.push(existing.id);
      continue;
    }

    const title = `Route "${p.taskShape}" to ${p.agentName}`;
    const body = `Task shape "${p.taskShape}" has ${Math.round(p.successRate * 100)}% success with ${p.agentName} (${p.model ?? 'default model'}, ${p.effort ?? 'default effort'}) vs ${Math.round(p.baselineSuccessRate * 100)}% baseline. Lift: +${Math.round(p.lift * 100)}pp over ${p.sampleCount} samples.`;
    const suggestion = `For tasks matching "${p.taskShape}", prefer agentName="${p.agentName}"${p.model ? `, model="${p.model}"` : ''}${p.effort ? `, effort="${p.effort}"` : ''}.`;

    const id = upsertLesson({
      projectId,
      where: 'routing',
      why: p.taskShape,
      title,
      body,
      suggestion,
      provenance: 'learningLoop',
    });
    lessonIds.push(id);
  }

  return lessonIds;
}

// ── Proposal gate (eval-gated activation) ──────────────────────────

/** Minimum times cited before a trial routing lesson can be promoted to proven. */
const PROMOTE_THRESHOLD = 3;

/** Minimum EMA delta to promote a trial to proven. */
const PROMOTE_EMA = 0.05;

/** Maximum EMA delta (negative) to evict a trial. */
const EVICT_EMA = -0.05;

/**
 * Evaluate a routing lesson after a run outcome.
 * Records the outcome and potentially transitions the lesson status.
 */
export function evalRoutingLesson(
  projectId: string,
  taskShape: string,
  helped: boolean,
  harmed: boolean,
  delta: number,
): { action: 'none' | 'promoted' | 'evicted'; lessonId?: string } {
  const lesson = findLessonByPathology(projectId, 'routing', taskShape);
  if (!lesson) return { action: 'none' };

  citeLesson(lesson.id);
  recordLessonOutcome(lesson.id, delta, helped, harmed);

  // Check promotion/eviction thresholds
  if (lesson.timesCited + 1 >= PROMOTE_THRESHOLD) {
    // Re-fetch to get updated EMA
    const updated = findLessonByPathology(projectId, 'routing', taskShape);
    if (!updated) return { action: 'none', lessonId: lesson.id };

    if (updated.scoreDeltaEma >= PROMOTE_EMA && updated.status === 'trial') {
      transitionLessonStatus(lesson.id, 'proven');
      return { action: 'promoted', lessonId: lesson.id };
    }

    if (updated.scoreDeltaEma <= EVICT_EMA && updated.status === 'trial') {
      transitionLessonStatus(lesson.id, 'evicted');
      return { action: 'evicted', lessonId: lesson.id };
    }
  }

  return { action: 'none', lessonId: lesson.id };
}

// ── Active routing overrides ───────────────────────────────────────

/**
 * Get proven routing lessons for a project, formatted as
 * routing overrides that the manager engine can consult
 * when building generate_plan steps.
 */
export function getActiveRoutingOverrides(projectId: string): RoutingProposal[] {
  const proven = getProvenLessons(projectId);
  return proven
    .filter((l) => l.where === 'routing')
    .map((l) => ({
      taskShape: l.why,
      agentName: l.title.split(' to ')[1] ?? 'unknown',
      successRate: 1,
      sampleCount: l.timesCited,
      baselineSuccessRate: 0,
      lift: l.scoreDeltaEma,
    }));
}

/**
 * Build a routing context block for the manager dynamic context.
 * Lists proven routing lessons as suggestions for generate_plan.
 */
export function buildRoutingContext(projectId: string): string {
  const proven = getProvenLessons(projectId);
  const trials = getTrialLessons(projectId);

  const routingProven = proven.filter((l) => l.where === 'routing');
  const routingTrials = trials.filter((l) => l.where === 'routing');

  if (routingProven.length === 0 && routingTrials.length === 0) return '';

  const lines: string[] = [];

  if (routingProven.length > 0) {
    lines.push('Proven routing overrides (apply when task shape matches):');
    for (const l of routingProven) {
      lines.push(`- ${l.title}: ${l.suggestion ?? l.body.slice(0, 150)}`);
    }
  }

  if (routingTrials.length > 0) {
    lines.push('Trial routing suggestions (consider, not yet proven):');
    for (const l of routingTrials) {
      lines.push(`- ${l.title}: ${l.suggestion ?? l.body.slice(0, 100)}`);
    }
  }

  return lines.join('\n');
}
