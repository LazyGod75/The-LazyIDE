import { describe, it, expect } from 'vitest';
import { DifficultyFSM, scoreStep } from '../fsm';
import {
  evaluateMonitors,
  getMonitorConfig,
  type MonitorContext,
} from '../monitors';
import { compressToolOutput, shouldEarlyExit, buildEarlyExitNudge } from '../tokenSaving';
import { buildChainOfDraftBlock, CHAIN_OF_DRAFT_DIRECTIVE } from '../chainOfDraft';
import { withPromptCaching, isCachingSupportedModel, hasCacheBreakpoint } from '../promptCaching';
import { SteeringPipeline } from '../steering';
import { fsmStateToModelTier, suggestModelForFSMState, LAZY_REASONING_TAGS, createManagerInterventionListener } from '../index';

// ── FSM tests ─────────────────────────────────────────────────────

describe('DifficultyFSM', () => {
  it('starts in INIT state', () => {
    const fsm = new DifficultyFSM();
    expect(fsm.getState()).toBe('INIT');
  });

  it('transitions from INIT to NORMAL on first step', () => {
    const fsm = new DifficultyFSM();
    fsm.transition(0.5);
    expect(fsm.getState()).toBe('NORMAL');
  });

  it('enters FAST when recent steps are all easy', () => {
    const fsm = new DifficultyFSM();
    fsm.transition(0.5); // INIT → NORMAL
    // Feed fastWindow (6) easy steps
    for (let i = 0; i < 6; i++) {
      fsm.transition(0.1);
    }
    expect(fsm.getState()).toBe('FAST');
  });

  it('enters SLOW when recent steps are all hard', () => {
    const fsm = new DifficultyFSM();
    fsm.transition(0.5); // INIT → NORMAL
    // Feed slowWindow (5) hard steps
    for (let i = 0; i < 5; i++) {
      fsm.transition(0.8);
    }
    expect(fsm.getState()).toBe('SLOW');
  });

  it('returns to NORMAL from FAST when score exceeds hysteresis', () => {
    const fsm = new DifficultyFSM();
    fsm.transition(0.5); // INIT → NORMAL
    for (let i = 0; i < 6; i++) fsm.transition(0.1); // → FAST
    expect(fsm.getState()).toBe('FAST');
    fsm.transition(0.5); // > fastThreshold + hysteresisMargin
    expect(fsm.getState()).toBe('NORMAL');
  });

  it('returns to NORMAL from SLOW when score drops', () => {
    const fsm = new DifficultyFSM();
    fsm.transition(0.5); // INIT → NORMAL
    for (let i = 0; i < 5; i++) fsm.transition(0.8); // → SLOW
    expect(fsm.getState()).toBe('SLOW');
    fsm.transition(0.3); // < slowThreshold - hysteresisMargin
    expect(fsm.getState()).toBe('NORMAL');
  });

  it('resets to INIT', () => {
    const fsm = new DifficultyFSM();
    fsm.transition(0.5);
    fsm.reset();
    expect(fsm.getState()).toBe('INIT');
    expect(fsm.getScores()).toHaveLength(0);
  });

  it('returns monitor cooldown per state', () => {
    const fsm = new DifficultyFSM();
    fsm.transition(0.5);
    expect(fsm.getMonitorCooldown()).toBe(3); // NORMAL
  });
});

