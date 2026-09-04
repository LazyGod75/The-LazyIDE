/* promptLearner.ts — Phase 9: Prompt Optimization Learner.
 *
 * Analyzes trace journal entries to learn which prompt patterns
 * (step descriptions) correlate with success or failure.
 * Proposes prompt modifications that pass through the eval gate.
 *
 * Metrics analyzed:
 *   - Prompt length vs success rate (too short → ambiguous, too long → diluted)
 *   - Keyword presence vs success (e.g. "test", "security", "error handling")
 *   - Prompt clarity score (heuristic: presence of specific file paths, acceptance criteria)
 */

import type { TraceEntry } from '../graph/traceJournal.js';
import { upsertLesson, findLessonByPathology } from './lessonStore.js';

// ── Types ──────────────────────────────────────────────────────────

export interface PromptProposal {
  /** The task shape this applies to. */
  taskShape: string;
  /** The issue found. */
  issue: 'too-short' | 'too-long' | 'missing-keyword' | 'missing-criteria';
  /** The keyword or pattern that's missing. */
  missingKeyword?: string;
  /** Success rate with better prompts (0-1). */
  successRate: number;
  /** Success rate with worse prompts (0-1). */
  baselineSuccessRate: number;
  /** Lift. */
  lift: number;
  /** Sample count. */
  sampleCount: number;
  /** Suggestion text. */
  suggestion: string;
}

export interface PromptLearnerResult {
  proposals: PromptProposal[];
  totalEntries: number;
}

// ── Heuristics ─────────────────────────────────────────────────────

const MIN_SAMPLE = 3;
const MIN_LIFT = 0.1;

/** Keywords that correlate with better outcomes when present. */
const POSITIVE_KEYWORDS = [
  'test', 'tests', 'spec', 'coverage',
  'error', 'handle', 'handling', 'retry',
  'security', 'validate', 'validation',
  'type', 'typesafe', 'interface',
  'document', 'docs', 'comment',
  'edge case', 'boundary',
];

/** Minimum prompt length (chars) for clarity. */
const MIN_PROMPT_LEN = 20;

/** Maximum prompt length before it becomes diluted. */
const MAX_PROMPT_LEN = 500;

function hasKeyword(prompt: string, keyword: string): boolean {
  return prompt.toLowerCase().includes(keyword);
}

function promptLength(prompt: string): number {
  return prompt.length;
}

function hasCriteria(prompt: string): boolean {
  const lower = prompt.toLowerCase();
  return lower.includes('should') || lower.includes('must') || lower.includes('expect') ||
    lower.includes('accept') || lower.includes('criterion') || lower.includes('criteria');
}

// ── Core learner ───────────────────────────────────────────────────

/**
 * Run the prompt learner on a set of trace entries.
 */
export function runPromptLearner(entries: TraceEntry[]): PromptLearnerResult {
  const taskEntries = entries.filter((e) => e.nodeKind === 'task' && e.nodeLabel);

  if (taskEntries.length < MIN_SAMPLE) {
    return { proposals: [], totalEntries: entries.length };
  }

  const proposals: PromptProposal[] = [];

  // 1. Analyze prompt length
  const shortPrompts = taskEntries.filter((e) => promptLength(e.nodeLabel) < MIN_PROMPT_LEN);
  const adequatePrompts = taskEntries.filter((e) => promptLength(e.nodeLabel) >= MIN_PROMPT_LEN && promptLength(e.nodeLabel) <= MAX_PROMPT_LEN);

  if (shortPrompts.length >= MIN_SAMPLE && adequatePrompts.length >= MIN_SAMPLE) {
    const shortSuccess = shortPrompts.filter((e) => e.outcome === 'success').length / shortPrompts.length;
    const adequateSuccess = adequatePrompts.filter((e) => e.outcome === 'success').length / adequatePrompts.length;
    const lift = adequateSuccess - shortSuccess;

    if (lift >= MIN_LIFT) {
      proposals.push({
        taskShape: 'all',
        issue: 'too-short',
        successRate: adequateSuccess,
        baselineSuccessRate: shortSuccess,
        lift,
        sampleCount: shortPrompts.length,
        suggestion: `Steps with short descriptions (<${MIN_PROMPT_LEN} chars) have ${Math.round(shortSuccess * 100)}% success vs ${Math.round(adequateSuccess * 100)}% for adequately described steps. Add more detail to step descriptions.`,
      });
    }
  }

  // 2. Analyze keyword presence
  for (const keyword of POSITIVE_KEYWORDS) {
    const withKeyword = taskEntries.filter((e) => hasKeyword(e.nodeLabel, keyword));
    const withoutKeyword = taskEntries.filter((e) => !hasKeyword(e.nodeLabel, keyword));

    if (withKeyword.length >= MIN_SAMPLE && withoutKeyword.length >= MIN_SAMPLE) {
      const withSuccess = withKeyword.filter((e) => e.outcome === 'success').length / withKeyword.length;
      const withoutSuccess = withoutKeyword.filter((e) => e.outcome === 'success').length / withoutKeyword.length;
      const lift = withSuccess - withoutSuccess;

      if (lift >= MIN_LIFT) {
        proposals.push({
          taskShape: 'all',
          issue: 'missing-keyword',
          missingKeyword: keyword,
          successRate: withSuccess,
          baselineSuccessRate: withoutSuccess,
          lift,
          sampleCount: withKeyword.length,
          suggestion: `Steps mentioning "${keyword}" have ${Math.round(withSuccess * 100)}% success vs ${Math.round(withoutSuccess * 100)}% without. Consider adding "${keyword}" to step descriptions where relevant.`,
        });
      }
    }
  }

  // 3. Analyze acceptance criteria presence
  const withCriteria = taskEntries.filter((e) => hasCriteria(e.nodeLabel));
  const withoutCriteria = taskEntries.filter((e) => !hasCriteria(e.nodeLabel));

  if (withCriteria.length >= MIN_SAMPLE && withoutCriteria.length >= MIN_SAMPLE) {
    const withSuccess = withCriteria.filter((e) => e.outcome === 'success').length / withCriteria.length;
    const withoutSuccess = withoutCriteria.filter((e) => e.outcome === 'success').length / withoutCriteria.length;
    const lift = withSuccess - withoutSuccess;

    if (lift >= MIN_LIFT) {
      proposals.push({
        taskShape: 'all',
        issue: 'missing-criteria',
        successRate: withSuccess,
        baselineSuccessRate: withoutSuccess,
        lift,
        sampleCount: withCriteria.length,
        suggestion: `Steps with explicit acceptance criteria (should/must/expect) have ${Math.round(withSuccess * 100)}% success vs ${Math.round(withoutSuccess * 100)}% without. Add acceptance criteria to step descriptions.`,
      });
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
 * Convert prompt proposals into trial lessons.
 */
export function promptProposalsToLessons(
  projectId: string,
  proposals: PromptProposal[],
): string[] {
  const lessonIds: string[] = [];

  for (const p of proposals) {
    const why = `prompt:${p.issue}:${p.missingKeyword ?? 'general'}`;
    const existing = findLessonByPathology(projectId, 'prompt', why);
    if (existing) {
      lessonIds.push(existing.id);
      continue;
    }

    const id = upsertLesson({
      projectId,
      where: 'prompt',
      why,
      title: `Prompt: ${p.issue}${p.missingKeyword ? ` (${p.missingKeyword})` : ''}`,
      body: p.suggestion,
      suggestion: p.suggestion,
      provenance: 'learningLoop',
    });
    lessonIds.push(id);
  }

  return lessonIds;
}
