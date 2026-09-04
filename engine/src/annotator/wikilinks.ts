/**
 * Wikilink injector — wraps known entity/concept mentions in <a> links.
 *
 * Conservative strategy:
 * - At most 5 links per note
 * - One link per unique term per pass
 * - Never link inside <code>, <pre>, <a>, <cite>, <kbd>, <script>, <style>,
 *   <summary>, <details>, <blockquote>
 * - Never mutate attribute values
 * - Uses DOM text-node walking (not regex on raw HTML) to avoid corrupting
 *   attribute values or splitting existing tokens / paths
 * - Replacement done via proper DOM operations, never via innerHTML
 * - Idempotent: skip terms already wrapped
 * - Red-links for known concepts without a note
 */

import { parseHTML } from 'linkedom';
import { splitIdentifier } from '../util/tokenize.js';

export interface WikilinkNoteRef {
  id: string;
  concepts: string[];
  entities: string[];
  tags: string[];
}

export interface WikilinkContext {
  knownNoteIds: ReadonlyMap<string, WikilinkNoteRef>;
  knownEntities: ReadonlySet<string>;
  knownConcepts: ReadonlySet<string>;
}

const SKIP_ANCESTORS = new Set([
  'code',
  'pre',
  'a',
  'cite',
  'kbd',
  'script',
  'style',
  'summary',
  'details',
  'blockquote',
]);

/**
 * Enrichment section ids that carry fused conversation items.
 * Text nodes inside these sections must never receive auto-injected wikilinks
 * because each item already carries a [source] link and must be preserved verbatim.
 */
const ENRICHMENT_SECTION_IDS = new Set(['decisions', 'bugs', 'ideas', 'rules', 'qa', 'activity']);

const MAX_LINKS = 5;

/**
 * Note types whose IDs may only be linked via exact-id match or explicit
 * code-edge data — never via fuzzy substring matching.
 *
 * file-neuron IDs are long path-derived slugs like
 *   "file-trading-prometheus-research-autoresearch-archive-tests-mega-test-py"
 * that contain every common English word as a substring, so substring matching
 * produces enormous fake hub nodes (1000+ inbound edges in production).
 *
 * aggregate-neuron IDs have the same problem (they are built from directory paths).
 */
const SUBSTRING_MATCH_EXCLUDED_TYPES = new Set(['file-neuron', 'aggregate-neuron']);

/**
 * Maximum number of auto-generated inbound links allowed per target note.
 *
 * When a note accumulates more than this many auto-inbound edges it almost
 * certainly represents a fuzzy-match mega-hub (the production record was
 * 1118 edges for a single file-neuron).  We keep the first MAX_AUTO_FAN_IN
 * edges in stable insertion order and drop the rest.
 *
 * Deterministic: the insertion order comes from the deterministic Map iteration
 * order over knownNoteIds (which is build-order / alphabetical in practice).
 */
const MAX_AUTO_FAN_IN = 50;

/**
 * Track per-note auto-inbound edge counts for the fan-in cap.
 * Keyed by target note id, value is the count of auto-links already resolved
 * to that target in this annotation pass.
 */
const autoFanInCounts = new Map<string, number>();

/** Reset fan-in counters between annotation passes (call from injectWikilinks). */
function resetFanInCounts(): void {
  autoFanInCounts.clear();
}

/**
 * Return true when the target note has already reached the auto-link fan-in cap.
 * Increments the counter if under the cap (returning false = "still allowed").
 */
function isOverFanInCap(targetId: string): boolean {
  const current = autoFanInCounts.get(targetId) ?? 0;
  if (current >= MAX_AUTO_FAN_IN) return true;
  autoFanInCounts.set(targetId, current + 1);
  return false;
}

/**
 * Given a candidate term, find the best note id to link to.
 * Priority:
 *   1. Exact entity match → first note containing that entity
 *   2. Exact note id match
 *   3. Concept match (note tagged with that concept)
 *
 * Substring-match against note IDs is intentionally DISABLED for
 * file-neuron and aggregate-neuron notes (see SUBSTRING_MATCH_EXCLUDED_TYPES).
 * Those notes must only receive links from explicit exact-id or code-edge signals.
 */
