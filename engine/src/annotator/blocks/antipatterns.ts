import { detectDpubRoleForFact, enrichFactWithSemantics, esc } from './helpers.js';
import type { Fact, InAntipatterns } from './types.js';

// Bare-timestamp pattern — e.g. "16:45." or "20:15" with optional trailing dot/space.
const BARE_TIMESTAMP_RE = /^\s*\d{1,2}:\d{2}\.?\s*$/;

// Tool-output marker: starts with ===/---/>>>/$ or contains 2+ occurrences of ===.
const TOOL_OUTPUT_START_RE = /^\s*(===|---|>>>|\$\s)/;
function hasToolOutputMarkers(text: string): boolean {
  const count = (text.match(/===/g) ?? []).length;
  return count >= 2;
}

// Causal/failure verb required for bare kind==='error' facts (no keyword match).
// French alternatives are appended without \b boundaries (JS's \b is
// ASCII-\w-only and would fail to match right at an accented final letter,
// e.g. "échoué", "entraîné") — same convention as errors.ts's French mirror.
const FAILURE_VERB_RE =
  /\b(?:failed|broke|crashed|error|because|caused|resulted)\b|(?:échoué|cassé|planté|erreur|parce que|causé|entraîné)/i;

// Keyword pattern that makes a fact an anti-pattern candidate regardless of kind.
const ANTIPATTERN_KEYWORD_RE =
  /\b(?:don'?t|never|do not|abandoned|reverted|tried using|broke|avoid|skip|rollback|backed out|workaround|mistake|shouldn'?t|was wrong)\b|(?:ne pas|jamais|abandonné|annulé|cassé|éviter|erreur|ne devrait pas|était (?:faux|une erreur))/i;

/**
 * Quality gate for anti-pattern candidates.
 *
 * Returns true when the fact text passes all quality checks and is worth
 * surfacing as a warning.  Rejects:
 *  1. Fewer than 20 characters.
 *  2. Fewer than 4 alphanumeric words.
 *  3. Bare-timestamp text (e.g. "16:45.").
 *  4. Tool-output fragments (starts with ===, ---, >>>, $ or contains 2+ ===).
 *  5. For error-kind facts with no keyword match: requires a failure verb or
 *     causal token (failed|broke|crashed|error|because|caused|resulted).
 */
function passesQualityGate(fact: Fact): boolean {
  const text = fact.text;

  // 1. Minimum length
  if (text.length < 20) return false;

  // 2. Minimum alphanumeric word count
  const words = (text.match(/\b[a-zA-Z0-9][a-zA-Z0-9'_-]*\b/g) ?? []).length;
  if (words < 4) return false;

  // 3. Reject bare timestamps
  if (BARE_TIMESTAMP_RE.test(text)) return false;

  // 4. Reject tool-output fragments
  if (TOOL_OUTPUT_START_RE.test(text) || hasToolOutputMarkers(text)) return false;

  // 5. For error-kind facts that lack an explicit anti-pattern keyword,
  //    require at least one failure verb or causal token.
  const hasKeyword = ANTIPATTERN_KEYWORD_RE.test(text);
  if (fact.kind === 'error' && !hasKeyword) {
    if (!FAILURE_VERB_RE.test(text)) return false;
  }

  return true;
}

/**
 * Render anti-pattern section for "don't redo" warnings.
 * Detects all anti-pattern keywords and wraps with DPub roles.
 * Applies a quality gate to filter noise before rendering.
 * Returns empty string when no anti-patterns are detected.
 */
export function renderAntipatterns(input: InAntipatterns): string {
  const antiPatterns = input.facts.filter(
    (f) => (f.kind === 'error' || ANTIPATTERN_KEYWORD_RE.test(f.text)) && passesQualityGate(f),
  );
  if (antiPatterns.length === 0) return '';
  const items = antiPatterns.slice(0, 3).map((a) => {
    const role = detectDpubRoleForFact(a.text) ?? 'doc-warning';
    return `    <p role="${role}">${enrichFactWithSemantics(esc(a.text))}</p>`;
  });
  return [
    `  <aside role="doc-warning" data-section="antipatterns">`,
    `    <strong>Anti-patterns (don't redo):</strong>`,
    ...items,
    '  </aside>',
  ].join('\n');
}
