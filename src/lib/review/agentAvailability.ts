/* agentAvailability.ts — shared "can an agent actually be launched right
   now" gate, lifted from ReviewSpace.tsx's private useAgentAvailable so the
   Code space's diff drawer / assistant "Envoie un agent" affordance can gate
   honestly on the same real routing table (ReviewSpace.tsx itself is left
   untouched). */

import { isManagedAgentAvailable, isLiveAgentAvailable } from '../agents/runtime.js';

/**
 * True when an agent can actually run a mission: either the managed (Pro)
 * backend is active, or a live CLI backend (claude/codex) is available.
 *
 * Mirrors the exact routing table planAndAct() uses in runtime.ts to
 * dispatch missions (isManagedAgentAvailable() checked before
 * isLiveAgentAvailable()) — gates agent-launch affordances on whether a
 * mission could really be launched, not on the presence of a local CLI
 * binary alone.
 */
export function useAgentAvailable(): boolean {
  return isManagedAgentAvailable() || isLiveAgentAvailable();
}
