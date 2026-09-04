/* stageContract.ts — Compiled plan system: StageContract, WorkflowGraph, PlanCompiler.
   Replaces the hardcoded 5-step buildInitialPlan() with a configurable, brain-aware
   workflow compiler. Each stage has an explicit contract: what it does, its limits,
   its expected outputs, and how it transitions.

   Inspired by Millrace's "compiled plan" concept — adapted for Lazy's TS/Tauri stack
   and integrated with LazyBrain for brain-driven plan adaptation.
*/

import type { Mission, PlanStep } from '../agents/types.js';
import type { BrainRecallResult } from '../platform/types.js';
import type { PermissionMode } from './runtime.js';

// ── Stage types ───────────────────────────────────────────────────

export type StageKind =
  | 'analyze'
  | 'implement'
  | 'test'
  | 'review'
  | 'security'
  | 'fix'
  | 'learning'
  | 'prepare_diff';

export type StageState = 'todo' | 'in_progress' | 'done' | 'blocked' | 'skipped';

export interface StageContract {
  id: string;
  kind: StageKind;
  label: string;
  description: string;
  model: string;
  permissionMode: PermissionMode;
  allowedTools?: string[];
  deniedTools?: string[];
  systemPrompt: string;
  taskPrompt: string;
  state: StageState;
  attemptCount: number;
  maxAttempts: number;
  maxDurationMs?: number;
  dependsOn: string[];
  onPass: string | null;
  onFail: string | null;
  brainContext?: string;
  brainCitations?: string[];
  artifacts?: string[];
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface WorkflowGraph {
  stages: StageContract[];
  entryStageId: string;
  completionStageId: string;
}

export interface CompiledPlan {
  graph: WorkflowGraph;
  createdAt: string;
  brainAdapted: boolean;
  adaptations: PlanAdaptation[];
}

export interface PlanAdaptation {
  kind: 'reinforced_testing' | 'extra_security' | 'fix_loop' | 'learning_stage' | 'brain_context';
  reason: string;
  stageId: string;
}

// ── Plan compiler ─────────────────────────────────────────────────

interface CompileOptions {
  mission: Pick<Mission, 'id' | 'title' | 'agentTask' | 'agentName' | 'isOrchestrator' | 'model'>;
  brainRecall?: BrainRecallResult | null;
  permissionMode?: PermissionMode;
  allowedTools?: string[];
  deniedTools?: string[];
}

function defaultModel(missionModel?: string): string {
  const m = (missionModel ?? '').toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('sonnet')) return 'sonnet';
  if (m.includes('opus')) return 'opus';
  return 'haiku';
}

function stageId(kind: StageKind, missionId: string): string {
  return `${missionId}-${kind}`;
}

/**
 * Analyze brain recall to determine if the plan should be adapted.
 * Uses structured signals (title prefixes, capture kinds, cluster paths,
 * injected-context markers) — never sniffs arbitrary words like "auth"
 * or "fix" out of a snippet.
 */
