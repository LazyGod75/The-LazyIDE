/* lazyReasoningBlocks/monitors.ts — Trajectory monitors for agent self-correction.
   Six pure-heuristic monitors detect failure patterns mid-run and produce
   steering interventions injected into the agent's system message.

   Monitors (with weights for coding task profile):
   - claim_contradiction (0.30) — self-contradictory conclusions
   - semantic_loop (0.25) — reworded repetition
   - verification_skip (0.15) — concluding without checking
   - cyclic_compression (0.10) — context churn
   - late_sprawl (0.10) — late scope creep
   - silent_topic_drift (0.10) — quiet off-task drift

   Each monitor returns a score in [0, 1]. The composite is a weighted sum.
   When composite > fire threshold or any monitor fires, a steering injection
   is produced and appended to the system message as a [LAZYREASONING] block.

   Inspired by ReasonBlocks' monitor suite, adapted for Lazy's ReAct loop.
*/

// ── Types ─────────────────────────────────────────────────────────

export type MonitorName =
  | 'claim_contradiction'
  | 'semantic_loop'
  | 'verification_skip'
  | 'cyclic_compression'
  | 'late_sprawl'
  | 'silent_topic_drift';

export type TaskProfile = 'coding' | 'pr_review' | 'qa' | 'debug' | 'refactor' | 'chat';

export interface MonitorResult {
  scores: Record<MonitorName, number>;
  fired: MonitorName[];
  composite: number;
  failureType: string | null;
  interventionText: string | null;
  interventionSource: MonitorName | null;
}

export interface MonitorWeights {
  claim_contradiction: number;
  semantic_loop: number;
  verification_skip: number;
  cyclic_compression: number;
  late_sprawl: number;
  silent_topic_drift: number;
}

export interface MonitorConfig {
  weights: MonitorWeights;
  fireThreshold: number;
  maxInjectionsPerRun: number;
}

// ── Default weights per task profile ──────────────────────────────

const DEFAULT_WEIGHTS: MonitorWeights = {
  claim_contradiction: 0.30,
  semantic_loop: 0.25,
  verification_skip: 0.15,
  cyclic_compression: 0.10,
  late_sprawl: 0.10,
  silent_topic_drift: 0.10,
};

const PROFILE_WEIGHTS: Partial<Record<TaskProfile, MonitorWeights>> = {
  coding: DEFAULT_WEIGHTS,
  pr_review: {
    ...DEFAULT_WEIGHTS,
    verification_skip: 0.25,
    claim_contradiction: 0.20,
  },
  qa: {
    ...DEFAULT_WEIGHTS,
    verification_skip: 0.30,
    semantic_loop: 0.20,
  },
  debug: {
    ...DEFAULT_WEIGHTS,
    semantic_loop: 0.30,
    claim_contradiction: 0.20,
  },
  refactor: {
    ...DEFAULT_WEIGHTS,
    late_sprawl: 0.20,
    cyclic_compression: 0.15,
  },
  chat: {
    ...DEFAULT_WEIGHTS,
    silent_topic_drift: 0.20,
    late_sprawl: 0.15,
  },
};

export function getMonitorConfig(profile: TaskProfile): MonitorConfig {
  const weights = PROFILE_WEIGHTS[profile] ?? DEFAULT_WEIGHTS;
  return {
    weights,
    fireThreshold: 0.3,
    maxInjectionsPerRun: 5,
  };
}

// ── Individual monitors (pure heuristics) ─────────────────────────

