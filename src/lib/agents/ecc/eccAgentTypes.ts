/* eccAgentTypes.ts — split from eccAgents.ts (data-motion refactor, no content change). */

import type { LazyAgent } from '../agentDef.js';

export interface EccAgent {
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  modelTier: LazyAgent['modelTier'];
  color: LazyAgent['color'];
  tags: string[];
  tools: { allow: string[] };
  source: 'ecc';
}
