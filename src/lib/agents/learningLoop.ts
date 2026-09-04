/* learningLoop.ts — Post-completion learning loop for LazyBrain.
   After each mission completes, this module analyzes the results and
   feeds insights back to the brain, creating a continuous improvement cycle.

   This is Lazy's unique differentiator: the brain learns from every mission,
   and future missions are adapted based on that learning.

   Inspired by Millrace's learning plane concept — deeply integrated with
   LazyBrain's capture and recall system.
*/

import type { CaptureEvent } from '../platform/types.js';
import type { Mission, JudgeVerdict, AgentMetrics } from '../agents/types.js';
import type { CompiledPlan, PlanAdaptation } from './stageContract.js';
import { captureAgentMission, captureRawEvent } from '../brain/capture.js';
import { formatVerdictScoreLine } from './evaluator.js';
import { upsertLesson } from './lessons/lessonStore.js';
import { diagnose } from './diagnosisEngine.js';
import type { MissionOutcome } from './types.js';
import type { TFunc } from './runtime.js';

// ── Types ─────────────────────────────────────────────────────────

export type InsightKind =
  | 'success_pattern'
  | 'failure_pattern'
  | 'test_insight'
  | 'security_insight'
  | 'performance_insight'
  | 'brain_adaptation'
  | 'workflow_suggestion';

export interface LearningInsight {
  id: string;
  kind: InsightKind;
  title: string;
  description: string;
  actionable: boolean;
  suggestion?: string;
  createdAt: string;
}

export interface LearningResult {
  insights: LearningInsight[];
  brainCaptured: boolean;
  summary: string;
}

// ── Insight generation ────────────────────────────────────────────

function analyzeVerdict(verdict: JudgeVerdict | undefined, mission: Mission, t?: TFunc): LearningInsight[] {
  if (!verdict) return [];
  const insights: LearningInsight[] = [];
  const score = formatVerdictScoreLine(verdict, 'indisponible');

  if (verdict.passed) {
    insights.push({
      id: `insight-success-${Date.now()}`,
      kind: 'success_pattern',
      title: t ? t('agents.learningLoop.missionSucceeded.title') : 'Mission réussie',
      // R13 — same shared scoreUnavailable rule as nodeChrome.tsx (R11): a
      // heuristic text-fallback "approve" verdict with no real score
      // (R11's judge-score-honesty gap) must never be captured into a
      // brain insight as a fabricated "Score: 0".
      description: t
        ? t('agents.learningLoop.missionSucceeded.description', { score })
        : `Le workflow a produit un résultat approuvé par le juge. Score: ${score}.`,
      actionable: false,
      createdAt: new Date().toISOString(),
    });
    // First-time success pattern: capture HOW the agent succeeded so future agents can replicate
    const timeline = mission.actionTimeline ?? [];
    const toolCalls = timeline.filter((e) => e.text && e.text.match(/^\[\d+\]/));
    if (toolCalls.length > 0) {
      const stepSummary = toolCalls.slice(0, 10).map((e) => e.text).join('; ');
      const truncatedTitle = mission.title.slice(0, 60);
      const truncatedSteps500 = stepSummary.slice(0, 500);
      const truncatedSteps200 = stepSummary.slice(0, 200);
      insights.push({
        id: `insight-howto-${Date.now()}`,
        kind: 'success_pattern',
        title: t
          ? t('agents.learningLoop.howToSucceed.title', { title: truncatedTitle })
          : `Comment réussir: ${truncatedTitle}`,
        description: t
          ? t('agents.learningLoop.howToSucceed.description', { count: toolCalls.length, steps: truncatedSteps500 })
          : `Étapes qui ont mené au succès (${toolCalls.length} actions): ${truncatedSteps500}`,
        actionable: false,
        suggestion: t
          ? t('agents.learningLoop.howToSucceed.suggestion', { steps: truncatedSteps200 })
          : `Pour les futures missions similaires, suivre ces étapes: ${truncatedSteps200}`,
        createdAt: new Date().toISOString(),
      });
    }
  } else {
    insights.push({
      id: `insight-failure-${Date.now()}`,
      kind: 'failure_pattern',
      title: t ? t('agents.learningLoop.needsImprovement.title') : 'Mission nécessite des améliorations',
      description: t
        ? t('agents.learningLoop.needsImprovement.description', { score, roles: verdict.reviewers.map((r) => r.role).join(', ') })
        : `Le juge a demandé des corrections. Score: ${score}. Points d'attention: ${verdict.reviewers.map((r) => r.role).join(', ')}.`,
      actionable: true,
      suggestion: t
        ? t('agents.learningLoop.needsImprovement.suggestion')
        : 'Considérer un stage de fix supplémentaire ou un prompt plus détaillé pour l\'agent.',
      createdAt: new Date().toISOString(),
    });
  }

  const tester = verdict.reviewers.find((r) => r.role === 'tester');
  if (tester && tester.verdict !== 'approve') {
    insights.push({
      id: `insight-test-${Date.now()}`,
      kind: 'test_insight',
      title: t ? t('agents.learningLoop.testPoints.title') : 'Points de test identifiés',
      description: tester.summary,
      actionable: true,
      suggestion: t
        ? t('agents.learningLoop.testPoints.suggestion')
        : 'Renforcer les tests pour ce type de tâche dans les futures missions.',
      createdAt: new Date().toISOString(),
    });
  }

  const security = verdict.reviewers.find((r) => r.role === 'security');
  if (security && security.verdict !== 'approve') {
    insights.push({
      id: `insight-security-${Date.now()}`,
      kind: 'security_insight',
      title: t ? t('agents.learningLoop.securityConcern.title') : 'Préoccupation de sécurité',
      description: security.summary,
      actionable: true,
      suggestion: t
        ? t('agents.learningLoop.securityConcern.suggestion')
        : 'Le brain devrait mémoriser ce pattern de sécurité pour les futures missions similaires.',
      createdAt: new Date().toISOString(),
    });
  }

  return insights;
}

