/* brainNotation.ts — Brain Notation Engine (Pillar D).
   The single point where the orchestrator writes into the Brain.
   Every mission outcome, decision, diagnosis, pattern, provisioning recipe
   and agent template is captured here so the Brain can feed future
   decisions. Fire-and-forget: never blocks the UI, never throws.
*/

import { getPlatform } from '../platform/index.js';
import type { CaptureEvent, InsightPayload } from '../platform/types.js';
import type { MissionOutcome, DecisionPattern, Mission } from './types.js';
import { projectIdFromRoot } from '../journal/projectId.js';
import { scheduleSidecarReloadAfterStore } from './sidecarReload.js';

// ── Types ─────────────────────────────────────────────────────────

export interface BrainNotationConfig {
  /** Minimum confidence before a decision pattern is persisted. */
  minPatternConfidence?: number;
}

// Neuron categories we emit (stored in tags; CaptureEvent.kind stays within
// the existing union for Brain-side compatibility).
export type BrainNeuronKind =
  | 'outcome.success'
  | 'outcome.failure'
  | 'outcome.partial'
  | 'decision.user'
  | 'decision.manager'
  | 'diagnosis'
  | 'pattern'
  | 'provisioning.recipe'
  | 'agent.template'
  | 'lazyreasoning.fsm'
  | 'lazyreasoning.monitor'
  | 'lazyreasoning.etrace-e1'
  | 'lazyreasoning.etrace-e2'
  | 'lazyreasoning.etrace-e3';

// ── Internal dispatcher ───────────────────────────────────────────

function dispatch(event: CaptureEvent): void {
  const platform = getPlatform();
  if (!platform?.brain?.capture) {
    console.warn('[brainNotation] no brain capture platform available');
    return;
  }

  platform.brain
    .capture(event)
    .then(() => {
      // B41: agent store writes are outside auto-index — reload the warm
      // sidecar so the next recall sees the note that just landed.
      scheduleSidecarReloadAfterStore();
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn('[brainNotation] capture failed:', event.title, msg);
    });
}