function nodeKindSignals(node: { title: string; snippet: string; cluster?: string }): {
  testFailure: boolean;
  security: boolean;
  pastFix: boolean;
} {
  const title = node.title.toLowerCase();
  const cluster = (node.cluster ?? '').toLowerCase();
  const snippet = node.snippet.toLowerCase();
  const tagged = `${title} ${cluster}`;
  const structured = /\[(test_insight|failure_pattern|security_insight|security)\]/.test(title)
    || /data-cerveau-type=["'](decision|warning|security)["']/.test(snippet)
    || title.startsWith('learning:')
    || title.startsWith('[security]')
    || title.startsWith('[test]');

  return {
    testFailure: structured && (
      tagged.includes('test_insight')
      || tagged.includes('failure_pattern')
      || title.startsWith('[test]')
      || cluster.includes('/test')
    ),
    security: structured && (
      tagged.includes('security')
      || /data-cerveau-type=["']security["']/.test(snippet)
      || title.startsWith('[security]')
      || cluster.includes('/security')
    ),
    pastFix: structured && (
      tagged.includes('failure_pattern')
      || title.startsWith('learning:')
    ),
  };
}

function analyzeBrainForAdaptations(
  missionId: string,
  recall: BrainRecallResult | null | undefined,
): PlanAdaptation[] {
  if (!recall || !recall.nodes || recall.nodes.length === 0) return [];

  const adaptations: PlanAdaptation[] = [];
  let testFailure = false;
  let security = false;
  let pastFix = false;
  for (const node of recall.nodes) {
    const sig = nodeKindSignals(node);
    testFailure = testFailure || sig.testFailure;
    security = security || sig.security;
    pastFix = pastFix || sig.pastFix;
  }

  if (testFailure) {
    adaptations.push({
      kind: 'reinforced_testing',
      reason: 'Brain notes tagged as test/failure insights — reinforcing test stage',
      stageId: stageId('test', missionId),
    });
  }

  if (security) {
    adaptations.push({
      kind: 'extra_security',
      reason: 'Brain notes tagged as security — adding security review stage',
      stageId: stageId('security', missionId),
    });
  }

  if (pastFix) {
    adaptations.push({
      kind: 'fix_loop',
      reason: 'Brain learning notes record prior failures — enabling fix-retry loop',
      stageId: stageId('fix', missionId),
    });
  }

  if (recall.nodes.length > 0) {
    adaptations.push({
      kind: 'brain_context',
      reason: 'Brain context available — injecting into all stages',
      stageId: '*',
    });
  }

  return adaptations;
}

/**
 * Compile a mission into a frozen workflow plan.
 *
 * The base workflow is: analyze → implement → test → (security?) → review → prepare_diff
 * With brain adaptations, stages can be added, reinforced, or modified.
 */
export function compilePlan(opts: CompileOptions): CompiledPlan {
  const { mission, brainRecall, permissionMode, allowedTools, deniedTools } = opts;
  const model = defaultModel(mission.model);
  const pm = permissionMode ?? 'acceptEdits';
  const adaptations = analyzeBrainForAdaptations(mission.id, brainRecall);
  const brainCtx = brainRecall?.injectedContext ?? '';
  const brainCitations = brainRecall?.nodes?.slice(0, 8).map((n) => `#${n.id}`) ?? [];

  const stages: StageContract[] = [];
  const mid = mission.id;

  // Stage 1: Analyze
  stages.push({
    id: stageId('analyze', mid),
    kind: 'analyze',
    label: `Analyser : ${mission.title.slice(0, 60)}`,
    description: 'Read relevant files, understand the codebase context, identify approach',
    model,
    permissionMode: 'plan',
    allowedTools: ['Read', 'Glob', 'Grep'],
    systemPrompt: 'You are an analyst. Read the codebase and understand the task. Do not make changes.',
    taskPrompt: `Analyze the task: ${mission.agentTask ?? mission.title}. Identify relevant files and approach.`,
    state: 'todo',
    attemptCount: 0,
    maxAttempts: 1,
    dependsOn: [],
    onPass: stageId('implement', mid),
    onFail: null,
    brainContext: brainCtx,
    brainCitations,
  });

  // Stage 2: Implement
  stages.push({
    id: stageId('implement', mid),
    kind: 'implement',
    label: 'Implémenter les modifications',
    description: 'Make the code changes required by the mission',
    model,
    permissionMode: pm,
    allowedTools,
    deniedTools,
    systemPrompt: 'You are an autonomous coding agent. Complete the task fully. Make all necessary file changes.',
    taskPrompt: `Implement: ${mission.agentTask ?? mission.title}. Be autonomous and complete.`,
    state: 'todo',
    attemptCount: 0,
    maxAttempts: 2,
    dependsOn: [stageId('analyze', mid)],
    onPass: stageId('test', mid),
    onFail: stageId('fix', mid),
    brainContext: brainCtx,
    brainCitations,
  });

  // Stage 3: Test (possibly reinforced)
  const testAdaptation = adaptations.find((a) => a.kind === 'reinforced_testing');
  stages.push({
    id: stageId('test', mid),
    kind: 'test',
    label: testAdaptation ? 'Tests renforcés' : 'Exécuter la validation',
    description: testAdaptation
      ? 'Run tests with extra scrutiny — past similar missions had test failures'
      : 'Run the test suite and verify changes',
    model,
    permissionMode: 'plan',
    allowedTools: ['Read', 'Bash'],
    systemPrompt: 'You are a tester. Run the test suite and report results.',
    taskPrompt: `Run tests for: ${mission.agentTask ?? mission.title}. Report pass/fail counts.`,
    state: 'todo',
    attemptCount: 0,
    maxAttempts: 2,
    dependsOn: [stageId('implement', mid)],
    onPass: null, // Will be set based on adaptations
    onFail: stageId('fix', mid),
    brainContext: brainCtx,
    brainCitations,
  });

  // Stage 4: Security (conditional, brain-adapted)
  const securityAdaptation = adaptations.find((a) => a.kind === 'extra_security');
  if (securityAdaptation) {
    stages.push({
      id: stageId('security', mid),
      kind: 'security',
      label: 'Audit de sécurité',
      description: 'Security review — brain detected security-sensitive patterns in similar past work',
      model,
      permissionMode: 'plan',
      allowedTools: ['Read', 'Bash'],
      systemPrompt: 'You are a security engineer. Check for hardcoded secrets, injection, missing auth.',
      taskPrompt: `Security review of changes for: ${mission.agentTask ?? mission.title}.`,
      state: 'todo',
      attemptCount: 0,
      maxAttempts: 1,
      dependsOn: [stageId('test', mid)],
      onPass: stageId('review', mid),
      onFail: stageId('fix', mid),
      brainContext: brainCtx,
      brainCitations,
    });
    // Wire test.onPass to security
    stages[2].onPass = stageId('security', mid);
  } else {
    stages[2].onPass = stageId('review', mid);
  }

  // Stage 5: Review
  stages.push({
    id: stageId('review', mid),
    kind: 'review',
    label: 'Revue de code',
    description: 'Code quality review — check for immutability, naming, error handling',
    model,
    permissionMode: 'plan',
    allowedTools: ['Read', 'Bash'],
    systemPrompt: 'You are a senior code reviewer. Review for quality, immutability, naming, error handling.',
    taskPrompt: `Review the code changes for: ${mission.agentTask ?? mission.title}.`,
    state: 'todo',
    attemptCount: 0,
    maxAttempts: 1,
    dependsOn: [stages[2].onPass!],
    onPass: stageId('prepare_diff', mid),
    onFail: stageId('fix', mid),
    brainContext: brainCtx,
    brainCitations,
  });

  // Stage 6: Fix (conditional, brain-adapted)
  const fixAdaptation = adaptations.find((a) => a.kind === 'fix_loop');
  stages.push({
    id: stageId('fix', mid),
    kind: 'fix',
    label: 'Corriger et réessayer',
    description: fixAdaptation
      ? 'Fix issues — brain shows past missions needed fix iterations'
      : 'Fix issues found by test/review/security stages',
    model,
    permissionMode: pm,
    allowedTools,
    deniedTools,
    systemPrompt: 'You are a fixer. Analyze the failure and correct the code. Be precise.',
    taskPrompt: `Fix the issues found in: ${mission.agentTask ?? mission.title}. Re-run tests after fixing.`,
    state: 'todo',
    attemptCount: 0,
    maxAttempts: fixAdaptation ? 3 : 2,
    dependsOn: [],
    onPass: stageId('test', mid), // Loop back to test
    onFail: null, // Blocked — needs operator
    brainContext: brainCtx,
    brainCitations,
  });

  // Stage 7: Prepare diff
  stages.push({
    id: stageId('prepare_diff', mid),
    kind: 'prepare_diff',
    label: 'Préparer le diff pour revue',
    description: 'Compute the final diff and transition to human review',
    model,
    permissionMode: 'plan',
    allowedTools: ['Read', 'Bash'],
    systemPrompt: 'You are a diff preparer. Compute the git diff and summarize changes.',
    taskPrompt: `Prepare diff for: ${mission.agentTask ?? mission.title}.`,
    state: 'todo',
    attemptCount: 0,
    maxAttempts: 1,
    dependsOn: [stageId('review', mid)],
    onPass: null, // Terminal — transitions to human review
    onFail: null,
    brainContext: brainCtx,
    brainCitations,
  });

  // Stage 8: Learning (always present, runs post-completion)
  stages.push({
    id: stageId('learning', mid),
    kind: 'learning',
    label: 'Apprentissage & feedback brain',
    description: 'Analyze mission results and feed insights back to LazyBrain',
    model,
    permissionMode: 'plan',
    allowedTools: ['Read'],
    systemPrompt: 'You are a learning analyzer. Summarize what worked, what failed, and what should be remembered.',
    taskPrompt: `Analyze mission results for: ${mission.agentTask ?? mission.title}. What should the brain remember?`,
    state: 'todo',
    attemptCount: 0,
    maxAttempts: 1,
    dependsOn: [stageId('prepare_diff', mid)],
    onPass: null,
    onFail: null,
    brainContext: brainCtx,
    brainCitations,
  });

  return {
    graph: {
      stages,
      entryStageId: stageId('analyze', mid),
      completionStageId: stageId('prepare_diff', mid),
    },
    createdAt: new Date().toISOString(),
    brainAdapted: adaptations.length > 0,
    adaptations,
  };
}

// ── Helpers ───────────────────────────────────────────────────────

/** Format compiled stages as ReAct guidance — the live engine stays ReAct;
 *  stages are a soft ordered guide, not a hard stage runner. */
export function formatCompiledPlanGuide(plan: CompiledPlan): string {
  const stages = plan.graph.stages.filter((s) => s.kind !== 'learning');
  if (stages.length === 0) return '';
  const lines = stages.map((s, i) => `${i + 1}. [${s.kind}] ${s.label} — ${s.description}`);
  return (
    `<compiled_plan_guide>\n` +
    `Follow this stage order in spirit while using ReAct tools. Do not invent a parallel planner — execute the mission, advancing through these phases:\n` +
    `${lines.join('\n')}\n` +
    `</compiled_plan_guide>`
  );
}

/** Convert a compiled plan to the legacy PlanStep[] format for UI compatibility. */
export function planToSteps(plan: CompiledPlan): PlanStep[] {
  return plan.graph.stages
    .filter((s) => s.kind !== 'learning') // Learning is shown separately
    .map((s) => ({
      label: s.label,
      state: s.state === 'in_progress' ? 'in_progress' : s.state === 'done' ? 'done' : 'todo',
      meta: s.state === 'done' && s.completedAt
        ? `fait · ${new Date(s.completedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
        : s.state === 'blocked'
        ? `bloqué · ${s.error ?? ''}`
        : undefined,
    }));
}

/** Get the next stage to execute based on current states. */
export function getNextStage(plan: CompiledPlan): StageContract | null {
  for (const stage of plan.graph.stages) {
    if (stage.state === 'todo') {
      const depsReady = stage.dependsOn.every((depId) => {
        const dep = plan.graph.stages.find((s) => s.id === depId);
        return dep && (dep.state === 'done' || dep.state === 'skipped');
      });
      if (depsReady) return stage;
    }
  }
  return null;
}

/** Mark a stage as started. Returns a new plan (immutable). */
export function startStage(plan: CompiledPlan, stageId: string): CompiledPlan {
  return {
    ...plan,
    graph: {
      ...plan.graph,
      stages: plan.graph.stages.map((s) =>
        s.id === stageId
          ? { ...s, state: 'in_progress', startedAt: new Date().toISOString(), attemptCount: s.attemptCount + 1 }
          : s,
      ),
    },
  };
}

/** Mark a stage as done and transition to the next. */
export function completeStage(plan: CompiledPlan, stageId: string): CompiledPlan {
  return {
    ...plan,
    graph: {
      ...plan.graph,
      stages: plan.graph.stages.map((s) =>
        s.id === stageId
          ? { ...s, state: 'done', completedAt: new Date().toISOString() }
          : s,
      ),
    },
  };
}

/** Mark a stage as blocked. */
export function blockStage(plan: CompiledPlan, stageId: string, error: string): CompiledPlan {
  return {
    ...plan,
    graph: {
      ...plan.graph,
      stages: plan.graph.stages.map((s) =>
        s.id === stageId
          ? { ...s, state: 'blocked', error }
          : s,
      ),
    },
  };
}

/** Get a stage by ID. */
export function getStage(plan: CompiledPlan, stageId: string): StageContract | undefined {
  return plan.graph.stages.find((s) => s.id === stageId);
}

/** Check if all execution stages are done (excluding learning). */
export function isExecutionComplete(plan: CompiledPlan): boolean {
  return plan.graph.stages
    .filter((s) => s.kind !== 'learning')
    .every((s) => s.state === 'done' || s.state === 'skipped');
}

/** Check if the learning stage is ready to run. */
export function isLearningReady(plan: CompiledPlan): boolean {
  const learning = plan.graph.stages.find((s) => s.kind === 'learning');
  if (!learning || learning.state !== 'todo') return false;
  return isExecutionComplete(plan);
}
