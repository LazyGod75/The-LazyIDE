/* lazyReasoningBlocks/managerIntervention.ts — Second safety net.
   Listens for 'lazyreasoning:stuck' bus events and intervenes by:
   1. Doing a cross-project brain search for similar past patterns
   2. Injecting the result via the existing interveneQueues canal

   This is NOT a first-line intervention — the agent's own monitors,
   E-traces, and FSM steering run first. This module only fires when
   the agent has been stuck (SLOW/SKIP for 3+ consecutive steps) AFTER
   self-steering already tried.

   The injection goes through the same drainIntervenes mechanism the
   user's manual interventions use — no new injection path, no new
   canal. The agent receives it as a [Manager intervention] user message
   at the next step boundary.
*/

import { on } from '../../bus.js';
import { getPlatform } from '../../platform/index.js';

// ── Types ─────────────────────────────────────────────────────────

export interface StuckEventPayload {
  missionId: string;
  fsmState: string;
  consecutiveHardSteps: number;
  failureType: string | null;
  task: string;
}

export interface ManagerInterventionConfig {
  /** Whether the second safety net is enabled. */
  enabled: boolean;
  /** Max brain search results to inject. */
  maxResults: number;
  /** Max chars per intervention text. */
  maxChars: number;
}

export const DEFAULT_MANAGER_INTERVENTION_CONFIG: ManagerInterventionConfig = {
  enabled: true,
  maxResults: 3,
  maxChars: 2000,
};

// ── Intervention ──────────────────────────────────────────────────

/**
 * Search the brain for patterns relevant to the stuck agent's task and
 * failure type. Returns a formatted intervention text, or null if no
 * relevant patterns were found.
 */
async function searchBrainForHelp(
  task: string,
  failureType: string | null,
  config: ManagerInterventionConfig,
): Promise<string | null> {
  try {
    const platform = getPlatform();
    if (!platform?.brain?.searchScoped) return null;

    // Search across ALL project brains for relevant past patterns
    const query = failureType
      ? `agent stuck ${failureType} ${task.slice(0, 100)}`
      : `agent stuck difficult ${task.slice(0, 100)}`;
    const results = await platform.brain.searchScoped(query, 'all', config.maxResults);

    if (results.length === 0) return null;

    // Filter for lazyreasoning or diagnosis patterns
    const relevant = results.filter(
      (r) =>
        r.snippet.includes('lazyreasoning') ||
        r.snippet.includes('diagnosis') ||
        r.snippet.includes('pattern') ||
        r.snippet.includes('fix') ||
        r.snippet.includes('error'),
    );

    if (relevant.length === 0) return null;

    const parts = relevant.map((r) => {
      const title = r.title.slice(0, 100);
      const snippet = r.snippet.slice(0, 500);
      return `• ${title}: ${snippet}`;
    });

    const text = `[Manager intervention — LazyReasoningBlocks second safety net]\nThe LazyManager detected you are stuck (difficulty: ${failureType ?? 'general'}). Here are relevant patterns from past missions:\n\n${parts.join('\n\n')}`;

    return text.slice(0, config.maxChars);
  } catch {
    return null;
  }
}

/**
 * Create the manager intervention listener. Returns a cleanup function
 * that unregisters the bus listener.
 *
 * The injectFn parameter is the callback that pushes text into the
 * mission's intervene queue — in production this is wired to
 * agentsStore's interveneQueues.current.get(missionId).
 */
export function createManagerInterventionListener(
  injectFn: (missionId: string, text: string) => void,
  config: ManagerInterventionConfig = DEFAULT_MANAGER_INTERVENTION_CONFIG,
): () => void {
  if (!config.enabled) return () => {};

  const handler = async (payload: StuckEventPayload) => {
    const helpText = await searchBrainForHelp(payload.task, payload.failureType, config);
    if (helpText) {
      injectFn(payload.missionId, helpText);
    }
  };

  const cleanup = on('lazyreasoning:stuck', handler);

  return () => {
    cleanup();
  };
}
