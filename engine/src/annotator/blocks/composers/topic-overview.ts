import { PKG_VERSION } from '../../../util/pkg-version.js';
import { renderCategories } from '../categories.js';
import { esc } from '../helpers.js';
import { renderJsonLd } from '../json-ld.js';
import { renderSeeAlso } from '../see-also.js';

export interface TopicStats {
  noteCount: number;
  typeBreakdown: Record<string, number>;
  dateRange: [string, string];
  avgImportance: number;
}

export interface TopicOverviewInput {
  id: string;
  title: string;
  created: string;
  /** Real prose lead paragraph built from note TLDRs. */
  leadText: string;
  /** HTML sections: one <section><h2>...</h2><p>...</p></section> per sub-topic. */
  sections: string;
  stats: TopicStats;
  relatedTopics: Array<{ id: string; title: string }>;
  tags: string[];
  /** First-segment topic key used for data-cerveau-topic (e.g. "acme"). */
  topic?: string;
}

/**
 * Extract section IDs and titles from the sections HTML string to build a TOC.
 */
function extractSectionHeadings(sectionsHtml: string): Array<{ id: string; title: string }> {
  const headings: Array<{ id: string; title: string }> = [];
  const sectionRe = /<section[^>]*\s+id="([^"]+)"[^>]*>[\s\S]*?<h2[^>]*>([\s\S]*?)<\/h2>/gi;
  for (
    let match = sectionRe.exec(sectionsHtml);
    match !== null;
    match = sectionRe.exec(sectionsHtml)
  ) {
    const id = match[1];
    // Strip inner tags from h2 content to get plain text
    const rawTitle = match[2].replace(/<[^>]+>/g, '').trim();
    if (id && rawTitle) {
      headings.push({ id, title: rawTitle });
    }
  }

  return headings;
}

/**
 * Build a Wikipedia-style table of contents from section headings.
 */
function buildTOC(headings: Array<{ id: string; title: string }>): string {
  if (headings.length === 0) return '';

  const items = headings
    .map(
      (h, i) =>
        `<li><a href="#${esc(h.id)}"><span class="tocnumber">${i + 1}</span> ${esc(h.title)}</a></li>`,
    )
    .join('\n');

  return `<nav class="toc" role="navigation">
  <h2>Contents</h2>
  <ol>${items}</ol>
</nav>`;
}

/**
 * Build a rich infobox aside with type badges instead of plain text.
 */
function buildRichInfobox(stats: TopicStats, subTopics: string[]): string {
  const typeBadges = Object.entries(stats.typeBreakdown)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<span class="type-badge ${esc(k)}">${v} ${esc(k)}</span>`)
    .join(' ');

  const subTopicsStr = subTopics.length > 0 ? esc(subTopics.join(', ')) : '—';

  return `<aside class="infobox">
  <dl>
    <dt>Notes</dt><dd>${stats.noteCount}</dd>
    <dt>Sub-topics</dt><dd>${subTopicsStr}</dd>
    <dt>Types</dt><dd>${typeBadges}</dd>
  </dl>
</aside>`;
}

/**
 * Assemble a Wikipedia-style topic-overview article from structured input.
 * Renders prose sections grouped by sub-topic — no data table of note rows.
 * Returns full HTML for the article element.
 */
export function composeTopicOverview(input: TopicOverviewInput): string {
  const now = new Date().toISOString();

  // Extract sub-topic names from sections HTML for the infobox
  const sectionHeadings = extractSectionHeadings(input.sections);
  const subTopicNames = sectionHeadings.map((h) => h.title);

  const infobox = buildRichInfobox(input.stats, subTopicNames);

  const toc = buildTOC(sectionHeadings);

  // leadText may contain safe HTML (data, dfn tags) — do NOT escape it.
  // Strip tags for the plain-text lead fallback displayed as the first sentence.
  const lead = `<section data-section="lead">
  <p><b>${esc(input.title)}</b> ${input.leadText}</p>
</section>`;

  const seeAlso = renderSeeAlso({ links: input.relatedTopics });

  const categories = renderCategories({ tags: input.tags });

  // Strip HTML tags from leadText for use in JSON-LD description (plain text only)
  const leadTextPlain = input.leadText.replace(/<[^>]+>/g, '');

  const jsonLd = renderJsonLd({
    title: input.title,
    type: 'topic-overview',
    dateCreated: input.created,
    tags: input.tags,
    description: leadTextPlain,
  });

  const parts = [
    `<article id="${esc(input.id)}" data-cerveau-version="${PKG_VERSION}" data-cerveau-created="${esc(input.created)}" data-cerveau-type="topic-overview" data-cerveau-source="synthesize" data-cerveau-tier="working" data-cerveau-generated="dream-synthesize" data-cerveau-synthesized-at="${now}" data-cerveau-tags="${esc(input.tags.join(','))}"${input.topic ? ` data-cerveau-topic="${esc(input.topic)}"` : ''}>`,
    jsonLd,
    `<header class="wiki-header">`,
    `  <h1>${esc(input.title)}</h1>`,
    `  ${infobox}`,
    '</header>',
    toc,
    lead,
    input.sections,
    seeAlso,
    categories,
    '</article>',
  ];

  return parts.filter((p) => p.trim().length > 0).join('\n');
}
