/* lazyReasoningBlocks/steering.ts — Steering pipeline for LazyReasoningBlocks.
   Composes FSM + monitors + E-traces + token-saving + Chain-of-Draft into
   a single steering injection that is appended to the agent's system message
   at each step boundary.

   The pipeline runs between ReAct steps in managedAgent.ts:
   1. Score the latest step → advance FSM
   2. Evaluate 6 monitors on recent step history
   3. Retrieve E-traces (E1/E2/E3) from brain if monitors fired
   4. Compose steering injection text
   5. Return injection for the managed loop to append to the system message

   The injection is wrapped in [LAZYREASONING] blocks, clearly delimited
   so the model treats it as a directive, not reference data.
*/

import { DifficultyFSM, scoreStep, type FSMState } from './fsm.js';
import { evaluateMonitors, getMonitorConfig, type MonitorResult, type TaskProfile } from './monitors.js';
import { retrieveETraces, renderETraces, type ETrace } from './etraces.js';
import { compressToolOutput, shouldEarlyExit, buildEarlyExitNudge, type TokenSavingConfig, DEFAULT_TOKEN_SAVING_CONFIG } from './tokenSaving.js';
import { buildChainOfDraftBlock } from './chainOfDraft.js';
import { withPromptCaching } from './promptCaching.js';

// ── Types ─────────────────────────────────────────────────────────

export interface SteeringContext {
  step: number;
  stepText: string;
  recentSteps: string[];
  totalSteps: number;
  originalTask: string;
  projectId: string;
  model: string;
  profile: TaskProfile;
  consecutiveIdleSteps: number;
  hasFinalAction: boolean;
  taskCompleted: boolean;
  /** Mission ID — used for stuck event emission. */
  missionId?: string;
}

export interface SteeringResult {
  fsmState: FSMState;
  monitorResult: MonitorResult | null;
  eTraces: ETrace[];
  injection: string;
  earlyExitNudge: string | null;
  shouldEarlyExit: boolean;
  compressedOutput: string | null;
  /** True when the agent is stuck (SLOW/SKIP for 3+ consecutive steps
   *  AFTER self-steering injections already fired). This is the signal
   *  for the LazyManager second-safety-net to intervene. */
  isStuck: boolean;
  /** Stuck detail for the manager event — null when not stuck. */
  stuckDetail: { fsmState: FSMState; consecutiveHardSteps: number; lastFailureType: string | null } | null;
}

export interface SteeringPipelineConfig {
  enabled: boolean;
  tokenSavingConfig: TokenSavingConfig;
  e1MaxCalls: number;
  e2MaxCalls: number;
  chainOfDraft: boolean;
  promptCaching: boolean;
}

export const DEFAULT_STEERING_CONFIG: SteeringPipelineConfig = {
  enabled: true,
  tokenSavingConfig: DEFAULT_TOKEN_SAVING_CONFIG,
  e1MaxCalls: 3,
  e2MaxCalls: 5,
  chainOfDraft: true,
  promptCaching: true,
};

// ── Pipeline ──────────────────────────────────────────────────────

export class SteeringPipeline {
  private fsm: DifficultyFSM;
  private config: SteeringPipelineConfig;
  private monitorConfig: ReturnType<typeof getMonitorConfig>;
  private monitorHistory: { fired: boolean; composite: number }[] = [];
  private injectionCount = 0;
  private e1CallsRemaining: number;
  private e2CallsRemaining: number;
  private e3Fired = false;
  private chainOfDraftInjected = false;
  /** Consecutive steps in SLOW/SKIP state — used for stuck detection. */
  private consecutiveHardSteps = 0;
  /** Whether we already emitted a stuck event for this run. */
  private stuckEmitted = false;
  /** Whether any injection was sent (Chain-of-Draft, monitor, E-traces). */
  private anyInjectionSent = false;
  /** Minimum consecutive hard steps before emitting stuck. */
  private static readonly STUCK_THRESHOLD = 3;

  constructor(
    profile: TaskProfile = 'coding',
    config?: Partial<SteeringPipelineConfig>,
  ) {
    this.config = { ...DEFAULT_STEERING_CONFIG, ...config };
    this.monitorConfig = getMonitorConfig(profile);
    this.fsm = new DifficultyFSM();
    this.e1CallsRemaining = this.config.e1MaxCalls;
    this.e2CallsRemaining = this.config.e2MaxCalls;
  }

