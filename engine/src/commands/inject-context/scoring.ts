/**
 * scoring.ts — Scoring helpers for inject-context.
 *
 * Owns: isTrivialPrompt, noteMatchesActiveFile, applyActiveFileBoost,
 *       detectQueryIntent, selectiveStripForTurn.
 *
 * Extracted from inject-context.ts for size reduction.
 */

import type { ResolvedHit } from '../../retrieval/router.js';
import { type StrippedNote, stripNoteToPrompt, stripSection } from '../../retrieval/strip.js';
import { readNote } from '../../store/reader.js';

// ---------------------------------------------------------------------------
// Trivial-prompt detection
// ---------------------------------------------------------------------------

const MARKER_TRIVIAL_PROMPTS = new Set([
  'ok',
  'okay',
  'yes',
  'no',
  'continue',
  'go',
  'next',
  'merci',
  'thanks',
  'thx',
  'oui',
  'non',
  'cool',
  'parfait',
  'good',
  'nice',
  'stop',
  'wait',
  'super',
  'sure',
  'fine',
  'great',
  'allez',
  'vas-y',
  'go ahead',
  'roger',
  'done',
  'noted',
  'understood',
  'compris',
  'ack',
  'k',
  'kk',
  'yep',
  'nope',
]);

// Q5: triggers that explicitly *ask* for memory recall. Presence of any of
// these patterns forces a recall attempt even on short prompts.
const MEMORY_TRIGGERS = [
  /\b(did we|have we|what did we|we discussed|we decided|earlier|previously|last time|before)\b/i,
  /\b(rappel|rappelle|on a vu|on a déjà|on a fait|déjà parlé|déjà vu|on avait|tu te souviens)\b/i,
  /\b(remember|recall|past|history|context)\b/i,
  /#[a-z0-9-]{4,}/, // references to a short id from prior inject
];

