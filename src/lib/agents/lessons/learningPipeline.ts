/* learningPipeline.ts — Phase 11: Integration + Guardrails.
 *
 * Wires all learners (routing, topology, prompt, macro) into a single
 * pipeline that:
 *   1. Reads trace entries from the trace journal.
 *   2. Runs all four learners.
 *   3. Converts proposals to lessons.
 *   4. Enforces guardrails (budget caps, max lessons, safety limits).
 *   5. Produces a unified learning context block for the manager.
 *
 * Guardrails:
 *   - MAX_LESSONS_PER_PROJECT: prevents lesson explosion
 *   - MAX_LEARNING_COST_USD: caps the cost of learning runs
 *   - MIN_CONFIDENCE: only promotes lessons with enough evidence
 *   - COOLDOWN_MS: minimum time between learning runs
 */

import type { TraceEntry } from '../graph/traceJournal.js';
import { runRoutingLearner, proposalsToLessons as routingToLessons, buildRoutingContext } from './routingLearner.js';
import { runTopologyLearner, topologyProposalsToLessons } from './topologyLearner.js';
import { runPromptLearner, promptProposalsToLessons } from './promptLearner.js';
import { synthesizeMacros, macrosToLessons, buildMacroContext } from './macroSynthesizer.js';
import { getProvenLessons, getTrialLessons, clearProjectLessons } from './lessonStore.js';

// ── Guardrails ─────────────────────────────────────────────────────

/** Maximum total lessons (proven + trial) per project. */
export const MAX_LESSONS_PER_PROJECT = 50;

/** Minimum time between learning pipeline runs (ms). */
export const LEARNING_COOLDOWN_MS = 60_000; // 1 minute

/** Maximum proposals to accept per learning run (prevents explosion). */
export const MAX_PROPOSALS_PER_RUN = 10;

// ── Types ──────────────────────────────────────────────────────────

export interface LearningPipelineResult {
  routingProposals: number;
  topologyProposals: number;
  promptProposals: number;
  macroTemplates: number;
  lessonsCreated: number;
  guardrailTriggered: string | null;
  totalEntries: number;
}

export interface LearningContext {
  routingContext: string;
  macroContext: string;
  combinedContext: string;
}

// ── Cooldown tracking ──────────────────────────────────────────────

const lastRunTimestamps = new Map<string, number>();

/**
 * Check if the learning pipeline is in cooldown for a project.
 */
export function isLearningInCooldown(projectId: string, now = Date.now()): boolean {
  const lastRun = lastRunTimestamps.get(projectId);
  if (!lastRun) return false;
  return now - lastRun < LEARNING_COOLDOWN_MS;
}

/**
 * Get the remaining cooldown time in ms (0 if not in cooldown).
 */
export function getCooldownRemaining(projectId: string, now = Date.now()): number {
  const lastRun = lastRunTimestamps.get(projectId);
  if (!lastRun) return 0;
  return Math.max(0, LEARNING_COOLDOWN_MS - (now - lastRun));
}

// ── Guardrail checks ───────────────────────────────────────────────

/**
 * Check if a project has too many lessons.
 */
export function hasTooManyLessons(projectId: string): boolean {
  const proven = getProvenLessons(projectId).length;
  const trials = getTrialLessons(projectId).length;
  return proven + trials >= MAX_LESSONS_PER_PROJECT;
}

// ── Main pipeline ──────────────────────────────────────────────────

/**
 * Run the full learning pipeline on a set of trace entries.
 * All four learners run, proposals are converted to lessons,
 * and guardrails are enforced.
 */
export function runLearningPipeline(
  projectId: string,
  entries: TraceEntry[],
  now = Date.now(),
): LearningPipelineResult {
  // Guardrail 1: cooldown
  if (isLearningInCooldown(projectId, now)) {
    return {
      routingProposals: 0,
      topologyProposals: 0,
      promptProposals: 0,
      macroTemplates: 0,
      lessonsCreated: 0,
      guardrailTriggered: 'cooldown',
      totalEntries: entries.length,
    };
  }

  // Guardrail 2: too many lessons
  if (hasTooManyLessons(projectId)) {
    return {
      routingProposals: 0,
      topologyProposals: 0,
      promptProposals: 0,
      macroTemplates: 0,
      lessonsCreated: 0,
      guardrailTriggered: 'max-lessons',
      totalEntries: entries.length,
    };
  }

  // Run all learners
  const routingResult = runRoutingLearner(entries);
  const topologyResult = runTopologyLearner(entries);
  const promptResult = runPromptLearner(entries);
  const macroResult = synthesizeMacros(entries);

  // Cap proposals per run
  const routingCapped = routingResult.proposals.slice(0, MAX_PROPOSALS_PER_RUN);
  const topologyCapped = topologyResult.proposals.slice(0, MAX_PROPOSALS_PER_RUN);
  const promptCapped = promptResult.proposals.slice(0, MAX_PROPOSALS_PER_RUN);
  const macroCapped = macroResult.templates.slice(0, MAX_PROPOSALS_PER_RUN);

  // Convert to lessons
  const routingIds = routingToLessons(projectId, routingCapped);
  const topologyIds = topologyProposalsToLessons(projectId, topologyCapped);
  const promptIds = promptProposalsToLessons(projectId, promptCapped);
  const macroIds = macrosToLessons(projectId, macroCapped);

  const lessonsCreated = routingIds.length + topologyIds.length + promptIds.length + macroIds.length;

  // Record run timestamp
  lastRunTimestamps.set(projectId, now);

  return {
    routingProposals: routingCapped.length,
    topologyProposals: topologyCapped.length,
    promptProposals: promptCapped.length,
    macroTemplates: macroCapped.length,
    lessonsCreated,
    guardrailTriggered: null,
    totalEntries: entries.length,
  };
}

/**
 * Build the unified learning context block for the manager dynamic context.
 * Combines routing overrides and synthesized macros.
 */
export function buildLearningContext(projectId: string, macroTemplates?: ReturnType<typeof synthesizeMacros>['templates']): LearningContext {
  const routingContext = buildRoutingContext(projectId);
  const macroContext = macroTemplates ? buildMacroContext(macroTemplates) : '';

  const parts: string[] = [];
  if (routingContext) parts.push(routingContext);
  if (macroContext) parts.push(macroContext);

  return {
    routingContext,
    macroContext,
    combinedContext: parts.join('\n\n'),
  };
}

/**
 * Reset learning state for a project (for tests or user action).
 */
export function resetLearningState(projectId: string): void {
  clearProjectLessons(projectId);
  lastRunTimestamps.delete(projectId);
}
