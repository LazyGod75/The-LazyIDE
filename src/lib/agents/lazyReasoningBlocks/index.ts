/* lazyReasoningBlocks/index.ts — LazyReasoningBlocks entry point.
   Exports the SteeringPipeline and all sub-modules for integration
   with managedAgent.ts and brainNotation.ts.

   Also provides model routing based on FSM state:
   - FAST → cheaper model (e.g. haiku/flash)
   - NORMAL → default model (unchanged)
   - SLOW → more powerful model (e.g. opus/sonnet)
   - SKIP → no model change, but early-exit nudge

   Naming: all brain tags use 'lazyreasoning:' prefix.
*/

export { DifficultyFSM, scoreStep, type FSMState, type FSMThresholds, DEFAULT_THRESHOLDS } from './fsm.js';
export {
  evaluateMonitors,
  getMonitorConfig,
  type MonitorName,
  type TaskProfile,
  type MonitorResult,
  type MonitorWeights,
  type MonitorConfig,
  type MonitorContext,
} from './monitors.js';
export {
  retrieveETraces,
  renderETraces,
  type ETrace,
  type ETraceTier,
  type ETraceRetrievalResult,
  type ETraceRetrievalOpts,
} from './etraces.js';
export {
  compressToolOutput,
  shouldEarlyExit,
  buildEarlyExitNudge,
  type TokenSavingConfig,
  DEFAULT_TOKEN_SAVING_CONFIG,
} from './tokenSaving.js';
export { buildChainOfDraftBlock, CHAIN_OF_DRAFT_DIRECTIVE } from './chainOfDraft.js';
export {
  withPromptCaching,
  isCachingSupportedModel,
  hasCacheBreakpoint,
  type CacheControlBlock,
  type CacheableMessage,
} from './promptCaching.js';
export {
  SteeringPipeline,
  type SteeringContext,
  type SteeringResult,
  type SteeringPipelineConfig,
  DEFAULT_STEERING_CONFIG,
} from './steering.js';
export {
  createManagerInterventionListener,
  type StuckEventPayload,
  type ManagerInterventionConfig,
  DEFAULT_MANAGER_INTERVENTION_CONFIG,
} from './managerIntervention.js';

// ── Model routing ─────────────────────────────────────────────────

import type { FSMState } from './fsm.js';

/**
 * Map FSM state to a model tier for routing.
 * The managed agent loop can use this to switch models mid-run.
 */
export function fsmStateToModelTier(state: FSMState): 'cheap' | 'default' | 'expensive' | 'skip' {
  switch (state) {
    case 'FAST':
      return 'cheap';
    case 'NORMAL':
      return 'default';
    case 'SLOW':
      return 'expensive';
    case 'SKIP':
      return 'skip';
    default:
      return 'default';
  }
}

/**
 * Suggest a model for a given FSM state and current model.
 * Returns a model ID string, or null if no change is needed.
 *
 * For OpenRouter managed models, we suggest cheaper/expensive variants
 * within the same provider family.
 */
export function suggestModelForFSMState(
  state: FSMState,
  currentModel: string,
): string | null {
  const tier = fsmStateToModelTier(state);
  if (tier === 'default' || tier === 'skip') return null;

  const lower = currentModel.toLowerCase();

  // Anthropic family
  if (lower.includes('claude') || lower.includes('anthropic')) {
    if (tier === 'cheap') {
      if (lower.includes('opus') || lower.includes('sonnet')) {
        return currentModel.replace(/opus|sonnet/i, 'haiku');
      }
      return null; // already on haiku
    }
    if (tier === 'expensive') {
      if (lower.includes('haiku') || lower.includes('sonnet')) {
        return currentModel.replace(/haiku|sonnet/i, 'opus');
      }
      return null; // already on opus
    }
  }

  // OpenAI family
  if (lower.includes('gpt') || lower.includes('openai')) {
    if (tier === 'cheap' && lower.includes('gpt-4')) {
      return currentModel.replace(/gpt-4[^\s/]*/, 'gpt-4o-mini');
    }
    if (tier === 'expensive' && lower.includes('mini')) {
      return currentModel.replace(/mini/i, '');
    }
    return null;
  }

  // Google family
  if (lower.includes('gemini') || lower.includes('google')) {
    if (tier === 'cheap' && lower.includes('pro')) {
      return currentModel.replace(/pro/i, 'flash');
    }
    if (tier === 'expensive' && lower.includes('flash')) {
      return currentModel.replace(/flash/i, 'pro');
    }
    return null;
  }

  // Unknown family — no routing suggestion
  return null;
}

// ── Brain tags ────────────────────────────────────────────────────

/**
 * Brain tags used by LazyReasoningBlocks for storing patterns and traces.
 * These are used in CaptureEvent.tags when writing to the brain.
 */
export const LAZY_REASONING_TAGS = {
  e1: 'lazyreasoning:etrace-e1',
  e2: 'lazyreasoning:etrace-e2',
  e3: 'lazyreasoning:etrace-e3',
  fsm: 'lazyreasoning:fsm',
  monitor: 'lazyreasoning:monitor',
  steering: 'lazyreasoning:steering',
} as const;
