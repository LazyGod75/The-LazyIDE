/* Caveman compression engine.
   Compresses prose in chat messages by applying rule-based transformations:
   filler removal, context condensation, structural compression, dedup, ultra abbreviations.
   Code blocks, URLs, paths, identifiers, and other technical tokens are preserved byte-perfect. */

import type {
  CavemanConfig,
  CompressionResult,
  CompressionStats,
} from './types.js';
import { DEFAULT_CAVEMAN_CONFIG } from './types.js';
import { CAVEMAN_RULES, getRulesForContext, applyRulesToText } from './cavemanRules.js';
import {
  extractPreservedBlocks,
  restorePreservedBlocks,
  hasProtectedStructure,
} from './preservation.js';

const CHARS_PER_TOKEN = 4;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

function createStats(
  originalTokens: number,
  compressedTokens: number,
  rulesApplied: string[],
  durationMs: number,
): CompressionStats {
  const savingsPercent =
    originalTokens > 0
      ? Math.round(((originalTokens - compressedTokens) / originalTokens) * 10000) / 100
      : 0;
  return {
    originalTokens,
    compressedTokens,
    savingsPercent,
    mode: 'standard',
    timestamp: Date.now(),
    rulesApplied: rulesApplied.length > 0 ? rulesApplied : undefined,
    durationMs,
  };
}

// ── Cleanup helpers ────────────────────────────────────────────────────

function isHorizontalWhitespace(char: string): boolean {
  return char === ' ' || char === '\t';
}

function isSentencePunctuation(char: string): boolean {
  return char === '.' || char === '!' || char === '?';
}

function isCleanupPunctuation(char: string): boolean {
  return char === ',' || char === '.' || char === ';' || char === ':' || char === '!' || char === '?';
}

function hasRepeatedHorizontalWhitespace(text: string): boolean {
  let prevWs = false;
  for (const char of text) {
    const isWs = isHorizontalWhitespace(char);
    if (isWs && prevWs) return true;
    prevWs = isWs;
  }
  return false;
}

function collapseHorizontalWhitespaceRuns(text: string): string {
  let output = '';
  let changed = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (!isHorizontalWhitespace(char)) {
      output += char;
      continue;
    }
    const start = i;
    while (i + 1 < text.length && isHorizontalWhitespace(text[i + 1])) i++;
    if (i > start) {
      output += ' ';
      changed = true;
    } else {
      output += char;
    }
  }
  return changed ? output : text;
}

function removeHorizontalWhitespaceBeforePunctuation(text: string): string {
  let output = '';
  let changed = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (!isHorizontalWhitespace(char)) {
      output += char;
      continue;
    }
    const start = i;
    while (i + 1 < text.length && isHorizontalWhitespace(text[i + 1])) i++;
    const nextChar = text[i + 1];
    if (nextChar && isCleanupPunctuation(nextChar)) {
      changed = true;
      continue;
    }
    output += text.slice(start, i + 1);
  }
  return changed ? output : text;
}

function collapseRepeatedSentencePunctuation(text: string): string {
  let output = '';
  let changed = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (!isSentencePunctuation(char)) {
      output += char;
      continue;
    }
    let lastPunct = char;
    const start = i;
    while (i + 1 < text.length && isSentencePunctuation(text[i + 1])) {
      i++;
      lastPunct = text[i];
    }
    if (i > start) changed = true;
    output += lastPunct;
  }
  return changed ? output : text;
}

function trimEndHorizontalWhitespace(text: string): string {
  let end = text.length;
  while (end > 0 && isHorizontalWhitespace(text[end - 1])) end--;
  return end === text.length ? text : text.slice(0, end);
}

function stripLineTrailingHorizontalWhitespace(text: string): string {
  const lines = text.split('\n');
  let changed = false;
  const cleaned = lines.map((line) => {
    const c = trimEndHorizontalWhitespace(line);
    if (c !== line) changed = true;
    return c;
  });
  return changed ? cleaned.join('\n') : text;
}

function collapseExcessNewlines(text: string): string {
  let output = '';
  let changed = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char !== '\n') {
      output += char;
      continue;
    }
    const start = i;
    while (i + 1 < text.length && text[i + 1] === '\n') i++;
    const count = i - start + 1;
    if (count > 2) {
      output += '\n\n';
      changed = true;
    } else {
      output += text.slice(start, i + 1);
    }
  }
  return changed ? output : text;
}

