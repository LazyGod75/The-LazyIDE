/**
 * Shared topic-prefix predicate for `lazybrain publish --topic <prefix>`.
 *
 * All site outputs (notes, graph, tree, synthesis, search-index, backlinks,
 * neighbors) must use this single helper so every output agrees on scope.
 */
import type { IndexedNote } from '../indexer/fts.js';

/**
 * Returns true when the note's topic starts with `prefix` (case-insensitive).
 * Notes without a topic are excluded when a prefix is active.
 *
 * @param topic   The note's data-cerveau-topic value (may be null / undefined).
 * @param prefix  The CLI --topic value. Pass undefined/null to disable filtering.
 */
export function matchesTopic(
  topic: string | null | undefined,
  prefix: string | null | undefined,
): boolean {
  if (!prefix) return true; // no filter active → include everything
  if (!topic) return false; // no topic on note → exclude when filter is active
  return topic.toLowerCase().startsWith(prefix.toLowerCase());
}

/**
 * Build an immutable Set of note IDs that are in scope for the given topic
 * prefix, from a list of indexed notes.
 */
export function buildInScopeIds(
  allNotes: ReadonlyArray<Pick<IndexedNote, 'id' | 'topic'>>,
  topicPrefix: string | null | undefined,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const note of allNotes) {
    if (matchesTopic(note.topic, topicPrefix)) {
      ids.add(note.id);
    }
  }
  return ids;
}

/**
 * Returns true when an aggregate-neuron should be skipped because it has no
 * real content: no children AND no meaningful section body.
 *
 * "Meaningful" means the HTML body (outside the infobox / breadcrumb / TOC)
 * contains at least MIN_TEXT_CHARS of visible text.
 */
const MIN_TEXT_CHARS = 20;

export function isEmptyAggregate(note: {
  type: string | null;
  cleaned?: string;
  html?: string;
}): boolean {
  if (note.type !== 'aggregate-neuron') return false;

  const raw = note.cleaned ?? note.html ?? '';
  if (!raw) return true;

  // Check for any child links (data-cerveau-type attribute in anchor tags
  // or an <ul class="children-list"> with at least one <li>)
  const hasChildren = /<li[^>]*>/.test(raw);

  // Check for meaningful text: strip all HTML tags and measure length.
  const textContent = raw
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // Exclude known boilerplate patterns: the infobox rows only, toc header, etc.
  // A truly empty aggregate typically has < MIN_TEXT_CHARS of non-tag text
  // outside of the article title and infobox labels.
  const isTooShort = textContent.length < MIN_TEXT_CHARS;

  return !hasChildren && isTooShort;
}
