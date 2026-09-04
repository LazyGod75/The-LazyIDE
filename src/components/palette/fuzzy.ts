/* fuzzy.ts — simple fuzzy scorer for the command palette.
   Returns a score ≥ 0 (higher = better). 0 means no match.
   Strategy: subsequence match with bonuses for consecutive chars
   and word-boundary matches.
*/

export interface FuzzyResult {
  score: number;
  indices: number[]; // matched char positions in the haystack
}

// QA fix (B8): accent-insensitive matching — normalize diacritics out of
// both needle and haystack (NFD decompose + strip combining marks) so a
// plain-ASCII query like "theme" matches an accented label like "Thème".
// Applied before lowercasing; indices still map 1:1 onto the ORIGINAL
// haystack because Unicode NFD normalization never changes string length
// for the Latin-1 accented characters this app's locales use (each
// precomposed char decomposes to exactly one base char + one combining
// mark, and the combining mark is stripped — net length unchanged).
const COMBINING_MARKS_RE = new RegExp('[\\u0300-\\u036f]', 'g');

function normalizeForSearch(s: string): string {
  return s.normalize('NFD').replace(COMBINING_MARKS_RE, '');
}

export function fuzzyScore(needle: string, haystack: string): FuzzyResult {
  if (!needle) return { score: 1, indices: [] };

  const n = normalizeForSearch(needle).toLowerCase();
  const h = normalizeForSearch(haystack).toLowerCase();

  let nIdx = 0;
  let hIdx = 0;
  const indices: number[] = [];
  let score = 0;
  let prevMatch = false;

  while (nIdx < n.length && hIdx < h.length) {
    if (n[nIdx] === h[hIdx]) {
      indices.push(hIdx);
      // Bonus: consecutive match
      if (prevMatch) score += 3;
      // Bonus: word boundary (after space, slash, dot, dash, underscore)
      if (hIdx === 0 || /[\s/.\-_]/.test(h[hIdx - 1])) score += 5;
      // Base score per match
      score += 1;
      nIdx++;
      prevMatch = true;
    } else {
      prevMatch = false;
    }
    hIdx++;
  }

  if (nIdx < n.length) {
    // Did not match all needle chars
    return { score: 0, indices: [] };
  }

  // Bonus for short haystacks (tighter match)
  score += Math.max(0, 20 - haystack.length);

  return { score, indices };
}

export function fuzzyFilter<T>(
  items: T[],
  needle: string,
  getLabel: (item: T) => string,
): Array<T & { fuzzyScore: number; fuzzyIndices: number[] }> {
  if (!needle.trim()) {
    return items.map(item => ({ ...item, fuzzyScore: 1, fuzzyIndices: [] }));
  }

  return items
    .map(item => {
      const { score, indices } = fuzzyScore(needle, getLabel(item));
      return { ...item, fuzzyScore: score, fuzzyIndices: indices };
    })
    .filter(item => item.fuzzyScore > 0)
    .sort((a, b) => b.fuzzyScore - a.fuzzyScore);
}