function analyzeMetrics(metrics: AgentMetrics | undefined, t?: TFunc): LearningInsight[] {
  if (!metrics) return [];
  const insights: LearningInsight[] = [];

  if (metrics.durationMs > 120_000) {
    const seconds = (metrics.durationMs / 1000).toFixed(1);
    insights.push({
      id: `insight-perf-${Date.now()}`,
      kind: 'performance_insight',
      title: t ? t('agents.learningLoop.longMission.title') : 'Mission longue',
      description: t
        ? t('agents.learningLoop.longMission.description', { seconds })
        : `Durée: ${seconds}s. Considérer optimiser le workflow ou diviser la tâche.`,
      actionable: true,
      suggestion: t
        ? t('agents.learningLoop.longMission.suggestion')
        : 'Diviser les grandes tâches en sous-missions plus ciblées.',
      createdAt: new Date().toISOString(),
    });
  }

  if (metrics.toolCount > 50) {
    insights.push({
      id: `insight-tools-${Date.now()}`,
      kind: 'performance_insight',
      title: t ? t('agents.learningLoop.heavyToolUse.title') : 'Utilisation intensive d\'outils',
      description: t
        ? t('agents.learningLoop.heavyToolUse.description', { count: metrics.toolCount })
        : `${metrics.toolCount} appels d'outils. L'agent a beaucoup exploré — le brain pourrait aider à cibler mieux.`,
      actionable: true,
      suggestion: t
        ? t('agents.learningLoop.heavyToolUse.suggestion')
        : 'Enrichir le brain avec plus de contexte sur cette zone du code pour réduire l\'exploration.',
      createdAt: new Date().toISOString(),
    });
  }

  return insights;
}

function analyzeAdaptations(adaptations: PlanAdaptation[], t?: TFunc): LearningInsight[] {
  return adaptations.map((a) => ({
    id: `insight-adapt-${a.kind}-${Date.now()}`,
    kind: 'brain_adaptation' as InsightKind,
    title: t ? t('agents.learningLoop.brainAdaptation.title') : 'Adaptation du brain appliquée',
    description: a.reason,
    actionable: false,
    createdAt: new Date().toISOString(),
  }));
}

