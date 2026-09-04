/**
 * Saliency detection for brain notes.
 *
 * A note is "salient" when it carries high emotional or cognitive charge:
 * breakthrough, painful bug, contradiction, recurring concept, or first-time encounter.
 *
 * The detected kind is stored as `data-cerveau-saliency-kind` on the <article>
 * and surfaced as a glyph in prompt injection.
 */

export type SaliencyKind =
  | 'breakthrough'
  | 'painful-bug'
  | 'contradiction'
  | 'recurring'
  | 'first-time'
  | null;

const BREAKTHROUGH_RE =
  /\b(finally|fixed it|works now|succeeded|victory|breakthrough|it works|got it working|resolved at last)\b/i;

const PAINFUL_BUG_RE =
  /\b(broken|blocked|frustrating|regression|kept failing|nothing works|wasted hours|deadlock|infinite loop|hours debugging)\b/i;

const CONTRADICTION_RE =
  /\b(switching to|rolling back to|instead|deprecated|replaced with|now using|changed from|reverting)\b/i;

/** Recurring: a concept already in ≥ 3 notes within 30 days. */
const RECURRING_THRESHOLD = 3;

/**
 * Detect the saliency kind for a note being captured.
 *
 * Priority: breakthrough > painful-bug > contradiction > recurring > first-time > null
 *
 * @param text         Prose text of the note.
 * @param ctx.existingConcepts   All concept tokens already indexed in the brain.
 * @param ctx.recentTagsCount    Frequency of each tag in the last 30 days.
 */
export function detectSaliency(
  text: string,
  ctx: {
    existingConcepts: Set<string>;
    recentTagsCount: Map<string, number>;
  },
): SaliencyKind {
  if (BREAKTHROUGH_RE.test(text)) return 'breakthrough';
  if (PAINFUL_BUG_RE.test(text)) return 'painful-bug';
  if (CONTRADICTION_RE.test(text)) return 'contradiction';

  // Recurring: any tag from this note appears ≥ RECURRING_THRESHOLD times recently
  const lowerText = text.toLowerCase();
  for (const [tag, count] of ctx.recentTagsCount) {
    if (count >= RECURRING_THRESHOLD && lowerText.includes(tag.toLowerCase())) {
      return 'recurring';
    }
  }

  // First-time: any concept token mentioned in text that does not exist in index
  const wordRe = /\b([A-Z][a-zA-Z]{2,}|[a-z]{4,})\b/g;
  wordRe.lastIndex = 0;
  for (let m = wordRe.exec(text); m !== null; m = wordRe.exec(text)) {
    const w = m[1].toLowerCase();
    if (w.length < 4) continue;
    if (!ctx.existingConcepts.has(w)) return 'first-time';
  }

  return null;
}

/**
 * Map a SaliencyKind to the glyph used in prompt injection compact lines.
 * The glyphs are intentionally left as Unicode — they are signal, not decoration.
 */
export const SALIENCY_GLYPH: Record<NonNullable<SaliencyKind>, string> = {
  breakthrough: '⚡', // ⚡
  'painful-bug': '\u{1FA79}', // 🩹
  contradiction: '⊘', // ⊘
  recurring: '\u{1F501}', // 🔁
  'first-time': '✨', // ✨
};
