/**
 * concept-neuron composer: renders a CONCEPT neuron as a wiki-style HTML article.
 *
 * A concept neuron represents cross-cutting knowledge (decisions, rules, ideas, facts,
 * Q&A, bugs) that does not belong predominantly to any single code file or module.
 * It is linked to all contributing evidence neurons via the 'related' section.
 *
 * Reuses existing block renderers: renderInfobox, renderToc, renderSeeAlso.
 */

import { canonicalProjectSegment } from '../../../util/cwd-normalizer.js';
import { PKG_VERSION } from '../../../util/pkg-version.js';
import { esc } from '../helpers.js';
import { renderInfobox } from '../infobox.js';
import { renderSeeAlso } from '../see-also.js';
import { renderToc } from '../toc.js';
import { normalizeItemText } from './file-neuron.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Kinds of concept neurons. */
export type ConceptKind = 'decision' | 'idea' | 'fact' | 'rule' | 'qa' | 'bug';

/** A link to a related neuron (evidence contributor or see-also). */
export interface RelatedLink {
  id: string;
  title: string;
}

/** Descriptor object passed to composeConceptNeuron. */
export interface ConceptNeuronDescriptor {
  /**
   * Unique ID for this concept. Convention: "concept:<slug>".
   * Example: "concept:canonical-merge-rule"
   */
  id: string;
  /** Human-readable title of this concept. */
  title: string;
  /**
   * Project this concept belongs to.
   * When provided, a breadcrumb "project / concept" is rendered.
   */
  projectName?: string;
  /** Semantic category of this concept. */
  kind: ConceptKind;
  /**
   * The main content of this concept (plain text; will be HTML-escaped).
   * This becomes the body section.
   */
  body: string;
  /**
   * Confidence score in [0, 1].
   * Written to data-cerveau-confidence on the root element.
   */
  confidence: number;
  /**
   * ISO 8601 date string (YYYY-MM-DD) when this concept was captured.
   * Written to data-cerveau-created.
   */
  date: string;
  /**
   * Evidence neurons that contribute to this concept — the navigation backbone.
   * Rendered as a "Related neurons" section with #/<id> links.
   */
  related: RelatedLink[];
  /**
   * Optional additional see-also links (concept ↔ concept links, sibling concepts).
   * Rendered as a standard see-also section.
   */
  seeAlso?: RelatedLink[];
  /**
   * When provided, the concept was superseded on this ISO date.
   * Written to data-cerveau-valid-until on the root element.
   */
  supersededDate?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Build the article id from the descriptor id.
 * Strips the "concept:" prefix, normalises to lowercase with hyphens.
 */
function buildArticleId(descriptorId: string): string {
  const slug = descriptorId
    .replace(/^concept:/, '')
    .replace(/[^a-z0-9]/gi, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .slice(0, 74); // leave room for "concept-" prefix (8 chars) → total ≤ 82
  return `concept-${slug}`;
}

/**
 * Render the breadcrumb when projectName is present.
 * Structure: <project> / Concept (link) / <title> (current)
 * Title is already normalized by the caller (composeConceptNeuron).
 */
function renderBreadcrumb(projectName: string, cleanTitle: string): string {
  const canonical = canonicalProjectSegment(projectName);
  const projectHref = `#/${esc(canonical)}`;
  const conceptsHref = `#/${esc(canonical)}/concepts`;
  const crumbs = [
    `<a href="${projectHref}">${esc(projectName)}</a>`,
    `<a href="${conceptsHref}">Concepts</a>`,
    `<span aria-current="page">${esc(cleanTitle)}</span>`,
  ].join(' / ');
  return `<nav class="breadcrumb" aria-label="breadcrumb">${crumbs}</nav>`;
}

/**
 * Render one-liner TLDR: "<kind> concept — <title>".
 * cleanTitle is already normalized by the caller (composeConceptNeuron).
 */
function renderTldr(kind: ConceptKind, cleanTitle: string): string {
  const text = `${esc(kind)} concept — ${esc(cleanTitle)}`;
  return `<section data-section="tldr">\n  <p>${text}</p>\n</section>`;
}

/**
 * Render the body content section.
 * Body text is normalised (wiki-link markup stripped) then HTML-escaped.
 */
function renderBody(body: string): string {
  return [
    '<section data-section="body">',
    `  <p>${esc(normalizeItemText(body))}</p>`,
    '</section>',
  ].join('\n');
}

/**
 * Render the "related neurons" section — the navigation backbone for concepts.
 * Uses #/<id> links so the wiki SPA can navigate to the referenced neuron.
 * Returns empty string when no related links are provided.
 * r.title is normalized here to strip any wikilink markers — href/id are NOT touched.
 */
function renderRelated(related: RelatedLink[]): string {
  if (related.length === 0) return '';
  const items = related
    .map((r) => `<li><a href="#/${r.id}">${esc(normalizeItemText(r.title))}</a></li>`)
    .join('\n    ');
  return [
    '<section data-section="related">',
    '  <h3>Related neurons</h3>',
    '  <ul>',
    `    ${items}`,
    '  </ul>',
    '</section>',
  ].join('\n');
}

/** Build TOC entries for a concept neuron. */
function buildTocEntries(
  hasRelated: boolean,
  hasSeeAlso: boolean,
): Array<{ level: number; id: string; text: string }> {
  const entries: Array<{ level: number; id: string; text: string }> = [
    { level: 1, id: 'body', text: 'Content' },
  ];

  if (hasRelated) {
    entries.push({ level: 1, id: 'related', text: 'Related neurons' });
  }

  if (hasSeeAlso) {
    entries.push({ level: 1, id: 'see-also', text: 'See also' });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Main composer
// ---------------------------------------------------------------------------

/**
 * Compose a complete <article data-cerveau-type="concept"> HTML string.
 *
 * Always included:
 * - infobox (kind, confidence, date)
 * - tldr (one-liner: "rule concept — <title>")
 * - body (escaped content)
 * - toc
 *
 * Conditional:
 * - breadcrumb (project → Concepts → current) — only when projectName is provided
 * - related section — only when related is non-empty (navigation backbone)
 * - see-also — only when seeAlso is non-empty
 * - data-cerveau-valid-until — only when supersededDate is provided
 */
export function composeConceptNeuron(descriptor: ConceptNeuronDescriptor): string {
  const {
    id: descriptorId,
    title: rawTitle,
    projectName,
    kind,
    body,
    confidence,
    date,
    related,
    seeAlso = [],
    supersededDate,
  } = descriptor;

  // Normalize all human-visible text fields at the composer boundary.
  // This makes the composer defensive against raw wikilink markers that may
  // arrive from any caller — not just buildConceptDescriptor.
  // href/id/data-* attribute values are never touched by normalizeItemText.
  const title = normalizeItemText(rawTitle);

  const articleId = buildArticleId(descriptorId);
  // Normalise date: ensure it has a time component for ISO compliance with the validator.
  const createdAttr = date.includes('T') ? date : `${date}T00:00:00Z`;

  const infobox = renderInfobox({
    rows: [
      { label: 'Kind', value: kind },
      // Round to 2 decimal places for human-readable display;
      // the raw precision is preserved in data-cerveau-confidence on the root element.
      { label: 'Confidence', value: confidence.toFixed(2) },
      { label: 'Date', value: date },
    ],
  });

  const hasRelated = related.length > 0;
  const hasSeeAlso = seeAlso.length > 0;
  const tocEntries = buildTocEntries(hasRelated, hasSeeAlso);
  const toc = renderToc({ entries: tocEntries });

  // Normalize seeAlso display titles — href (l.id) is preserved unchanged.
  const seeAlsoSection = hasSeeAlso
    ? renderSeeAlso({
        links: seeAlso.map((l) => ({ id: l.id, title: normalizeItemText(l.title) })),
      })
    : '';

  const breadcrumb = projectName !== undefined ? renderBreadcrumb(projectName, title) : '';

  // Build root attrs — required attrs first, then optional.
  const validUntilAttr =
    supersededDate !== undefined ? `\n  data-cerveau-valid-until="${esc(supersededDate)}"` : '';

  const parts: string[] = [
    '<article',
    `  id="${esc(articleId)}"`,
    `  data-cerveau-version="${PKG_VERSION}"`,
    `  data-cerveau-type="concept"`,
    `  data-cerveau-created="${createdAttr}"`,
    `  data-cerveau-updated="${createdAttr}"`,
    `  data-cerveau-source="concept-composer"`,
    `  data-cerveau-confidence="${confidence}"${validUntilAttr}`,
    `  data-cerveau-tags="concept ${esc(kind)}${projectName !== undefined ? ` ${esc(projectName)}` : ''}"`,
    `  data-cerveau-topic="${projectName !== undefined ? `${esc(canonicalProjectSegment(projectName))}/concepts` : 'concepts'}"`,
    '>',
    breadcrumb,
    `<h1>${esc(title)}</h1>`,
    infobox,
    renderTldr(kind, title),
    toc,
    renderBody(body),
    renderRelated(related),
    seeAlsoSection,
    '</article>',
  ];

  return parts.filter((p) => p.trim().length > 0).join('\n');
}