/** Detect self-contradictory conclusions in the agent's recent output. */
function monitorClaimContradiction(steps: string[]): number {
  if (steps.length < 2) return 0;
  const recent = steps.slice(-5);
  const claims: { text: string; polarity: 'positive' | 'negative' | 'neutral' }[] = [];

  for (const step of recent) {
    const lower = step.toLowerCase();
    // Detect assertion + negation patterns
    if (/\b(is|are|was|will|should|must|can)\b/.test(lower) && /\b(not|no|never|cannot|shouldn't|won't)\b/.test(lower)) {
      // Has both positive and negative assertions — check for contradiction
      const sentences = lower.split(/[.!?]/).filter(Boolean);
      for (const sent of sentences) {
        const hasNegation = /\b(not|no|never|cannot|shouldn't|won't|doesn't|isn't|aren't)\b/.test(sent);
        const hasAffirmation = /\b(is|are|was|will|should|must|can|does)\b/.test(sent) && !hasNegation;
        if (hasNegation) claims.push({ text: sent.trim(), polarity: 'negative' });
        else if (hasAffirmation) claims.push({ text: sent.trim(), polarity: 'positive' });
      }
    }
  }

  // Check for contradictory pairs
  let contradictions = 0;
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      if (claims[i].polarity !== claims[j].polarity && claims[i].polarity !== 'neutral' && claims[j].polarity !== 'neutral') {
        // Check if they're about the same topic (simple word overlap)
        const words1 = new Set(claims[i].text.split(/\s+/).filter((w) => w.length > 3));
        const words2 = new Set(claims[j].text.split(/\s+/).filter((w) => w.length > 3));
        const overlap = [...words1].filter((w) => words2.has(w)).length;
        if (overlap >= 2) contradictions++;
      }
    }
  }

  return Math.min(1, contradictions / 3);
}

/** Detect reworded repetition — agent saying the same thing in different words. */
function monitorSemanticLoop(steps: string[]): number {
  if (steps.length < 3) return 0;
  const recent = steps.slice(-6);
  // Compare each pair of recent steps for semantic similarity (word overlap)
  let maxSimilarity = 0;
  for (let i = 0; i < recent.length; i++) {
    for (let j = i + 1; j < recent.length; j++) {
      const words1 = new Set(recent[i].toLowerCase().split(/\s+/).filter((w) => w.length > 3));
      const words2 = new Set(recent[j].toLowerCase().split(/\s+/).filter((w) => w.length > 3));
      if (words1.size === 0 || words2.size === 0) continue;
      const intersection = [...words1].filter((w) => words2.has(w)).length;
      const union = words1.size + words2.size - intersection;
      const jaccard = intersection / union;
      if (jaccard > maxSimilarity) maxSimilarity = jaccard;
    }
  }
  // High Jaccard similarity (>0.5) between steps indicates a loop
  return maxSimilarity > 0.5 ? Math.min(1, (maxSimilarity - 0.5) * 2) : 0;
}

/** Detect concluding without verification — agent claiming done without testing. */
function monitorVerificationSkip(steps: string[]): number {
  if (steps.length < 2) return 0;
  const recent = steps.slice(-5).join(' ').toLowerCase();
  // Check for completion claims
  const hasCompletionClaim = /\b(done|complete|finished|fixed|resolved|implemented|created|updated)\b/.test(recent);
  // Check for verification actions
  const hasVerification = /\b(test|verify|check|run|build|lint|typecheck|read_file|grep)\b/.test(recent);
  if (hasCompletionClaim && !hasVerification) return 0.8;
  if (hasCompletionClaim && hasVerification) return 0.1;
  return 0;
}

/** Detect context churn — agent repeatedly reading/writing the same files. */
function monitorCyclicCompression(steps: string[]): number {
  if (steps.length < 4) return 0;
  const recent = steps.slice(-8);
  // Count file operation repetitions
  const fileOps: Record<string, number> = {};
  for (const step of recent) {
    const matches = step.match(/(?:read|write|edit|open|modify)[_a-z]*\s*:?\s*([a-z0-9_./-]+\.[a-z]{1,6})/gi) ?? [];
    for (const match of matches) {
      const file = match.toLowerCase();
      fileOps[file] = (fileOps[file] ?? 0) + 1;
    }
  }
  const maxReps = Math.max(0, ...Object.values(fileOps));
  // Same file operated on 3+ times in recent steps = cyclic churn
  return Math.min(1, Math.max(0, (maxReps - 2) / 3));
}