function trimLeadingNewlines(text: string): string {
  let start = 0;
  while (start < text.length && text[start] === '\n') start++;
  return start === 0 ? text : text.slice(start);
}

function trimTrailingNewlines(text: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === '\n') end--;
  return end === text.length ? text : text.slice(0, end);
}

function recapitalizeSentences(text: string): string {
  return text.replace(/(^|[.!?][ \t]|\n[ \t]*)([a-z])/g, (_match, prefix: string, char: string) => {
    return `${prefix}${char.toUpperCase()}`;
  });
}

function cleanupArtifacts(text: string): string {
  let result = text;
  if (hasRepeatedHorizontalWhitespace(result)) {
    result = collapseHorizontalWhitespaceRuns(result);
  }
  result = removeHorizontalWhitespaceBeforePunctuation(result);
  result = collapseRepeatedSentencePunctuation(result);
  if (result.includes(' \n') || result.includes('\t\n')) {
    result = stripLineTrailingHorizontalWhitespace(result);
  }
  if (result.endsWith(' ') || result.endsWith('\t')) result = result.trimEnd();
  if (result.includes('\n\n\n')) result = collapseExcessNewlines(result);
  if (result.startsWith('\n')) result = trimLeadingNewlines(result);
  if (result.endsWith('\n')) result = trimTrailingNewlines(result);
  return result;
}

// ── Public API ─────────────────────────────────────────────────────────

export interface SimpleMessage {
  role: string;
  content: string;
}

/**
 * Compress an array of chat messages using the Caveman engine.
 * Returns compressed messages + stats. When disabled or no messages, returns
 * the original messages unchanged with a zero-savings stats block.
 */
export function cavemanCompress(
  messages: SimpleMessage[],
  options?: Partial<CavemanConfig>,
): CompressionResult {
  const startMs = performance.now();
  const config: CavemanConfig = { ...DEFAULT_CAVEMAN_CONFIG, ...options };

  const emptyResult = (): CompressionResult => ({
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
    compressed: false,
    stats: createStats(0, 0, [], 0),
  });

  if (!config.enabled) return emptyResult();
  if (!messages || messages.length === 0) return emptyResult();

  let totalOriginalTokens = 0;
  let totalCompressedTokens = 0;
  const allAppliedRules: string[] = [];

  const compressedMessages = messages.map((msg): SimpleMessage => {
    const contentStr = typeof msg.content === 'string' ? msg.content : '';
    totalOriginalTokens += estimateTokens(contentStr);

    if (!contentStr || contentStr.length < config.minMessageLength) {
      totalCompressedTokens += estimateTokens(contentStr);
      return { role: msg.role, content: contentStr };
    }

    if (!config.compressRoles.includes(msg.role as 'user' | 'assistant' | 'system')) {
      totalCompressedTokens += estimateTokens(contentStr);
      return { role: msg.role, content: contentStr };
    }

    const compressTextPart = (textPart: string): string => {
      if (!textPart || textPart.length < config.minMessageLength) return textPart;

      const shouldPreserve = hasProtectedStructure(textPart);
      const { text: extractedText, blocks } = shouldPreserve
        ? extractPreservedBlocks(textPart)
        : { text: textPart, blocks: [] };

      const rules = getRulesForContext(msg.role, config.intensity).filter(
        (rule) => !config.skipRules.includes(rule.name),
      );
      const { text: rulesApplied, appliedRules } = applyRulesToText(extractedText, rules);
      allAppliedRules.push(...appliedRules);

      const normalized = recapitalizeSentences(cleanupArtifacts(rulesApplied));
      const cleaned =
        blocks.length > 0
          ? cleanupArtifacts(restorePreservedBlocks(normalized, blocks))
          : normalized;

      return cleaned;
    };

    const cleaned = compressTextPart(contentStr);
    totalCompressedTokens += estimateTokens(cleaned);
    return { role: msg.role, content: cleaned };
  });

  const durationMs = Math.round(performance.now() - startMs);

  return {
    messages: compressedMessages,
    compressed: allAppliedRules.length > 0,
    stats: createStats(totalOriginalTokens, totalCompressedTokens, allAppliedRules, durationMs),
  };
}

export { CAVEMAN_RULES };
