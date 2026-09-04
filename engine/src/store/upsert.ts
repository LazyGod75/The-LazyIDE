/**
 * upsert.ts — richer-body upsert helpers for writeNote().
 *
 * Root cause this exists to fix: a mission note is written sparse at
 * kickoff (title + model + worktree, ~10 words) and the SAME id
 * (slug(title) + day, see paths.ts's notePath) is written again, richer,
 * at mission completion. Plain writeNote() either throws ConflictError
 * (default) or blindly replaces the file (opts.overwrite) with no regard
 * for which version is actually more informative. Neither is right: the
 * conflict path silently drops the rich completion text (capture.ts's
 * dispatch() treats "already exists" as success-equivalent), and a blind
 * overwrite could just as easily let a LATER sparse retry clobber a
 * richer note.
 *
 * The rule implemented here: replace the stored body only when the
 * candidate is strictly richer (more alphanumeric words) than what's
 * already there. Ties and downgrades are no-ops — the existing note wins.
 * data-cerveau-created is always preserved from the EXISTING note (the
 * true origin timestamp); data-cerveau-updated is refreshed to now.
 */

const CREATED_ATTR_RE = /data-cerveau-created\s*=\s*["']([^"']*)["']/i;
const UPDATED_ATTR_RE = /data-cerveau-updated\s*=\s*["']([^"']*)["']/i;
const ROOT_OPEN_TAG_RE = /(<(?:article|section)\b[^>]*)>/i;

/** Strip tags/entities down to plain text for a word-count comparison. */
function toPlainText(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Count alphanumeric words — same tokenization rule as sources/noise.ts's
 *  countAlphanumericWords, duplicated here (rather than imported) to keep
 *  the store layer decoupled from the sources/ ingestion layer (same
 *  "system boundary" rationale capture.ts's own header gives for its
 *  independent REASONING_LEAK_MARKER copy). */
function countWords(text: string): number {
  const words = text.match(/\b[a-zA-Z0-9][a-zA-Z0-9'_-]*\b/g);
  return words ? words.length : 0;
}

/**
 * True when candidateHtml's body carries strictly more alphanumeric words
 * than existingHtml's. Equal or fewer words → false (never downgrade).
 */
export function isRicherBody(existingHtml: string, candidateHtml: string): boolean {
  const existingWords = countWords(toPlainText(existingHtml));
  const candidateWords = countWords(toPlainText(candidateHtml));
  return candidateWords > existingWords;
}

/**
 * Stamp data-cerveau-updated on `html`, replacing an existing attribute or
 * inserting one on the root tag if absent. Pure — returns a new string.
 */
function stampUpdated(html: string, updatedAtIso: string): string {
  return UPDATED_ATTR_RE.test(html)
    ? html.replace(UPDATED_ATTR_RE, `data-cerveau-updated="${updatedAtIso}"`)
    : html.replace(ROOT_OPEN_TAG_RE, `$1 data-cerveau-updated="${updatedAtIso}">`);
}

/**
 * Stamp BOTH data-cerveau-created and data-cerveau-updated on `html`,
 * replacing existing attributes or inserting them on the root tag if
 * absent. Pure — returns a new string, never mutates its input.
 *
 * Shared by mergeUpsertHtml() (below, which sources createdIso from an
 * on-disk existing note) and writer.ts's writeNote() (which sources it from
 * the SQLite index when regenerating an already-indexed note) — both need
 * the exact same "preserve created, refresh updated" transform, just with a
 * different origin for the created value being preserved.
 */
export function stampCreatedAndUpdated(
  html: string,
  createdIso: string,
  updatedAtIso: string,
): string {
  const withCreated = CREATED_ATTR_RE.test(html)
    ? html.replace(CREATED_ATTR_RE, `data-cerveau-created="${createdIso}"`)
    : html.replace(ROOT_OPEN_TAG_RE, `$1 data-cerveau-created="${createdIso}">`);
  return stampUpdated(withCreated, updatedAtIso);
}

/**
 * Merge an existing note's provenance into a richer candidate:
 *   - data-cerveau-created is carried over from existingHtml (falls back to
 *     leaving candidateHtml's own value untouched if existingHtml has none —
 *     defensive; real notes always carry this attribute).
 *   - data-cerveau-updated is set to updatedAtIso.
 * Returns the merged HTML string; never mutates its inputs.
 */
export function mergeUpsertHtml(
  existingHtml: string,
  candidateHtml: string,
  updatedAtIso: string,
): string {
  const preservedCreated = existingHtml.match(CREATED_ATTR_RE)?.[1];
  return preservedCreated
    ? stampCreatedAndUpdated(candidateHtml, preservedCreated, updatedAtIso)
    : stampUpdated(candidateHtml, updatedAtIso);
}
