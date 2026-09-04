/* Compression module — public API.
   Simplified for Lazy IDE.

   Usage:
     import { compressMessages } from '@/lib/compression';
     const { messages, stats } = compressMessages(messages, { intensity: 'full' });
*/

export { cavemanCompress } from './caveman.js';
export type { SimpleMessage } from './caveman.js';
export {
  CAVEMAN_RULES,
  getRulesForContext,
  getRuleByName,
  applyRulesToText,
} from './cavemanRules.js';
export {
  extractPreservedBlocks,
  restorePreservedBlocks,
  hasProtectedStructure,
} from './preservation.js';
export type {
  CompressionMode,
  CavemanIntensity,
  CavemanRule,
  CavemanConfig,
  CompressionStats,
  CompressionResult,
} from './types.js';
export { DEFAULT_CAVEMAN_CONFIG } from './types.js';

import type { CavemanConfig, CompressionStats } from './types.js';
import { cavemanCompress } from './caveman.js';
import type { SimpleMessage } from './caveman.js';

/**
 * Compress an array of { role, content } messages using the Caveman engine.
 * Convenience wrapper that returns the compressed messages array directly
 * (stats available via the second return value).
 */
export function compressMessages(
  messages: SimpleMessage[],
  options?: Partial<CavemanConfig>,
): { messages: SimpleMessage[]; stats: CompressionStats; compressed: boolean } {
  const result = cavemanCompress(messages, options);
  return {
    messages: result.messages,
    stats: result.stats,
    compressed: result.compressed,
  };
}