  /**
   * Run the steering pipeline for a single step.
   * Returns the steering result with injection text and early-exit signal.
   */
  async run(ctx: SteeringContext): Promise<SteeringResult> {
    if (!this.config.enabled) {
      return {
        fsmState: 'NORMAL',
        monitorResult: null,
        eTraces: [],
        injection: '',
        earlyExitNudge: null,
        shouldEarlyExit: false,
        compressedOutput: null,
        isStuck: false,
        stuckDetail: null,
      };
    }

    // 1. Score the step and advance FSM
    const score = scoreStep(ctx.stepText);
    const fsmState = this.fsm.transition(score);

    // 2. Evaluate monitors
    const monitorResult = evaluateMonitors(
      {
        steps: ctx.recentSteps,
        totalSteps: ctx.totalSteps,
        originalTask: ctx.originalTask,
        profile: ctx.profile,
      },
      this.monitorConfig,
    );

    this.monitorHistory.push({ fired: monitorResult.fired.length > 0, composite: monitorResult.composite });

    // 3. Check injection cooldown
    const cooldown = this.fsm.getMonitorCooldown();
    const stepsSinceLastInjection = this.injectionCount > 0 ? ctx.totalSteps - this.injectionCount : cooldown;
    const injectionAllowed = stepsSinceLastInjection >= cooldown && this.injectionCount < this.monitorConfig.maxInjectionsPerRun;

    // 4. Retrieve E-traces if monitors fired
    const e1Allowed = this.fsm.isE1Allowed(this.monitorHistory);
    const eTraceResult = await retrieveETraces({
      projectId: ctx.projectId,
      step: ctx.step,
      monitorResult: monitorResult.fired.length > 0 ? monitorResult : null,
      e1Allowed,
      e1MaxCalls: this.e1CallsRemaining,
      e2MaxCalls: this.e2CallsRemaining,
      e3Fired: this.e3Fired,
    });

    if (eTraceResult.e1Injected) this.e1CallsRemaining--;
    if (eTraceResult.e2Injected) this.e2CallsRemaining--;
    if (eTraceResult.e3Injected) this.e3Fired = true;

    // 5. Compose injection
    const injectionParts: string[] = [];

    // Chain-of-Draft: inject once at the start
    if (this.config.chainOfDraft && !this.chainOfDraftInjected && ctx.step === 0) {
      injectionParts.push(buildChainOfDraftBlock());
      this.chainOfDraftInjected = true;
      this.anyInjectionSent = true;
    }

    // Monitor intervention
    if (injectionAllowed && monitorResult.interventionText) {
      injectionParts.push(`[LAZYREASONING] ${monitorResult.interventionText}`);
      this.injectionCount = ctx.totalSteps;
      this.anyInjectionSent = true;
    }

    // E-traces
    const eTraceText = renderETraces(eTraceResult.traces);
    if (eTraceText) {
      injectionParts.push(`[LAZYREASONING] E-trace guidance:\n${eTraceText}`);
      this.anyInjectionSent = true;
    }

    // FSM state hint (only for SLOW/SKIP)
    if (fsmState === 'SLOW') {
      injectionParts.push('[LAZYREASONING] Difficulty elevated. Consider using a more powerful approach or breaking the task into smaller steps.');
    } else if (fsmState === 'SKIP') {
      injectionParts.push('[LAZYREASONING] Difficulty critically high. Consider early exit if the task is substantially complete.');
    }

    const injection = injectionParts.length > 0 ? injectionParts.join('\n\n') : '';

    // 6. Early-exit check
    const earlyExit = shouldEarlyExit(
      {
        step: ctx.step,
        recentActions: ctx.recentSteps,
        hasFinalAction: ctx.hasFinalAction,
        consecutiveIdleSteps: ctx.consecutiveIdleSteps,
        taskCompleted: ctx.taskCompleted,
      },
      this.config.tokenSavingConfig,
    );

    const earlyExitNudge = earlyExit ? buildEarlyExitNudge() : null;

    // 7. Stuck detection — second safety net signal.
    // Only fires AFTER self-steering already tried (injections were sent)
    // and the FSM has been in SLOW/SKIP for STUCK_THRESHOLD consecutive steps.
    // This is NOT a first-line intervention — the agent's own monitors and
    // E-traces run first. This signal is for the LazyManager to step in.
    if (fsmState === 'SLOW' || fsmState === 'SKIP') {
      this.consecutiveHardSteps++;
    } else {
      this.consecutiveHardSteps = 0;
    }

    const isStuck =
      !this.stuckEmitted &&
      this.consecutiveHardSteps >= SteeringPipeline.STUCK_THRESHOLD &&
      this.anyInjectionSent; // self-steering already tried

    const stuckDetail = isStuck
      ? {
          fsmState,
          consecutiveHardSteps: this.consecutiveHardSteps,
          lastFailureType: monitorResult.failureType,
        }
      : null;

    if (isStuck) {
      this.stuckEmitted = true; // once per run — manager decides what to do
    }

    return {
      fsmState,
      monitorResult,
      eTraces: eTraceResult.traces,
      injection,
      earlyExitNudge,
      shouldEarlyExit: earlyExit,
      compressedOutput: null,
      isStuck,
      stuckDetail,
    };
  }

  /**
   * Compress a tool output using the configured token-saving settings.
   */
  compressOutput(output: string): string {
    return compressToolOutput(output, this.config.tokenSavingConfig);
  }

  /**
   * Apply prompt caching to the system prompt if enabled.
   */
  applyPromptCaching(systemPrompt: string, model: string): string {
    if (!this.config.promptCaching) return systemPrompt;
    return withPromptCaching(systemPrompt, model);
  }

  /** Get current FSM state. */
  getFSMState(): FSMState {
    return this.fsm.getState();
  }

  /** Get monitor history for debugging/telemetry. */
  getMonitorHistory(): { fired: boolean; composite: number }[] {
    return [...this.monitorHistory];
  }

  /** Reset the pipeline for a new mission. */
  reset(): void {
    this.fsm.reset();
    this.monitorHistory = [];
    this.injectionCount = 0;
    this.e1CallsRemaining = this.config.e1MaxCalls;
    this.e2CallsRemaining = this.config.e2MaxCalls;
    this.e3Fired = false;
    this.chainOfDraftInjected = false;
    this.consecutiveHardSteps = 0;
    this.stuckEmitted = false;
    this.anyInjectionSent = false;
  }
}