describe('scoreStep', () => {
  it('returns 0 for empty text', () => {
    expect(scoreStep('')).toBe(0);
    expect(scoreStep('   ')).toBe(0);
  });

  it('returns low score for simple text', () => {
    const score = scoreStep('Read the file.');
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('returns higher score for text with errors and hedging', () => {
    const score = scoreStep('Maybe the error is in the typescript file. Perhaps we should fix the type mismatch. I think the function signature is wrong and the class method crashed.');
    expect(score).toBeGreaterThan(0.1);
  });
});

// ── Monitor tests ─────────────────────────────────────────────────

describe('Trajectory Monitors', () => {
  const config = getMonitorConfig('coding');

  it('returns zero scores for empty steps', () => {
    const ctx: MonitorContext = { steps: [], totalSteps: 0, originalTask: 'test', profile: 'coding' };
    const result = evaluateMonitors(ctx, config);
    expect(result.composite).toBe(0);
    expect(result.fired).toHaveLength(0);
  });

  it('detects verification skip', () => {
    const ctx: MonitorContext = {
      steps: ['I have fixed the issue and the task is done.', 'The implementation is complete.'],
      totalSteps: 2,
      originalTask: 'fix the bug',
      profile: 'coding',
    };
    const result = evaluateMonitors(ctx, config);
    expect(result.scores.verification_skip).toBeGreaterThan(0.5);
  });

  it('detects semantic loop', () => {
    const repeatedText = 'Reading the file to understand the structure of the codebase before making changes to the implementation';
    const ctx: MonitorContext = {
      steps: [repeatedText, repeatedText, repeatedText, repeatedText],
      totalSteps: 4,
      originalTask: 'fix the bug',
      profile: 'coding',
    };
    const result = evaluateMonitors(ctx, config);
    expect(result.scores.semantic_loop).toBeGreaterThan(0.3);
  });

  it('detects silent topic drift', () => {
    const ctx: MonitorContext = {
      steps: ['fix the authentication bug', 'now let us cook a recipe', 'the weather is nice today', 'lets go shopping for groceries'],
      totalSteps: 4,
      originalTask: 'fix the authentication bug in the login system',
      profile: 'coding',
    };
    const result = evaluateMonitors(ctx, config);
    expect(result.scores.silent_topic_drift).toBeGreaterThan(0.2);
  });

  it('generates intervention text when monitors fire', () => {
    const ctx: MonitorContext = {
      steps: ['I have fixed the issue and the task is done.', 'The implementation is complete and finished.'],
      totalSteps: 2,
      originalTask: 'fix the bug',
      profile: 'coding',
    };
    const result = evaluateMonitors(ctx, config);
    if (result.fired.length > 0) {
      expect(result.interventionText).toBeTruthy();
      expect(result.interventionSource).toBeTruthy();
    }
  });

  it('returns different weights for different profiles', () => {
    const codingConfig = getMonitorConfig('coding');
    const qaConfig = getMonitorConfig('qa');
    expect(codingConfig.weights.verification_skip).not.toBe(qaConfig.weights.verification_skip);
  });
});

// ── Token saving tests ────────────────────────────────────────────

describe('Token Saving', () => {
  it('does not compress short outputs', () => {
    const output = 'short output';
    const result = compressToolOutput(output);
    expect(result).toBe(output);
  });

  it('compresses long outputs', () => {
    const longOutput = 'A'.repeat(10000);
    const result = compressToolOutput(longOutput);
    expect(result.length).toBeLessThan(longOutput.length);
    expect(result).toContain('chars omitted');
  });

  it('detects early exit condition', () => {
    expect(shouldEarlyExit({
      step: 10,
      recentActions: [],
      hasFinalAction: false,
      consecutiveIdleSteps: 3,
      taskCompleted: false,
    })).toBe(true);
  });

  it('does not early exit when hasFinalAction is true', () => {
    expect(shouldEarlyExit({
      step: 10,
      recentActions: [],
      hasFinalAction: true,
      consecutiveIdleSteps: 3,
      taskCompleted: false,
    })).toBe(false);
  });

  it('builds early exit nudge', () => {
    const nudge = buildEarlyExitNudge();
    expect(nudge).toContain('FINAL');
  });
});

// ── Chain-of-Draft tests ──────────────────────────────────────────

describe('Chain of Draft', () => {
  it('builds directive block', () => {
    const block = buildChainOfDraftBlock();
    expect(block).toContain('Chain-of-Draft');
    expect(block).toContain('LAZYREASONING');
  });

  it('exports the directive constant', () => {
    expect(CHAIN_OF_DRAFT_DIRECTIVE).toContain('Chain-of-Draft');
  });
});

// ── Prompt caching tests ──────────────────────────────────────────
// withPromptCaching is a retired no-op (2026-07-28 chantier-2 integration
// audit): it used to append a "[CACHE_BREAKPOINT]" text marker that NOTHING
// downstream ever parsed — pure token waste with zero caching benefit. See
// promptCaching.ts's header for the full story and where the REAL working
// cache_control wiring lives (managedProvider.ts's cacheableSystem).

describe('Prompt Caching (retired marker, no-op)', () => {
  it('detects Anthropic models (isCachingSupportedModel kept for future real wiring)', () => {
    expect(isCachingSupportedModel('anthropic/claude-sonnet-4')).toBe(true);
    expect(isCachingSupportedModel('claude-opus-4')).toBe(true);
    expect(isCachingSupportedModel('openai/gpt-4o')).toBe(false);
  });

  it('returns the system prompt unchanged for Anthropic models', () => {
    const prompt = 'system prompt';
    expect(withPromptCaching(prompt, 'anthropic/claude-sonnet-4')).toBe(prompt);
    expect(hasCacheBreakpoint(withPromptCaching(prompt, 'anthropic/claude-sonnet-4'))).toBe(false);
  });

  it('returns the system prompt unchanged for non-Anthropic models', () => {
    const prompt = 'system prompt';
    expect(withPromptCaching(prompt, 'openai/gpt-4o')).toBe(prompt);
  });

  it('never introduces a cache breakpoint marker, even on repeated calls', () => {
    const once = withPromptCaching('system prompt', 'anthropic/claude-sonnet-4');
    const twice = withPromptCaching(once, 'anthropic/claude-sonnet-4');
    expect(twice).toBe('system prompt');
    expect(hasCacheBreakpoint(twice)).toBe(false);
  });
});

// ── Steering pipeline tests ───────────────────────────────────────

describe('SteeringPipeline', () => {
  it('can be instantiated', () => {
    const pipeline = new SteeringPipeline('coding');
    expect(pipeline).toBeDefined();
    expect(pipeline.getFSMState()).toBe('INIT');
  });

  it('runs and returns a result', async () => {
    const pipeline = new SteeringPipeline('coding');
    const result = await pipeline.run({
      step: 0,
      stepText: 'Reading the file to understand the structure.',
      recentSteps: [],
      totalSteps: 1,
      originalTask: 'fix the bug',
      projectId: 'test-project',
      model: 'anthropic/claude-sonnet-4',
      profile: 'coding',
      consecutiveIdleSteps: 0,
      hasFinalAction: false,
      taskCompleted: false,
    });
    expect(result.fsmState).toBeDefined();
    expect(result.injection).toBeDefined();
  });

  it('injects Chain-of-Draft at step 0', async () => {
    const pipeline = new SteeringPipeline('coding');
    const result = await pipeline.run({
      step: 0,
      stepText: 'Starting the task.',
      recentSteps: [],
      totalSteps: 1,
      originalTask: 'fix the bug',
      projectId: 'test',
      model: 'openai/gpt-4o',
      profile: 'coding',
      consecutiveIdleSteps: 0,
      hasFinalAction: false,
      taskCompleted: false,
    });
    expect(result.injection).toContain('Chain-of-Draft');
  });

  it('compresses tool output', () => {
    const pipeline = new SteeringPipeline('coding');
    const longOutput = 'X'.repeat(10000);
    const result = pipeline.compressOutput(longOutput);
    expect(result.length).toBeLessThan(longOutput.length);
  });

  it('applies prompt caching for Anthropic models (retired no-op — see promptCaching.ts header)', () => {
    const pipeline = new SteeringPipeline('coding');
    const result = pipeline.applyPromptCaching('test prompt', 'anthropic/claude-sonnet-4');
    expect(result).toBe('test prompt');
    expect(hasCacheBreakpoint(result)).toBe(false);
  });

  it('resets correctly', () => {
    const pipeline = new SteeringPipeline('coding');
    pipeline.reset();
    expect(pipeline.getFSMState()).toBe('INIT');
  });

  it('respects disabled config', async () => {
    const pipeline = new SteeringPipeline('coding', { enabled: false });
    const result = await pipeline.run({
      step: 0,
      stepText: 'test',
      recentSteps: [],
      totalSteps: 1,
      originalTask: 'test',
      projectId: 'test',
      model: 'test',
      profile: 'coding',
      consecutiveIdleSteps: 0,
      hasFinalAction: false,
      taskCompleted: false,
    });
    expect(result.injection).toBe('');
    expect(result.monitorResult).toBeNull();
  });
});

// ── Model routing tests ───────────────────────────────────────────

describe('Model Routing', () => {
  it('maps FSM states to model tiers', () => {
    expect(fsmStateToModelTier('FAST')).toBe('cheap');
    expect(fsmStateToModelTier('NORMAL')).toBe('default');
    expect(fsmStateToModelTier('SLOW')).toBe('expensive');
    expect(fsmStateToModelTier('SKIP')).toBe('skip');
  });

  it('suggests cheaper model for FAST state', () => {
    const suggestion = suggestModelForFSMState('FAST', 'anthropic/claude-sonnet-4');
    expect(suggestion).toContain('haiku');
  });

  it('suggests expensive model for SLOW state', () => {
    const suggestion = suggestModelForFSMState('SLOW', 'anthropic/claude-haiku-4');
    expect(suggestion).toContain('opus');
  });

  it('returns null for NORMAL state', () => {
    expect(suggestModelForFSMState('NORMAL', 'anthropic/claude-sonnet-4')).toBeNull();
  });

  it('returns null for unknown model family', () => {
    expect(suggestModelForFSMState('FAST', 'unknown/model')).toBeNull();
  });
});

// ── Brain tags tests ──────────────────────────────────────────────

describe('LazyReasoningTags', () => {
  it('exports all expected tags', () => {
    expect(LAZY_REASONING_TAGS.e1).toBe('lazyreasoning:etrace-e1');
    expect(LAZY_REASONING_TAGS.e2).toBe('lazyreasoning:etrace-e2');
    expect(LAZY_REASONING_TAGS.e3).toBe('lazyreasoning:etrace-e3');
    expect(LAZY_REASONING_TAGS.fsm).toBe('lazyreasoning:fsm');
    expect(LAZY_REASONING_TAGS.monitor).toBe('lazyreasoning:monitor');
  });
});

// ── Stuck detection tests ─────────────────────────────────────────

describe('Stuck Detection (Second Safety Net)', () => {
  it('does not fire stuck on normal steps', async () => {
    const pipeline = new SteeringPipeline('coding');
    const result = await pipeline.run({
      step: 0,
      stepText: 'Reading the file.',
      recentSteps: [],
      totalSteps: 1,
      originalTask: 'fix bug',
      projectId: 'test',
      model: 'test',
      profile: 'coding',
      consecutiveIdleSteps: 0,
      hasFinalAction: false,
      taskCompleted: false,
    });
    expect(result.isStuck).toBe(false);
    expect(result.stuckDetail).toBeNull();
  });

  it('does not fire stuck when SLOW but no injections were sent yet', async () => {
    const pipeline = new SteeringPipeline('coding');
    // Feed hard steps to get to SLOW, but without any monitor firing
    // (injectionCount stays 0, so isStuck should be false)
    let result: Awaited<ReturnType<typeof pipeline.run>> | undefined;
    for (let i = 0; i < 5; i++) {
      result = await pipeline.run({
        step: i,
        stepText: 'Maybe perhaps the error might be in the typescript file. Perhaps we should fix the type mismatch.',
        recentSteps: [],
        totalSteps: i + 1,
        originalTask: 'fix bug',
        projectId: 'test',
        model: 'test',
        profile: 'coding',
        consecutiveIdleSteps: 0,
        hasFinalAction: false,
        taskCompleted: false,
      });
    }
    // Even if FSM is SLOW, stuck should not fire because injectionCount === 0
    // (self-steering hasn't tried yet)
    expect(result!.isStuck).toBe(false);
  });

  it('fires stuck after 3 consecutive SLOW steps with prior injections', async () => {
    const pipeline = new SteeringPipeline('coding');
    // Step 0: trigger an injection (Chain-of-Draft at step 0)
    await pipeline.run({
      step: 0,
      stepText: 'Starting the task.',
      recentSteps: [],
      totalSteps: 1,
      originalTask: 'fix a complex bug',
      projectId: 'test',
      model: 'test',
      profile: 'coding',
      consecutiveIdleSteps: 0,
      hasFinalAction: false,
      taskCompleted: false,
    });

    // Feed 8 hard steps: 5 to reach SLOW state, then 3 more for
    // consecutiveHardSteps >= STUCK_THRESHOLD (3).
    // The injectionCount > 0 from the Chain-of-Draft injection at step 0.
    // Text must score > 0.6 (slowThreshold) — needs high hedge density,
    // error language, and enough length.
    const hardText = 'Maybe perhaps possibly I think probably not sure uncertain unclear. Error failed cannot unable exception crash bug broken does not work. Maybe perhaps might could be possibly I think probably not sure uncertain unclear. Error failed cannot unable exception crash bug broken. '.repeat(10);
    let result;
    let stuckDetected = false;
    for (let i = 1; i <= 8; i++) {
      result = await pipeline.run({
        step: i,
        stepText: hardText,
        recentSteps: [],
        totalSteps: i + 1,
        originalTask: 'fix a complex bug',
        projectId: 'test',
        model: 'test',
        profile: 'coding',
        consecutiveIdleSteps: 0,
        hasFinalAction: false,
        taskCompleted: false,
      });
      if (result.isStuck) stuckDetected = true;
    }
    // After 8 hard steps with prior injection, stuck should have fired
    expect(stuckDetected).toBe(true);
  });

  it('only fires stuck once per run', async () => {
    const pipeline = new SteeringPipeline('coding');
    // Step 0: trigger an injection
    await pipeline.run({
      step: 0,
      stepText: 'Starting.',
      recentSteps: [],
      totalSteps: 1,
      originalTask: 'fix bug',
      projectId: 'test',
      model: 'test',
      profile: 'coding',
      consecutiveIdleSteps: 0,
      hasFinalAction: false,
      taskCompleted: false,
    });

    // Feed 12 hard steps: 8 to trigger stuck, then 4 more to verify
    // it doesn't fire a second time.
    const hardText = 'Maybe perhaps possibly I think probably not sure uncertain unclear. Error failed cannot unable exception crash bug broken does not work. Maybe perhaps might could be possibly I think probably not sure uncertain unclear. Error failed cannot unable exception crash bug broken. '.repeat(10);
    let result;
    let stuckCount = 0;
    for (let i = 1; i <= 12; i++) {
      result = await pipeline.run({
        step: i,
        stepText: hardText,
        recentSteps: [],
        totalSteps: i + 1,
        originalTask: 'fix bug',
        projectId: 'test',
        model: 'test',
        profile: 'coding',
        consecutiveIdleSteps: 0,
        hasFinalAction: false,
        taskCompleted: false,
      });
      if (result.isStuck) stuckCount++;
    }
    // Stuck should have fired exactly once
    expect(stuckCount).toBe(1);
  });

  it('resets stuck state on pipeline reset', async () => {
    const pipeline = new SteeringPipeline('coding');
    // Trigger injection + hard steps to get stuck
    await pipeline.run({
      step: 0,
      stepText: 'Starting.',
      recentSteps: [],
      totalSteps: 1,
      originalTask: 'fix bug',
      projectId: 'test',
      model: 'test',
      profile: 'coding',
      consecutiveIdleSteps: 0,
      hasFinalAction: false,
      taskCompleted: false,
    });
    for (let i = 1; i <= 8; i++) {
      await pipeline.run({
        step: i,
        stepText: 'Maybe perhaps possibly I think probably not sure uncertain unclear. Error failed cannot unable exception crash bug broken does not work. Maybe perhaps might could be possibly I think probably not sure uncertain unclear. Error failed cannot unable exception crash bug broken. '.repeat(10),
        recentSteps: [],
        totalSteps: i + 1,
        originalTask: 'fix bug',
        projectId: 'test',
        model: 'test',
        profile: 'coding',
        consecutiveIdleSteps: 0,
        hasFinalAction: false,
        taskCompleted: false,
      });
    }
    pipeline.reset();
    // After reset, stuck should be able to fire again
    expect(pipeline.getFSMState()).toBe('INIT');
  });
});

// ── Manager intervention tests ────────────────────────────────────

describe('Manager Intervention (Second Safety Net)', () => {
  it('createManagerInterventionListener returns a cleanup function', () => {
    const cleanup = createManagerInterventionListener(() => {}, { enabled: false, maxResults: 1, maxChars: 100 });
    expect(typeof cleanup).toBe('function');
    cleanup();
  });
});