function resolveLink(
  term: string,
  termLower: string,
  ctx: WikilinkContext,
): { id: string; redLink: false } | { concept: string; redLink: true } | null {
  // 1. Entity surface match
  if (ctx.knownEntities.has(term) || ctx.knownEntities.has(termLower)) {
    const surface = ctx.knownEntities.has(term) ? term : termLower;
    for (const [id, ref] of ctx.knownNoteIds) {
      if (ref.entities.some((e) => e.includes(surface.replace(/[^a-z0-9]/gi, '-').toLowerCase()))) {
        return { id, redLink: false };
      }
    }
  }

  // 2. Note id / concept match
  for (const [id, ref] of ctx.knownNoteIds) {
    // Exact id match is always allowed regardless of note type.
    if (id === termLower || id === term.toLowerCase()) {
      return { id, redLink: false };
    }

    // Substring id match: DISABLED for file-neuron and aggregate-neuron.
    // These types have long path-derived IDs that contain every common word
    // as a substring, producing massive fake hub nodes in production.
    const noteType = ref.tags.find((t) => SUBSTRING_MATCH_EXCLUDED_TYPES.has(t));
    if (!noteType) {
      // Normal note: substring match is allowed.
      if (id.includes(termLower) || id.includes(term.toLowerCase())) {
        return { id, redLink: false };
      }
    }
    // Concept / tag exact match (applies to all note types).
    if (ref.concepts.some((c) => c.toLowerCase() === termLower)) {
      return { id, redLink: false };
    }
    if (ref.tags.some((t) => t.toLowerCase() === termLower)) {
      return { id, redLink: false };
    }
  }

  // 3. Known concept but no note yet → red-link
  if (ctx.knownConcepts.has(term) || ctx.knownConcepts.has(termLower)) {
    const concept = ctx.knownConcepts.has(term) ? term : termLower;
    return { concept, redLink: true };
  }

  return null;
}

/**
 * Check if a DOM node has a skip-ancestor in its parent chain.
 * Accepts any node-like object with a parentElement chain.
 */
function hasSkipAncestor(node: Element): boolean {
  let parent: Element | null = node.parentElement ?? null;
  while (parent) {
    if (SKIP_ANCESTORS.has(parent.tagName.toLowerCase())) return true;
    parent = parent.parentElement ?? null;
  }
  return false;
}

/**
 * Return true when the node sits inside a <section data-section="..."> whose id
 * belongs to the enrichment set (decisions, bugs, ideas, rules, qa, activity).
 *
 * These sections carry fused conversation items that already have a [source] link;
 * their prose must be preserved verbatim — no wikilink injection allowed.
 */
function isInsideEnrichmentSection(node: Element): boolean {
  let parent: Element | null = node.parentElement ?? null;
  while (parent) {
    if (parent.tagName.toLowerCase() === 'section') {
      const sectionId = parent.getAttribute('data-section') ?? '';
      if (ENRICHMENT_SECTION_IDS.has(sectionId)) return true;
    }
    parent = parent.parentElement ?? null;
  }
  return false;
}

/**
 * Extract capitalised identifiers and known concepts from text.
 */
function extractCandidateTerms(text: string, ctx: WikilinkContext): string[] {
  const terms = new Set<string>();
  // CamelCase identifiers
  const camelRe = /\b[A-Z][a-zA-Z0-9]{2,40}\b/g;
  let m: RegExpExecArray | null;
  while (true) {
    m = camelRe.exec(text);
    if (m === null) break;
    const tok = m[0];
    const parts = splitIdentifier(tok);
    if (parts.length > 1) {
      terms.add(tok);
      for (const p of parts) {
        if (p.length >= 3 && /^[A-Z]/.test(p)) terms.add(p);
      }
    } else {
      terms.add(tok);
    }
  }
  // Known entities and concepts (lowercase matches)
  for (const e of ctx.knownEntities) {
    if (text.includes(e)) terms.add(e);
  }
  for (const c of ctx.knownConcepts) {
    if (text.includes(c)) terms.add(c);
  }
  return [...terms];
}

/**
 * Represents a text node reference for safe DOM walking.
 * We store the raw Node cast to unknown to satisfy TypeScript strict mode,
 * since linkedom does not export its Node types.
 */
interface TextNodeRef {
  node: unknown;
  parent: Element;
}

/**
 * Collect all text nodes under `root` that are safe to modify.
 * Only nodeType === 3 (TEXT_NODE) children are collected.
 * Attribute values are never visited since we walk childNodes, not attributes.
 */
