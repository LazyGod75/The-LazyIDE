/* Compression pipeline types.
   Simplified for Lazy IDE: Caveman prose compression only, no RTK/LLMLingua. */

export type CompressionMode = 'off' | 'lite' | 'standard' | 'aggressive' | 'ultra';
export type CavemanIntensity = 'lite' | 'full' | 'ultra';

export interface CavemanRule {
  name: string;
  pattern: RegExp;
  replacement: string | ((match: string, ...groups: string[]) => string);
  context: 'all' | 'user' | 'system' | 'assistant';
  category?: 'filler' | 'context' | 'structural' | 'dedup' | 'terse' | 'ultra';
  description?: string;
  minIntensity?: CavemanIntensity;
}

export interface CavemanConfig {
  enabled: boolean;
  compressRoles: ('user' | 'assistant' | 'system')[];
  skipRules: string[];
  minMessageLength: number;
  preservePatterns: string[];
  intensity: CavemanIntensity;
}

export interface CompressionStats {
  originalTokens: number;
  compressedTokens: number;
  savingsPercent: number;
  mode: CompressionMode;
  timestamp: number;
  rulesApplied?: string[];
  durationMs?: number;
}

export interface CompressionResult {
  messages: Array<{ role: string; content: string }>;
  compressed: boolean;
  stats: CompressionStats;
}

export const DEFAULT_CAVEMAN_CONFIG: CavemanConfig = {
  enabled: true,
  compressRoles: ['user', 'assistant'],
  skipRules: [],
  minMessageLength: 20,
  preservePatterns: [],
  intensity: 'full',
};

const INTENSITY_RANK: Record<CavemanIntensity, number> = { lite: 0, full: 1, ultra: 2 };

export function intensityRank(i: CavemanIntensity): number {
  return INTENSITY_RANK[i] ?? INTENSITY_RANK.full;
}
