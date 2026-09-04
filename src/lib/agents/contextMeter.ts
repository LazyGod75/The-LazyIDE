/* contextMeter.ts — Smart-zone context meter (G4).

   Makes the deck's "smart zone" visible: the context window is not
   uniform — the first ~40% is where the model thinks clearly; past that,
   attention frays, tool choice gets sloppy, instructions get dropped.
   Static fills (system prompt, tool definitions, injected blocks) shrink
   the smart zone BEFORE the conversation starts.

   This module estimates, for a mission, how much of the window is
   consumed by each harness component and how much room is left in the
   smart zone. It is a PURE estimator over strings — no I/O — so it is
   unit-testable and safe to call from any renderer.

   The UI surfaces this in MissionDetail/LiveMissionPanel; the estimator
   itself only computes and never mutates.
*/

import { estimateTokens } from '../brain/context.js';

// ── Constants ──────────────────────────────────────────────────────

/** Default context window the app targets (tokens). */
export const DEFAULT_WINDOW_TOKENS = 200_000;
/** Fraction of the window treated as the "smart zone" (deck: ~40%). */
export const SMART_ZONE_FRACTION = 0.4;
/** Token budget each harness component may consume, per design. */
export const COMPONENT_BUDGETS = {
  systemPrompt: 6500,
  toolDefinitions: 9500,
  rules: 1200,
  brainContext: 2000,
  skills: 900,
  projectState: 800,
  startupContext: 400,
  history: 0, // grows at runtime
} as const;

// ── Types ──────────────────────────────────────────────────────────

export interface ContextComponentReading {
  component: keyof typeof COMPONENT_BUDGETS | 'history';
  label: string;
  tokens: number;
  budget: number;
  overBudget: boolean;
}

export interface ContextMeter {
  windowTokens: number;
  smartZoneTokens: number;
  totalUsedTokens: number;
  staticTokens: number;
  smartZoneUsedPct: number;
  smartZoneFreeTokens: number;
  components: ContextComponentReading[];
  /** True when static fills alone consume more than the smart zone. */
  allocationProblem: boolean;
}

// ── Pure estimator ─────────────────────────────────────────────────

/**
 * Estimate the context breakdown for a mission. Pure.
 *
 * `inputs` carries the raw strings the harness will inject; `historyTokens`
 * is the (estimated) current conversation history. Each component is
 * measured against its design budget so the UI can flag over-budget fills.
 */
export function measureContext(
  inputs: {
    systemPrompt?: string;
    toolDefinitions?: string;
    rulesBlock?: string;
    brainContext?: string;
    skillsBlock?: string;
    projectStateBlock?: string;
    startupContext?: string;
  },
  opts: {
    windowTokens?: number;
    historyTokens?: number;
  } = {},
): ContextMeter {
  const windowTokens = opts.windowTokens ?? DEFAULT_WINDOW_TOKENS;
  const smartZoneTokens = Math.round(windowTokens * SMART_ZONE_FRACTION);
  const historyTokens = opts.historyTokens ?? 0;

  const readings: ContextComponentReading[] = [
    makeReading('systemPrompt', 'System prompt', inputs.systemPrompt),
    makeReading('toolDefinitions', 'Tool definitions', inputs.toolDefinitions),
    makeReading('rules', 'Harness rules', inputs.rulesBlock),
    makeReading('brainContext', 'Brain context', inputs.brainContext),
    makeReading('skills', 'Skills', inputs.skillsBlock),
    makeReading('projectState', 'Project state', inputs.projectStateBlock),
    makeReading('startupContext', 'Startup context', inputs.startupContext),
  ];

  const staticTokens = readings.reduce((sum, r) => sum + r.tokens, 0);
  const totalUsedTokens = staticTokens + historyTokens;
  const smartZoneUsedPct = smartZoneTokens > 0
    ? Math.round((totalUsedTokens / smartZoneTokens) * 100)
    : 0;
  const smartZoneFreeTokens = Math.max(0, smartZoneTokens - totalUsedTokens);

  return {
    windowTokens,
    smartZoneTokens,
    totalUsedTokens,
    staticTokens,
    smartZoneUsedPct,
    smartZoneFreeTokens,
    components: readings,
    allocationProblem: staticTokens > smartZoneTokens,
  };
}

function makeReading(
  component: ContextComponentReading['component'],
  label: string,
  value: string | undefined,
): ContextComponentReading {
  const tokens = estimateTokens(value ?? '');
  const budget = component === 'history'
    ? 0
    : COMPONENT_BUDGETS[component] ?? 0;
  return {
    component,
    label,
    tokens,
    budget,
    overBudget: budget > 0 && tokens > budget,
  };
}

/**
 * Build a short human-readable summary line for the UI. Pure.
 */
export function summarizeContext(meter: ContextMeter): string {
  const pct = meter.smartZoneUsedPct;
  if (meter.allocationProblem) {
    return `Allocation problem: static fills consume ${meter.staticTokens} tokens — beyond the ${meter.smartZoneTokens}-token smart zone before the run starts.`;
  }
  if (pct > 90) {
    return `Smart zone nearly full (${pct}%) — ${meter.smartZoneFreeTokens} tokens free. Consider splitting the task.`;
  }
  return `Smart zone: ${pct}% used (${meter.totalUsedTokens}/${meter.smartZoneTokens} tokens), ${meter.smartZoneFreeTokens} free.`;
}