function collectTextNodes(node: Element, out: TextNodeRef[]): void {
  for (const child of Array.from(node.childNodes)) {
    const typed = child as unknown as { nodeType: number; parentElement: Element | null };
    if (typed.nodeType === 3) {
      // TEXT_NODE
      const parent = typed.parentElement ?? node;
      out.push({ node: child, parent });
    } else if (typed.nodeType === 1) {
      // ELEMENT_NODE — recurse, but skip elements whose tag is in SKIP_ANCESTORS
      const el = child as unknown as Element;
      if (!SKIP_ANCESTORS.has(el.tagName.toLowerCase())) {
        collectTextNodes(el, out);
      }
    }
    // nodeType 2 (ATTRIBUTE_NODE) is never a child node, so attributes are safe
  }
}

/**
 * Replace a text node in-place with [beforeText, <a>matchText</a>, afterText].
 * Uses pure DOM operations — no innerHTML — so attribute values are never touched.
 */
function replaceTextNodeWithLink(
  document: Document,
  textNode: unknown,
  parent: Element,
  matchIndex: number,
  matchLength: number,
  resolved: { id: string; redLink: false } | { concept: string; redLink: true },
): void {
  const node = textNode as unknown as { textContent: string | null };
  const text = node.textContent ?? '';

  const beforeText = text.slice(0, matchIndex);
  const matchText = text.slice(matchIndex, matchIndex + matchLength);
  const afterText = text.slice(matchIndex + matchLength);

  const anchor = document.createElement('a');
  if (resolved.redLink) {
    anchor.setAttribute('data-red-link', resolved.concept);
  } else {
    // Use "#/note/<id>" — the SPA-routable format the wiki router resolves correctly.
    // A bare "#<id>" is an in-page anchor that the hash-router does not handle.
    anchor.setAttribute('href', `#/note/${encodeURIComponent(resolved.id)}`);
    anchor.setAttribute('data-cerveau-link-type', 'see-also');
  }
  anchor.setAttribute('data-cerveau-link-auto', 'true');
  anchor.textContent = matchText;

  const afterNode = document.createTextNode(afterText);
  const beforeNode = document.createTextNode(beforeText);

  // Replace original text node with [before, anchor, after]
  // insertBefore requires a reference child; we rebuild in order:
  //   parent: ... [textNode] ...
  //   → ... [beforeNode] [anchor] [afterNode] ...
  parent.replaceChild(afterNode, textNode as unknown as Node);
  parent.insertBefore(anchor, afterNode);
  parent.insertBefore(beforeNode, anchor);
}

/**
 * Find the first occurrence of `term` in `text` as a whole word,
 * not preceded or followed by word-constituent or path characters.
 *
 * We use a simple scan rather than a regex to avoid issues with special
 * characters in term names or path separators like `/`.
 */
function findWholeWordIndex(text: string, term: string): number {
  let start = 0;
  while (start <= text.length - term.length) {
    const idx = text.indexOf(term, start);
    if (idx === -1) return -1;

    const before = idx > 0 ? text[idx - 1] : ' ';
    const after = idx + term.length < text.length ? text[idx + term.length] : ' ';

    // Word boundary: character before/after must not be alphanumeric, hyphen,
    // underscore, dot, or slash (to avoid splitting paths or identifiers).
    const isBoundaryChar = (ch: string): boolean => /[a-zA-Z0-9_.\-/]/.test(ch);

    if (!isBoundaryChar(before) && !isBoundaryChar(after)) {
      return idx;
    }
    start = idx + 1;
  }
  return -1;
}

/**
 * Inject Wikipedia-style internal links into an HTML string.
 * Returns the rewritten HTML with <a href="#/note/<id>"> or <a data-red-link> elements.
 * The href format "#/note/<id>" is the SPA-routable format understood by the wiki router.
 *
 * Safe: operates exclusively on DOM text nodes; never touches attribute values,
 * never modifies content inside <script>, <style>, <summary>, <details>,
 * <blockquote>, <code>, <pre>, <a>, <cite>, or <kbd>.
 */