function generateWorkflowSuggestion(
  _mission: Mission,
  insights: LearningInsight[],
  t?: TFunc,
): LearningInsight | null {
  const failures = insights.filter((i) => i.kind === 'failure_pattern' || i.kind === 'test_insight');
  if (failures.length === 0) return null;

  return {
    id: `insight-workflow-${Date.now()}`,
    kind: 'workflow_suggestion',
    title: t ? t('agents.learningLoop.workflowSuggestion.title') : 'Amélioration de workflow suggérée',
    description: t
      ? t('agents.learningLoop.workflowSuggestion.description')
      : `Basé sur cette mission et les patterns similaires dans le brain, le workflow pourrait être amélioré en ajoutant un stage de validation plus tôt dans le processus.`,
    actionable: true,
    suggestion: t
      ? t('agents.learningLoop.workflowSuggestion.suggestion')
      : 'Le plan compiler utilisera cette connaissance pour les futures missions similaires.',
    createdAt: new Date().toISOString(),
  };
}

// ── Brain capture ─────────────────────────────────────────────────

function captureToBrain(mission: Mission, insights: LearningInsight[]): boolean {
  try {
    const summary = insights.map((i) => `[${i.kind}] ${i.title}: ${i.description}`).join('\n');
    const timeline = (mission.actionTimeline ?? []).slice(-20).map((e) => e.text).join('\n');
    const text = [
      `Mission: ${mission.title}`,
      `Status: ${mission.status}`,
      `Verdict: ${mission.judgeVerdict?.passed ? 'approved' : 'rejected'}`,
      `Score: ${mission.judgeVerdict ? formatVerdictScoreLine(mission.judgeVerdict, 'N/A') : 'N/A'}`,
      `Agent: ${mission.agentName ?? 'default'}`,
      '',
      `Insights: ${insights.length} généré(s)`,
      '',
      `Action timeline (last 20):`,
      timeline,
    ].join('\n');

    const event: CaptureEvent = {
      kind: 'learning',
      title: `Learning: ${mission.title}`,
      text,
      // mission:<id> lets a give-up (captureQueue.ts's announceGiveUp) and a
      // future backfill pass correlate this note back to its mission — same
      // tag convention captureSkillNote below already uses.
      tags: ['agent', 'mission', 'learning', `mission:${mission.id}`, ...insights.map((i) => i.kind)],
      source: 'lazy-ide:learning-loop',
      space: 'code',
      insights: insights.map((i) => ({
        kind: i.kind,
        title: i.title,
        description: i.description,
        actionable: i.actionable,
        suggestion: i.suggestion,
      })),
    };

    // Routed through capture.ts's shared dispatch pipeline (retry with
    // backoff + brain.capture_failed give-up signal) instead of calling
    // platform.brain.capture() directly — a direct call here used to mean a
    // failure was only ever a console.warn, with no retry and no durable
    // trail (see this fix's report for the M52/M53 investigation this closes).
    captureRawEvent(event);

    // Also use the existing capture helper for the mission record.
    // upsertIfRicher: true — this call reuses the SAME `Mission: ${title}`
    // id the kickoff capture (agentsStore.tsx's addMission) already wrote,
    // sparse, at launch. Without this flag the engine store rejects the
    // write as a duplicate id and dispatch()'s isConflictError handling
    // treats that rejection as success-equivalent — silently dropping this
    // richer completion text forever. See capture.ts's captureAgentMission
    // doc comment and engine/src/store/upsert.ts for the replace-if-richer
    // rule this enables.
    captureAgentMission(
      mission.title,
      `Learning insights: ${insights.length} generated. ${summary.slice(0, 200)}`,
      mission.model,
      mission.worktree ?? '',
      { upsertIfRicher: true },
    );

    return true;
  } catch (err) {
    console.warn('[learningLoop] Failed to capture to brain:', err);
    return false;
  }
}

// ── Skill-shaped memory (Pillar D5 v1 — additive) ────────────────────
//
// ANTI-POISONING CONSTRAINT: a skill note is written ONLY on a real PASS —
// `verdict.passed === true` AND `verdict.scoreUnavailable` is NOT true
// (never on a heuristic text-fallback "approve" with no real score — see
// JudgeVerdict.scoreUnavailable's own doc comment, agents/types.ts — and
// never below SKILL_CAPTURE_MIN_SCORE). This is deterministic v1: no new
// LLM call distills the note (an LLM-written distillation is v2's job).
// Revocation (a mission that merges now but is `git revert`ed LATER —
// journal's mission.reverted{merged:true}, see frictionMiner.ts's own
// mining of that same event for the pathology side of this gap) is NOT
// knowable at THIS capture time — captureSkillNote runs right after the
// mission completes, before any later revert can exist — so auditing/
// retracting an already-written skill note after a subsequent revert is
// v2's job, not this module's.