// Q5: prompts that look like pure tool output, code, or pasted error — no
// memory needed because the context is right there in the prompt.
const SELF_CONTAINED_PATTERNS = [
  /^\s*[{[]/, // JSON / array dumps
  /^\s*\$\s/, // shell prompt prefix
  /^\s*(?:error|warning|exception|traceback|stderr|stdout):/i,
  /^\s*\/[a-z-]+(?:\s|$)/i, // slash command at start of line
];

export function queryLooksLikeCodeSymbol(text: string): boolean {
  const token = text.trim();
  if (!token) return false;
  if (/[\\/]/.test(token) && /\.\w{1,8}$/.test(token)) return true;
  if (/[A-Z][a-z]+[A-Z]/.test(token)) return true;
  if (/_/.test(token) && /[A-Za-z]/.test(token)) return true;
  return false;
}

export function isTrivialPrompt(prompt: string): boolean {
  const trimmed = prompt.trim();
  const norm = trimmed.toLowerCase().replace(/[!?.,;:]+$/g, '');
  if (MARKER_TRIVIAL_PROMPTS.has(norm)) return true;
  for (const re of MEMORY_TRIGGERS) {
    if (re.test(trimmed)) return false;
  }
  for (const re of SELF_CONTAINED_PATTERNS) {
    if (re.test(trimmed)) return true;
  }
  // Agents look up symbols by name (`rotateRefreshToken`, `src/auth.ts`).
  // Those are recall queries, not "ok"/"merci" acks — the word-count heuristic
  // below used to classify a single camelCase identifier as trivial and the
  // warm sidecar returned tokens:0 for the exact export the brain stored.
  if (queryLooksLikeCodeSymbol(trimmed) || trimmed.split(/\s+/).some(queryLooksLikeCodeSymbol)) {
    return false;
  }
  if (norm.length < 12) return true;
  const wordCount = norm.split(/\s+/).filter((w) => /[a-zà-ÿ]{2,}/i.test(w)).length;
  if (wordCount < 3 && trimmed.length < 80) return true;
  return false;
}

/** Keep hits at/above minScore. Absolute floors stay for normal BM25
 *  (L1 0.3 vs 0.5 must still drop). When IDF collapse drives EVERY score
 *  orders of magnitude below the floor (L2 ~1e-6 vs 0.01 — the token lives
 *  in every file-neuron), keep the relative near-best set instead of
 *  returning empty recall. */
export function hitsPassingMinScore<T extends { id: string; score: number }>(
  hits: readonly T[],
  minScore: number,
  seen: ReadonlySet<string>,
): T[] {
  const unseen = hits.filter((h) => !seen.has(h.id));
  if (unseen.length === 0) return [];
  let maxScore = 0;
  for (const h of unseen) {
    if (h.score > maxScore) maxScore = h.score;
  }
  if (maxScore <= 0) return [];
  const collapsed = maxScore < minScore * 0.01;
  const floor = collapsed ? maxScore * 0.5 : minScore;
  return unseen.filter((h) => h.score >= floor);
}

// ---------------------------------------------------------------------------
// Active file boost
// ---------------------------------------------------------------------------

/** Normalize a file path for comparison: lower-case, forward slashes only. */
function normalizePath(p: string): string {
  return p.toLowerCase().replace(/\\/g, '/');
}

/**
 * Pure helper — returns true when a note's HTML attributes indicate it belongs
 * to one of the active file paths.
 *
 * Two matching strategies (either is sufficient):
 *   1. data-cerveau-cwd is a prefix of an active path (note covers a directory
 *      that contains the active file).
 *   2. data-code-file basename equals the basename of an active path (file-neuron
 *      for the exact file that was touched).
 *
 * Both comparisons are case-insensitive and normalize path separators.
 *
 * @param rawHtml     Raw HTML string of the note (may be empty/undefined-safe).
 * @param activePaths Current active working-set paths for the session.
 */
export function noteMatchesActiveFile(rawHtml: string, activePaths: readonly string[]): boolean {
  if (!rawHtml || activePaths.length === 0) return false;

  const cwdMatch = rawHtml.match(/data-cerveau-cwd\s*=\s*["']([^"']+)["']/i);
  const codeFileMatch = rawHtml.match(/data-code-file\s*=\s*["']([^"']+)["']/i);

  const noteCwd = cwdMatch ? normalizePath(cwdMatch[1]) : null;
  const noteCodeFile = codeFileMatch ? normalizePath(codeFileMatch[1]) : null;
  const noteBasename = noteCodeFile ? (noteCodeFile.split('/').pop() ?? '') : null;

  for (const active of activePaths) {
    const norm = normalizePath(active);
    // Strategy 1: note's cwd is a directory prefix of the active path.
    if (noteCwd && norm.startsWith(noteCwd.endsWith('/') ? noteCwd : `${noteCwd}/`)) {
      return true;
    }
    // Strategy 2: note's code-file basename matches active file basename.
    if (noteBasename) {
      const activeBasename = norm.split('/').pop() ?? '';
      if (activeBasename && activeBasename === noteBasename) return true;
    }
  }
  return false;
}

/**
 * Feature C — Active working set boost.
 * Multiplicative score boost applied to hits whose note is associated with
 * a file the user recently touched in this session.
 */
const ACTIVE_FILE_BOOST = 1.4;

/**
 * Apply ACTIVE_FILE_BOOST to hits whose note belongs to an active file.
 * Returns a NEW array sorted descending by boosted score (immutable).
 *
 * Uses hit.rawHtml when available (populated by route() with hydrateNote:true)
 * to avoid a second disk read. Falls back to readNote() only when rawHtml is
 * absent (e.g. L1 path-prefix hits that bypass hydration). Gracefully skips
 * the boost (no crash) when the file cannot be read.
 */
export function applyActiveFileBoost(
  hits: readonly ResolvedHit[],
  activePaths: string[],
): ResolvedHit[] {
  const boosted = hits.map((hit) => {
    let rawHtml = hit.rawHtml ?? '';
    if (!rawHtml) {
      try {
        rawHtml = readNote(hit.path).html;
      } catch {
        // Non-fatal — note may not exist on disk yet
      }
    }
    const multiplier = noteMatchesActiveFile(rawHtml, activePaths) ? ACTIVE_FILE_BOOST : 1;
    return { ...hit, score: hit.score * multiplier };
  });
  return boosted.sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Query intent detection and selective stripping
// ---------------------------------------------------------------------------

export type QueryIntent = 'reasoning' | 'warning' | 'quick' | 'detailed';

export function detectQueryIntent(query: string): QueryIntent {
  const lower = query.toLowerCase().trim();
  const words = lower.split(/\s+/).filter(Boolean);

  // Reasoning: why/how/explain questions
  if (/^(why|how|explain|pourquoi|comment)\b/i.test(lower)) return 'reasoning';

  // Warning: should/can/avoid/risk questions
  if (/^(should|can|could|avoid|risk|danger|warning|attention|est-ce que)\b/i.test(lower))
    return 'warning';
  if (/\b(safe|careful|pitfall|anti.?pattern|don'?t)\b/i.test(lower)) return 'warning';

  // Quick: short queries (< 5 words, no question words)
  if (words.length <= 4 && !/\?$/.test(lower)) return 'quick';

  // Default: detailed
  return 'detailed';
}

export function selectiveStripForTurn(
  hitPath: string,
  note: StrippedNote,
  intent: QueryIntent,
): string {
  if (intent === 'detailed') {
    return stripNoteToPrompt(note);
  }

  // Try to read the raw HTML for selective stripping
  let rawHtml: string;
  try {
    const noteFile = readNote(hitPath);
    rawHtml = noteFile.html;
  } catch {
    // Fallback to full strip if we can't read the file
    return stripNoteToPrompt(note);
  }

  const TYPE_LETTER: Record<string, string> = {
    decision: 'D',
    episodic: 'E',
    reference: 'R',
    semantic: 'S',
    procedural: 'P',
  };
  const header = `${TYPE_LETTER[note.type ?? ''] ?? '·'} ${(note.created ?? '').slice(0, 10)} #${(note.id ?? '').replace(/^\d{4}-\d{2}-\d{2}-/, '').slice(0, 32)}`;

  if (intent === 'quick') {
    // TLDR only — minimal tokens
    const tldr = stripSection(rawHtml, 'section[data-section="tldr"]');
    if (tldr) return `${header}\n  ${tldr}`;
    // Fallback: first fact
    const summary = stripSection(rawHtml, 'details[open] summary');
    if (summary) return `${header}\n  ${summary}`;
    return stripNoteToPrompt(note);
  }

  if (intent === 'reasoning') {
    // Reasoning section + TLDR for context
    const tldr = stripSection(rawHtml, 'section[data-section="tldr"]');
    const reasoning = stripSection(rawHtml, 'section[data-section="reasoning"]');
    const parts = [header];
    if (tldr) parts.push(`  ${tldr}`);
    if (reasoning) parts.push(`  [reasoning] ${reasoning}`);
    if (parts.length > 1) return parts.join('\n');
    return stripNoteToPrompt(note);
  }

  if (intent === 'warning') {
    // Warnings + TLDR
    const tldr = stripSection(rawHtml, 'section[data-section="tldr"]');
    const warnings = stripSection(rawHtml, 'aside[role="doc-warning"]');
    const tips = stripSection(rawHtml, 'aside[role="doc-tip"]');
    const parts = [header];
    if (tldr) parts.push(`  ${tldr}`);
    if (warnings) parts.push(`  [WARNING] ${warnings}`);
    if (tips) parts.push(`  [TIP] ${tips}`);
    if (parts.length > 1) return parts.join('\n');
    return stripNoteToPrompt(note);
  }

  return stripNoteToPrompt(note);
}