export function injectWikilinks(html: string, ctx: WikilinkContext): string {
  if (!html || ctx.knownNoteIds.size === 0) return html;

  // Reset per-pass fan-in counters so each call to injectWikilinks starts fresh.
  resetFanInCounts();

  const { document } = parseHTML(`<!doctype html><html><body>${html}</body></html>`);
  const body = document.body as Element;

  const linkedTerms = new Set<string>();
  let linkCount = 0;

  // Collect text nodes via tree walker (preferred) or manual walk (fallback).
  const textNodes: TextNodeRef[] = [];

  if (document.createTreeWalker) {
    const walker = document.createTreeWalker(body, 4 /* NodeFilter.SHOW_TEXT */);
    let node = walker.nextNode();
    while (node) {
      const typed = node as unknown as { parentElement: Element | null };
      const parent = typed.parentElement;
      if (parent) textNodes.push({ node, parent });
      node = walker.nextNode();
    }
  } else {
    collectTextNodes(body, textNodes);
  }

  // Filter out text nodes whose parent (or any ancestor) is in SKIP_ANCESTORS,
  // or that reside inside an enrichment section (decisions/bugs/ideas/rules/qa/activity).
  // Enrichment items carry original prose + a [source] link that must be preserved verbatim.
  const safeTextNodes = textNodes.filter(
    ({ parent }) => !hasSkipAncestor(parent) && !isInsideEnrichmentSection(parent),
  );

  for (const { node, parent } of safeTextNodes) {
    if (linkCount >= MAX_LINKS) break;

    // Also skip nodes directly inside a skip-ancestor tag
    if (SKIP_ANCESTORS.has(parent.tagName.toLowerCase())) continue;

    const textNodeTyped = node as unknown as { textContent: string | null };
    const text = textNodeTyped.textContent ?? '';
    if (!text.trim()) continue;

    const candidates = extractCandidateTerms(text, ctx);
    for (const term of candidates) {
      if (linkCount >= MAX_LINKS) break;
      if (linkedTerms.has(term.toLowerCase())) continue;

      const matchIndex = findWholeWordIndex(text, term);
      if (matchIndex === -1) continue;

      const resolved = resolveLink(term, term.toLowerCase(), ctx);
      if (!resolved) continue;

      // Apply fan-in cap for auto-generated links: drop the link when the target
      // has already received MAX_AUTO_FAN_IN auto inbound edges this pass.
      // Red-links (resolved.redLink === true) are not counted against the cap.
      if (!resolved.redLink && isOverFanInCap(resolved.id)) continue;

      linkedTerms.add(term.toLowerCase());
      linkCount++;

      replaceTextNodeWithLink(
        document as unknown as Document,
        node,
        parent,
        matchIndex,
        term.length,
        resolved,
      );
      break; // Move on after replacing this text node
    }
  }

  return body.innerHTML;
}

/**
 * Pure-text version — injects wikilink markers as plain text for tests.
 * Format: [term→#/note/<id>] or [term?] for red-links.
 */
export function injectWikilinksText(text: string, ctx: WikilinkContext): string {
  if (!text || ctx.knownNoteIds.size === 0) return text;

  // Reset fan-in counters for this pass.
  resetFanInCounts();

  const linkedTerms = new Set<string>();
  let linkCount = 0;
  let result = text;

  const candidates = extractCandidateTerms(text, ctx);
  for (const term of candidates) {
    if (linkCount >= MAX_LINKS) break;
    if (linkedTerms.has(term.toLowerCase())) continue;
    if (!result.includes(term)) continue;

    const resolved = resolveLink(term, term.toLowerCase(), ctx);
    if (!resolved) continue;

    // Apply fan-in cap for auto-generated links.
    if (!resolved.redLink && isOverFanInCap(resolved.id)) continue;

    linkedTerms.add(term.toLowerCase());
    linkCount++;

    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const termRe = new RegExp(`\\b${escapedTerm}\\b`);
    result = result.replace(termRe, (match) => {
      if (resolved.redLink) return `[${match}?]`;
      return `[${match}→#/note/${encodeURIComponent(resolved.id)}]`;
    });
  }

  return result;
}

/**
 * Build a WikilinkContext from a flat list of indexed notes.
 */
export function buildWikilinkContext(
  notes: Array<{
    id: string;
    concepts: string | null;
    entities: string | null;
    tags: string;
  }>,
): WikilinkContext {
  const knownNoteIds = new Map<string, WikilinkNoteRef>();
  const knownEntities = new Set<string>();
  const knownConcepts = new Set<string>();

  for (const n of notes) {
    const concepts = (n.concepts ?? '').split(',').filter(Boolean);
    const entities = (n.entities ?? '').split(',').filter(Boolean);
    const tags = (n.tags ?? '').split(/\s+/).filter(Boolean);

    knownNoteIds.set(n.id, { id: n.id, concepts, entities, tags });

    for (const e of entities) {
      const surface = e.split(':').pop() ?? e;
      knownEntities.add(surface.replace(/-/g, ''));
      knownEntities.add(surface);
    }
    for (const c of concepts) {
      knownConcepts.add(c);
    }
  }

  return { knownNoteIds, knownEntities, knownConcepts };
}