/** No existing shared judge-pass-floor constant was found in evaluator.ts
 *  or agents/types.ts (only the per-reviewer VerdictOutcome/inconclusive
 *  fields) — this is a new, conservative v1 threshold for skill-note
 *  capture specifically, distinct from (and stricter than) JudgeVerdict.
 *  passed's own bar. */
const SKILL_CAPTURE_MIN_SCORE = 70;

/** Mirrors runtime.ts's own `classifyMissionModel` (OpenRouter/managed ids
 *  always carry a '/', native Anthropic ids never do) — reimplemented here
 *  rather than imported to avoid a runtime.ts <-> learningLoop.ts import
 *  cycle (runtime.ts calls into this module after every mission). */
function classifyEngine(model: string): 'managed' | 'native' {
  return model.includes('/') ? 'managed' : 'native';
}

function buildSkillNoteBody(mission: Mission, verdict: JudgeVerdict): string {
  const approach = (mission.actionTimeline ?? []).slice(-10).map((e) => e.text).join('\n');
  const files = (mission.diffFiles ?? []).map((f) => f.filename).join(', ');
  return [
    `WHAT worked: ${mission.title}`,
    files ? `Files touched: ${files}` : '',
    approach ? `Approach:\n${approach}` : '',
    `WHEN to reuse: task shaped like "${(mission.agentTask ?? mission.title).slice(0, 200)}"`,
    `Provenance: mission ${mission.id}, agent ${mission.agentName ?? 'default'}, score ${verdict.score}/100`,
  ]
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Writes ONE structured skill note to the brain, capturing WHAT worked and
 * WHEN to reuse it — additive alongside captureToBrain's existing mission
 * summary note, never a replacement for it. No-op (never dispatches) when
 * the anti-poisoning guard above isn't satisfied.
 */
function captureSkillNote(mission: Mission, verdict: JudgeVerdict | undefined): void {
  if (!verdict || !verdict.passed || verdict.scoreUnavailable) return;
  if (verdict.score < SKILL_CAPTURE_MIN_SCORE) return;

  const confidence = verdict.score >= 90 ? 'high' : 'medium';
  const engine = classifyEngine(mission.model);

  const event: CaptureEvent = {
    kind: 'learning',
    title: `Skill: ${mission.title.slice(0, 80)}`,
    text: buildSkillNoteBody(mission, verdict),
    tags: ['skill', `confidence:${confidence}`, `engine:${engine}`, `mission:${mission.id}`],
    source: 'lazy-ide:learning-loop',
    space: 'code',
  };

  // Same rationale as captureToBrain above: route through the shared
  // retry/give-up pipeline instead of a bare platform.brain.capture() call.
  captureRawEvent(event);
}

function emitTrialLessons(mission: Mission, insights: LearningInsight[]): void {
  const projectId = mission.worktree ?? mission.id;
  for (const insight of insights) {
    if (insight.kind === 'failure_pattern' && insight.actionable) {
      upsertLesson({
        projectId,
        where: 'mission:post-completion',
        why: insight.title.slice(0, 60).toLowerCase().replace(/\s+/g, '-'),
        title: insight.title,
        body: insight.description,
        suggestion: insight.suggestion,
        evidenceMissionIds: [mission.id],
        provenance: 'learningLoop',
      });
    } else if (insight.kind === 'workflow_suggestion' && insight.suggestion) {
      upsertLesson({
        projectId,
        where: 'workflow:suggestion',
        why: insight.title.slice(0, 60).toLowerCase().replace(/\s+/g, '-'),
        title: insight.title,
        body: insight.description,
        suggestion: insight.suggestion,
        evidenceMissionIds: [mission.id],
        provenance: 'learningLoop',
      });
    }
  }
}

// ── Public API ────────────────────────────────────────────────────

export function generateInsights(
  mission: Mission,
  plan?: CompiledPlan,
  t?: TFunc,
): LearningInsight[] {
  const insights: LearningInsight[] = [];

  insights.push(...analyzeVerdict(mission.judgeVerdict, mission, t));
  insights.push(...analyzeMetrics(mission.agentMetrics, t));
  if (plan?.adaptations) {
    insights.push(...analyzeAdaptations(plan.adaptations, t));
  }

  const workflowSuggestion = generateWorkflowSuggestion(mission, insights, t);
  if (workflowSuggestion) insights.push(workflowSuggestion);

  return insights;
}

export async function runLearningLoop(
  mission: Mission,
  plan?: CompiledPlan,
  t?: TFunc,
): Promise<LearningResult> {
  const insights = generateInsights(mission, plan, t);

  // Phase 4: On failure, run LLM-driven diagnosis for structured root-cause analysis
  if (mission.status === 'failed' || mission.status === 'cancelled') {
    try {
      const outcome: MissionOutcome = {
        missionId: mission.id,
        projectId: mission.worktree ?? mission.id,
        title: mission.title,
        agentName: mission.agentName,
        model: mission.model,
        status: mission.status,
        errorMessage: mission.statusReason,
        timestamp: Date.now(),
      };
      const diagnosis = await diagnose(outcome, mission.worktree);
      insights.push({
        id: `insight-diagnosis-${Date.now()}`,
        kind: 'failure_pattern',
        title: `Root cause: ${diagnosis.category}`,
        description: diagnosis.rootCause,
        actionable: true,
        suggestion: diagnosis.suggestedFix,
        createdAt: new Date().toISOString(),
      });
    } catch {
      // Diagnosis failure is non-fatal — insights from generateInsights still captured
    }
  }

  const brainCaptured = captureToBrain(mission, insights);
  captureSkillNote(mission, mission.judgeVerdict);
  emitTrialLessons(mission, insights);

  const summary = insights.length > 0
    ? `${insights.length} insight${insights.length > 1 ? 's' : ''} généré${insights.length > 1 ? 's' : ''} et ${brainCaptured ? 'capturé' : 'non capturé'} dans le brain`
    : 'Aucun insight spécifique — mission sans particularités notables';

  return { insights, brainCaptured, summary };
}

/**
 * Generate a human-readable, marketing-style summary of the learning loop.
 * No raw numbers — focuses on the continuous improvement narrative.
 * Translated via `t` when supplied — falls back to the ORIGINAL hardcoded
 * French otherwise, same optional-everywhere contract as runtime.ts's own
 * TFunc (see its doc comment).
 */
export function generateLearningNarrative(insights: LearningInsight[], t?: TFunc): string {
  if (insights.length === 0) {
    return t
      ? t('agents.learningLoop.narrative.noInsights')
      : 'Le brain analyse chaque mission pour apprendre et améliorer les futures exécutions.';
  }

  const hasSuccess = insights.some((i) => i.kind === 'success_pattern');
  const hasFailure = insights.some((i) => i.kind === 'failure_pattern');
  const hasAdaptation = insights.some((i) => i.kind === 'brain_adaptation');
  const hasSuggestion = insights.some((i) => i.kind === 'workflow_suggestion');

  if (hasSuccess && hasAdaptation) {
    return t
      ? t('agents.learningLoop.narrative.successAndAdaptation')
      : 'Le brain a adapté le workflow en s\'appuyant sur les missions précédentes, et la mission a réussi. Le cycle d\'amélioration continue fonctionne.';
  }
  if (hasFailure && hasSuggestion) {
    return t
      ? t('agents.learningLoop.narrative.failureAndSuggestion')
      : 'Le brain a détecté des points d\'amélioration et génère des suggestions pour les futures missions similaires. Chaque échec nourrit l\'apprentissage.';
  }
  if (hasAdaptation) {
    return t
      ? t('agents.learningLoop.narrative.adaptationOnly')
      : 'Le brain a utilisé ses connaissances passées pour adapter le plan de cette mission. L\'amélioration continue est active.';
  }
  if (hasSuccess) {
    return t
      ? t('agents.learningLoop.narrative.successOnly')
      : 'Mission réussie — le brain enregistre ce pattern de succès pour les futures missions similaires.';
  }
  return t
    ? t('agents.learningLoop.narrative.fallback')
    : 'Le brain apprend de chaque mission et adapte les futures exécutions en conséquence.';
}