function buildInsight(kind: BrainNeuronKind, title: string, description: string): InsightPayload {
  return {
    kind,
    title,
    description,
    actionable: kind !== 'outcome.success',
  };
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Note a mission outcome in the Brain after the mission terminates.
 * This is the foundational learning hook: every success/failure is recorded.
 */
export function noteMissionOutcome(outcome: MissionOutcome, projectRoot?: string): void {
  const statusToKind: Record<string, BrainNeuronKind> = {
    done: 'outcome.success',
    failed: 'outcome.failure',
    cancelled: 'outcome.partial',
    review: 'outcome.partial',
    queued: 'outcome.partial',
    running: 'outcome.partial',
  };

  const kind = statusToKind[outcome.status] ?? 'outcome.partial';
  const lines = [
    `Mission: ${outcome.title}`,
    `Project: ${outcome.projectId}`,
    `Model: ${outcome.model}`,
    `Status: ${outcome.status}`,
    outcome.durationMs ? `Duration: ${Math.round(outcome.durationMs / 1000)}s` : '',
    outcome.costCents ? `Cost: ${(outcome.costCents / 100).toFixed(2)} USD` : '',
    outcome.errorCategory ? `Error category: ${outcome.errorCategory}` : '',
    outcome.errorMessage ? `Error: ${outcome.errorMessage.slice(0, 500)}` : '',
    outcome.diffStats
      ? `Diff: +${outcome.diffStats.linesAdded} -${outcome.diffStats.linesRemoved} (${outcome.diffStats.filesChanged} files)`
      : '',
    outcome.testResults ? `Tests: ${outcome.testResults.passed} passed, ${outcome.testResults.failed} failed` : '',
    outcome.learningInsights?.length ? `Learning: ${outcome.learningInsights.join(' | ')}` : '',
  ].filter(Boolean);

  const event: CaptureEvent = {
    kind: 'agent',
    title: `Outcome ${outcome.status}: ${outcome.title}`,
    text: lines.join('\n'),
    tags: [kind, 'mission-outcome', `status:${outcome.status}`, `project:${outcome.projectId}`, `model:${outcome.model}`],
    source: 'lazy-ide:orchestrator',
    space: 'code',
    topic: outcome.projectId,
    cwd: projectRoot,
  };

  dispatch(event);
}

/**
 * Note a user decision (answer to a mission question, approval, etc.).
 */
export function noteUserDecision(question: string, answer: string, context: Record<string, unknown>, projectRoot?: string): void {
  const event: CaptureEvent = {
    kind: 'learning',
    title: `Decision user: ${question.slice(0, 80)}`,
    text: [`Q: ${question}`, `A: ${answer}`, `Context: ${JSON.stringify(context, null, 2).slice(0, 600)}`].join('\n\n'),
    tags: ['decision.user', 'orchestrator'],
    source: 'lazy-ide:orchestrator',
    space: 'code',
    topic: context.projectId as string | undefined,
    cwd: projectRoot,
  };

  dispatch(event);
}

/**
 * Note a manager decision with its rationale and observed outcome.
 */
export function noteManagerDecision(action: string, rationale: string, observedOutcome: string, projectRoot?: string): void {
  const event: CaptureEvent = {
    kind: 'learning',
    title: `Decision manager: ${action.slice(0, 80)}`,
    text: [`Action: ${action}`, `Rationale: ${rationale}`, `Outcome: ${observedOutcome}`].join('\n\n'),
    tags: ['decision.manager', 'orchestrator'],
    source: 'lazy-ide:orchestrator',
    space: 'code',
    topic: undefined,
    cwd: projectRoot,
  };

  dispatch(event);
}

/**
 * Note a diagnosis in the Brain so similar future errors can be resolved faster.
 */
export interface NoteDiagnosisParams {
  errorCategory: string;
  rootCause: string;
  suggestedFix: string;
  confidence: number;
  projectRoot?: string;
}

export function noteDiagnosis({ errorCategory, rootCause, suggestedFix, confidence, projectRoot }: NoteDiagnosisParams): void {
  const event: CaptureEvent = {
    kind: 'learning',
    title: `Diagnosis: ${errorCategory}`,
    text: [
      `Category: ${errorCategory}`,
      `Root cause: ${rootCause}`,
      `Suggested fix: ${suggestedFix}`,
      `Confidence: ${Math.round(confidence * 100)}%`,
    ].join('\n'),
    tags: ['diagnosis', `category:${errorCategory}`, 'orchestrator'],
    source: 'lazy-ide:orchestrator',
    space: 'code',
    topic: errorCategory,
    cwd: projectRoot,
  };

  dispatch(event);
}

/**
 * Note a learned decision pattern in the Brain.
 */
export function noteDecisionPattern(pattern: DecisionPattern, projectRoot?: string): void {
  const event: CaptureEvent = {
    kind: 'learning',
    title: `Pattern: ${pattern.trigger.slice(0, 80)}`,
    text: [
      `Trigger: ${pattern.trigger}`,
      `Action: ${pattern.action}`,
      `Outcome: ${pattern.outcome}`,
      `Confidence: ${Math.round(pattern.confidence * 100)}%`,
      `Occurrences: ${pattern.occurrences}`,
      pattern.projectId ? `Project: ${pattern.projectId}` : '',
      pattern.agentName ? `Agent: ${pattern.agentName}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    tags: ['pattern', `outcome:${pattern.outcome}`, 'orchestrator'],
    source: 'lazy-ide:orchestrator',
    space: 'code',
    topic: pattern.projectId,
    cwd: projectRoot,
  };

  dispatch(event);
}

/**
 * Note a friction-mining analysis run in the Brain (Pillar D5 v1 — see
 * frictionAnalysis.ts's `runFrictionAnalysis`). One note per run, tagged
 * with the TOP-severity candidate's `where`/`why` (machine-readable
 * pathology location/cause) so a later recall can filter by either axis;
 * the note body lists every candidate found, not just the top one. No-op
 * (never dispatches an empty note) when `candidates` is empty.
 */
export function noteFrictionAnalysis(
  candidates: ReadonlyArray<{ title: string; rationale: string; where: string; why: string; severity: string }>,
  projectId: string,
  projectRoot?: string,
): void {
  if (candidates.length === 0) return;
  const top = candidates[0];
  const lines = candidates.map((c) => `- [${c.severity}] ${c.title}: ${c.rationale}`);

  const event: CaptureEvent = {
    kind: 'learning',
    title: `Friction analysis: ${projectId}`,
    text: [`Project: ${projectId}`, `Candidates: ${candidates.length}`, '', ...lines].join('\n'),
    tags: ['friction-mining', `pathology:${top.why}`, `where:${top.where}`, 'orchestrator'],
    source: 'lazy-ide:orchestrator',
    space: 'code',
    topic: projectId,
    cwd: projectRoot,
  };

  dispatch(event);
}

/**
 * Note a successful provisioning recipe in the Brain.
 */
export function noteProvisioningRecipe(service: string, provider: string, config: Record<string, unknown>, projectRoot?: string): void {
  const event: CaptureEvent = {
    kind: 'learning',
    title: `Provisioning recipe: ${service} (${provider})`,
    text: [
      `Service: ${service}`,
      `Provider: ${provider}`,
      `Config: ${JSON.stringify(config, null, 2).slice(0, 800)}`,
    ].join('\n'),
    tags: ['provisioning.recipe', `service:${service}`, `provider:${provider}`, 'orchestrator'],
    source: 'lazy-ide:orchestrator',
    space: 'code',
    topic: service,
    cwd: projectRoot,
  };

  dispatch(event);
}

/**
 * Note a reusable agent template in the Brain.
 */
export function noteAgentTemplate(name: string, template: Record<string, unknown>, sourceMission: Mission, projectRoot?: string): void {
  const event: CaptureEvent = {
    kind: 'learning',
    title: `Agent template: ${name}`,
    text: [
      `Name: ${name}`,
      `Source mission: ${sourceMission.title} (${sourceMission.id})`,
      `Template: ${JSON.stringify(template, null, 2).slice(0, 800)}`,
    ].join('\n'),
    tags: ['agent.template', 'orchestrator'],
    source: 'lazy-ide:orchestrator',
    space: 'code',
    topic: sourceMission.agentName,
    cwd: projectRoot,
  };

  dispatch(event);
}

/**
 * Convenience: build a MissionOutcome from a Mission and optional metrics.
 */
export function missionToOutcome(mission: Mission, projectId: string): MissionOutcome {
  return {
    missionId: mission.id,
    projectId,
    title: mission.title,
    agentName: mission.agentName,
    model: mission.model,
    status: mission.status,
    durationMs: undefined,
    costCents: mission.agentMetrics?.costUsd ? Math.round(mission.agentMetrics.costUsd * 100) : undefined,
    errorMessage: mission.statusReason,
    diffStats: mission.diffAdded !== undefined || mission.diffRemoved !== undefined ? {
      filesChanged: mission.diffFiles?.length ?? 0,
      linesAdded: mission.diffAdded ?? 0,
      linesRemoved: mission.diffRemoved ?? 0,
    } : undefined,
    testResults: mission.judgeVerdict?.tests,
    timestamp: Date.now(),
  };
}

/**
 * Resolve a project id from a project root when possible.
 */
export function resolveProjectIdForNotation(projectRoot: string | undefined): string | undefined {
  if (!projectRoot) return undefined;
  try {
    return projectIdFromRoot(projectRoot);
  } catch {
    return undefined;
  }
}

/**
 * Note a LazyReasoningBlocks FSM state transition in the Brain.
 * Captures the difficulty state and step score for future pattern analysis.
 */
export function noteLazyReasoningFSM(
  missionId: string,
  fromState: string,
  toState: string,
  stepScore: number,
  step: number,
  projectRoot?: string,
): void {
  const event: CaptureEvent = {
    kind: 'learning',
    title: `LR-FSM: ${fromState} → ${toState} (step ${step})`,
    text: [
      `Mission: ${missionId}`,
      `Transition: ${fromState} → ${toState}`,
      `Step score: ${stepScore.toFixed(3)}`,
      `Step: ${step}`,
    ].join('\n'),
    tags: ['lazyreasoning:fsm', `state:${toState}`, `mission:${missionId}`, 'orchestrator'],
    source: 'lazy-ide:lazyreasoningblocks',
    space: 'code',
    cwd: projectRoot,
  };

  dispatch(event);
}

/**
 * Note a LazyReasoningBlocks monitor firing in the Brain.
 * Captures which monitor fired, its score, and the intervention text
 * so future E-trace retrieval can find patterns.
 */
export function noteLazyReasoningMonitor(
  missionId: string,
  monitorName: string,
  score: number,
  composite: number,
  intervention: string,
  projectRoot?: string,
): void {
  const event: CaptureEvent = {
    kind: 'learning',
    title: `LR-Monitor: ${monitorName} fired (score ${score.toFixed(2)})`,
    text: [
      `Mission: ${missionId}`,
      `Monitor: ${monitorName}`,
      `Score: ${score.toFixed(3)}`,
      `Composite: ${composite.toFixed(3)}`,
      `Intervention: ${intervention}`,
    ].join('\n'),
    tags: ['lazyreasoning:monitor', `monitor:${monitorName}`, `mission:${missionId}`, 'orchestrator'],
    source: 'lazy-ide:lazyreasoningblocks',
    space: 'code',
    topic: monitorName,
    cwd: projectRoot,
  };

  dispatch(event);
}

/**
 * Note a LazyReasoningBlocks E-trace in the Brain.
 * E1 = instance-level (project-scoped), E2 = pattern-level (failure-mode),
 * E3 = universal rules. Stored with distinct tags for retrieval.
 */
export function noteLazyReasoningETrace(
  tier: 'e1' | 'e2' | 'e3',
  missionId: string,
  text: string,
  failureType?: string,
  projectId?: string,
  projectRoot?: string,
): void {
  const tagMap = {
    e1: 'lazyreasoning:etrace-e1',
    e2: 'lazyreasoning:etrace-e2',
    e3: 'lazyreasoning:etrace-e3',
  } as const;

  const tags = [tagMap[tier], `mission:${missionId}`, 'orchestrator'];
  if (failureType) tags.push(`failure:${failureType}`);
  if (projectId) tags.push(`project:${projectId}`);

  const event: CaptureEvent = {
    kind: 'learning',
    title: `LR-ETrace-${tier}: ${failureType ?? 'general'}`,
    text,
    tags,
    source: 'lazy-ide:lazyreasoningblocks',
    space: 'code',
    topic: projectId ?? failureType,
    cwd: projectRoot,
  };

  dispatch(event);
}

export { buildInsight };
