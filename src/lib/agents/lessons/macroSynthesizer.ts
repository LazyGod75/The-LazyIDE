/* macroSynthesizer.ts — Phase 10: Self-Synthesizing Macros.
 *
 * Detects recurring sub-patterns in trace journal entries and
 * auto-synthesizes reusable graph templates (macros) from them.
 *
 * A "macro" here is a named, reusable sub-graph pattern:
 *   - A sequence of task shapes that recurs across multiple runs
 *   - With consistent agent assignments and outcomes
 *
 * The synthesizer:
 *   1. Groups trace entries by runId to reconstruct per-run sequences.
 *   2. Finds recurring subsequences (n-grams) across runs.
 *   3. For each recurring subsequence with good outcomes, creates a
 *      MacroTemplate that can be injected into future generate_plan calls.
 *   4. Templates pass through the lesson store eval gate.
 */

import type { TraceEntry } from '../graph/traceJournal.js';
import { upsertLesson, findLessonByPathology } from './lessonStore.js';
import { normalizeTaskShape } from './routingLearner.js';

// ── Types ──────────────────────────────────────────────────────────

/** A node in a synthesized macro template. */
export interface MacroNode {
  taskShape: string;
  agentName: string;
  model?: string;
  effort?: string;
}

/** A synthesized macro template — a reusable sub-graph pattern. */
export interface MacroTemplate {
  /** Unique id for this template. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** The sequence of nodes in this macro. */
  nodes: MacroNode[];
  /** Number of runs this pattern was found in. */
  occurrenceCount: number;
  /** Average success rate across occurrences. */
  avgSuccessRate: number;
  /** Whether this template has been promoted to proven. */
  proven: boolean;
}

export interface MacroSynthesisResult {
  templates: MacroTemplate[];
  totalRuns: number;
  totalEntries: number;
}

// ── Helpers ────────────────────────────────────────────────────────

/** Minimum occurrences to synthesize a macro. */
const MIN_OCCURRENCES = 2;

/** Minimum n-gram length (sequence length) to consider. */
const MIN_NGRAM = 2;

/** Maximum n-gram length to consider. */
const MAX_NGRAM = 5;

/** Minimum average success rate to synthesize. */
const MIN_SUCCESS_RATE = 0.5;

interface RunSequence {
  runId: string;
  entries: TraceEntry[];
}

/** Group trace entries by runId, preserving order. */
function groupByRun(entries: TraceEntry[]): RunSequence[] {
  const byRun = new Map<string, TraceEntry[]>();
  for (const entry of entries) {
    const bucket = byRun.get(entry.runId) ?? [];
    bucket.push(entry);
    byRun.set(entry.runId, bucket);
  }

  // Sort each run's entries by timestamp
  const runs: RunSequence[] = [];
  for (const [runId, runEntries] of byRun) {
    runEntries.sort((a, b) => a.ts - b.ts);
    runs.push({ runId, entries: runEntries });
  }

  return runs;
}

/** Convert a trace entry to a normalized task shape key. */
function entryToShape(entry: TraceEntry): string {
  return normalizeTaskShape(entry.nodeLabel);
}

/** Extract n-grams from a sequence of task shapes. */
function extractNgrams(shapes: string[], minN: number, maxN: number): string[][] {
  const ngrams: string[][] = [];
  for (let n = minN; n <= Math.min(maxN, shapes.length); n++) {
    for (let i = 0; i <= shapes.length - n; i++) {
      ngrams.push(shapes.slice(i, i + n));
    }
  }
  return ngrams;
}

/** Check if all entries in a subsequence were successful. */
function subsequenceSuccessRate(entries: TraceEntry[], start: number, length: number): number {
  const slice = entries.slice(start, start + length);
  const successes = slice.filter((e) => e.outcome === 'success').length;
  return successes / slice.length;
}

// ── Core synthesizer ───────────────────────────────────────────────

/**
 * Run the macro synthesizer on a set of trace entries.
 * Finds recurring sub-patterns and creates macro templates.
 */