/** Detect late scope creep — agent introducing new topics/files late in the run. */
function monitorLateSprawl(steps: string[], totalSteps: number): number {
  if (steps.length < 5 || totalSteps < 10) return 0;
  // Look at the last 20% of steps
  const lateStart = Math.floor(steps.length * 0.8);
  const lateSteps = steps.slice(lateStart).join(' ').toLowerCase();
  const earlySteps = steps.slice(0, lateStart).join(' ').toLowerCase();
  // Find new file references in late steps not present in early steps
  const earlyFiles = new Set((earlySteps.match(/[a-z_][a-z0-9_]*\.[a-z]{1,6}/g) ?? []).map((f) => f.toLowerCase()));
  const lateFiles = (lateSteps.match(/[a-z_][a-z0-9_]*\.[a-z]{1,6}/g) ?? []).map((f) => f.toLowerCase());
  const newFiles = lateFiles.filter((f) => !earlyFiles.has(f));
  // Many new files introduced late = sprawl
  return Math.min(1, newFiles.length / 5);
}

/** Detect quiet off-task drift — agent moving away from the original task. */
function monitorSilentTopicDrift(steps: string[], originalTask: string): number {
  if (steps.length < 4) return 0;
  const recent = steps.slice(-5).join(' ').toLowerCase();
  const taskWords = new Set(originalTask.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
  if (taskWords.size === 0) return 0;
  // Check how many task keywords appear in recent steps
  const recentWords = new Set(recent.split(/\s+/));
  const overlap = [...taskWords].filter((w) => recentWords.has(w)).length;
  const ratio = overlap / taskWords.size;
  // Low overlap = drift
  return Math.min(1, Math.max(0, 1 - ratio - 0.3));
}

// ── Monitor suite ─────────────────────────────────────────────────

export interface MonitorContext {
  steps: string[];
  totalSteps: number;
  originalTask: string;
  profile: TaskProfile;
}

export function evaluateMonitors(ctx: MonitorContext, config: MonitorConfig): MonitorResult {
  const { steps, totalSteps, originalTask } = ctx;

  const scores: Record<MonitorName, number> = {
    claim_contradiction: monitorClaimContradiction(steps),
    semantic_loop: monitorSemanticLoop(steps),
    verification_skip: monitorVerificationSkip(steps),
    cyclic_compression: monitorCyclicCompression(steps),
    late_sprawl: monitorLateSprawl(steps, totalSteps),
    silent_topic_drift: monitorSilentTopicDrift(steps, originalTask),
  };

  // Composite = weighted sum
  let composite = 0;
  for (const [name, score] of Object.entries(scores)) {
    composite += score * (config.weights[name as MonitorName] ?? 0);
  }
  composite = Math.min(1, composite);

  // Determine which monitors fired (score >= fireThreshold)
  const fired = (Object.keys(scores) as MonitorName[]).filter((name) => scores[name] >= config.fireThreshold);

  // Determine failure type from the highest-scoring monitor
  const failureType = fired.length > 0
    ? fired.reduce((max, name) => (scores[name] > scores[max] ? name : max), fired[0])
    : null;

  // Generate intervention text
  const interventionText = fired.length > 0 ? generateIntervention(fired[0]) : null;
  const interventionSource = fired.length > 0 ? fired[0] : null;

  return {
    scores,
    fired,
    composite,
    failureType,
    interventionText,
    interventionSource,
  };
}

function generateIntervention(monitor: MonitorName): string {
  switch (monitor) {
    case 'claim_contradiction':
      return 'Your recent reasoning contains contradictory claims. Review your conclusions and resolve the inconsistency before proceeding.';
    case 'semantic_loop':
      return 'You are repeating the same reasoning in different words. Try a fundamentally different approach or tool call.';
    case 'verification_skip':
      return 'You claimed completion without verifying. Run the relevant tests, build, or typecheck before concluding.';
    case 'cyclic_compression':
      return 'You are repeatedly operating on the same files. Step back and consider whether this is necessary or if you are stuck.';
    case 'late_sprawl':
      return 'You are introducing new files and scope late in the task. Focus on completing the original task before expanding scope.';
    case 'silent_topic_drift':
      return 'Your recent steps have drifted from the original task. Re-focus on the core objective.';
    default:
      return '';
  }
}
