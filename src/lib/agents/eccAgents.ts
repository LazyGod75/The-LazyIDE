/* eccAgents.ts — Built-in ECC agent library (73 agents: 67 from
   github.com/affaan-m/ECC plus 6 content/creative agents added locally —
   see ecc/index.ts's header comment).
   These are read-only presets that users can run, favorite, or duplicate into their own scope.
   Generated from the ECC repo agent definitions.
*/

/* Split into src/lib/agents/ecc/ (one data module per agent) to respect the file-size limit.
   This file now only re-exports the same public API: EccAgent, ECC_AGENTS, eccToLazyAgent. */

export type { EccAgent } from './ecc/eccAgentTypes.js';
export { ECC_AGENTS, eccToLazyAgent } from './ecc/index.js';