export function synthesizeMacros(entries: TraceEntry[]): MacroSynthesisResult {
  const runs = groupByRun(entries.filter((e) => e.nodeKind === 'task'));

  if (runs.length < MIN_OCCURRENCES) {
    return { templates: [], totalRuns: runs.length, totalEntries: entries.length };
  }

  // Convert each run to a sequence of task shapes
  const runShapes = runs.map((r) => r.entries.map(entryToShape).filter((s) => s.length > 0));

  // Count n-gram occurrences across all runs
  const ngramCounts = new Map<string, { count: number; occurrences: { run: RunSequence; start: number; length: number; successRate: number }[] }>();

  for (let runIdx = 0; runIdx < runs.length; runIdx++) {
    const shapes = runShapes[runIdx];
    const runEntries = runs[runIdx].entries;

    const ngrams = extractNgrams(shapes, MIN_NGRAM, MAX_NGRAM);
    for (let i = 0; i < ngrams.length; i++) {
      const ngram = ngrams[i];
      const key = ngram.join(' → ');
      const successRate = subsequenceSuccessRate(runEntries, i, ngram.length);

      const existing = ngramCounts.get(key) ?? { count: 0, occurrences: [] };
      existing.count++;
      existing.occurrences.push({ run: runs[runIdx], start: i, length: ngram.length, successRate });
      ngramCounts.set(key, existing);
    }
  }

  // Filter to n-grams that recur and have good outcomes
  const templates: MacroTemplate[] = [];

  for (const { count, occurrences } of ngramCounts.values()) {
    if (count < MIN_OCCURRENCES) continue;

    const avgSuccess = occurrences.reduce((sum, o) => sum + o.successRate, 0) / occurrences.length;
    if (avgSuccess < MIN_SUCCESS_RATE) continue;

    // Build the macro nodes from the first occurrence
    const first = occurrences[0];
    const macroNodes: MacroNode[] = [];
    for (let j = first.start; j < first.start + first.length; j++) {
      const entry = first.run.entries[j];
      if (!entry) continue;
      macroNodes.push({
        taskShape: entryToShape(entry),
        agentName: entry.stepContract?.agent ?? 'Coder',
        model: entry.stepContract?.model,
        effort: entry.stepContract?.effort,
      });
    }

    if (macroNodes.length === 0) continue;

    // Generate a name from the shapes
    const name = `Auto: ${macroNodes.map((n) => n.taskShape.split(' ').slice(0, 2).join(' ')).join(' → ')}`;

    templates.push({
      id: `macro-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      name,
      nodes: macroNodes,
      occurrenceCount: count,
      avgSuccessRate: avgSuccess,
      proven: false,
    });
  }

  // Sort by occurrence count descending, then by success rate
  templates.sort((a, b) => b.occurrenceCount - a.occurrenceCount || b.avgSuccessRate - a.avgSuccessRate);

  return {
    templates,
    totalRuns: runs.length,
    totalEntries: entries.length,
  };
}

/**
 * Convert synthesized macro templates into trial lessons.
 */
export function macrosToLessons(
  projectId: string,
  templates: MacroTemplate[],
): string[] {
  const lessonIds: string[] = [];

  for (const t of templates) {
    const why = `macro:${t.nodes.map((n) => n.taskShape).join('→')}`;
    const existing = findLessonByPathology(projectId, 'macro', why);
    if (existing) {
      lessonIds.push(existing.id);
      continue;
    }

    const body = `Recurring pattern (${t.occurrenceCount}x, ${Math.round(t.avgSuccessRate * 100)}% success): ${t.nodes.map((n) => `${n.taskShape}(@${n.agentName})`).join(' → ')}`;
    const suggestion = `When the plan includes tasks matching [${t.nodes.map((n) => n.taskShape).join(', ')}], consider this as a reusable macro with agents [${t.nodes.map((n) => n.agentName).join(', ')}].`;

    const id = upsertLesson({
      projectId,
      where: 'macro',
      why,
      title: t.name,
      body,
      suggestion,
      provenance: 'learningLoop',
    });
    lessonIds.push(id);
  }

  return lessonIds;
}

/**
 * Build a macro context block for the manager dynamic context.
 * Lists synthesized macros as reusable patterns for generate_plan.
 */
export function buildMacroContext(templates: MacroTemplate[]): string {
  if (templates.length === 0) return '';

  const lines: string[] = ['Synthesized macros (recurring patterns — reuse when matching):'];

  for (const t of templates.slice(0, 10)) {
    const status = t.proven ? 'proven' : 'trial';
    lines.push(`- [${status}] ${t.name} (${t.occurrenceCount}x, ${Math.round(t.avgSuccessRate * 100)}% success)`);
  }

  return lines.join('\n');
}
