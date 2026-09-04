/* eccToLazyAgent.ts — split from eccAgents.ts (data-motion refactor, no content change). */

import type { LazyAgent } from '../agentDef.js';
import type { EccAgent } from './eccAgentTypes.js';

/** Convert an EccAgent to a full LazyAgent (for running/duplicating). */
export function eccToLazyAgent(ecc: EccAgent): LazyAgent {
  return {
    id: `ecc-${ecc.name}-${Date.now()}`,
    name: ecc.name,
    displayName: ecc.displayName,
    description: ecc.description,
    color: ecc.color,
    tags: ecc.tags,
    systemPrompt: ecc.systemPrompt,
    modelTier: ecc.modelTier,
    tools: ecc.tools,
    triggers: { manual: true },
    scope: 'project',
    createdAt: new Date().toISOString(),
  };
}
