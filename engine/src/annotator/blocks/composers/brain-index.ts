import { PKG_VERSION } from '../../../util/pkg-version.js';
import { renderCategories } from '../categories.js';
import { esc } from '../helpers.js';
import { renderInfobox } from '../infobox.js';
import { renderJsonLd } from '../json-ld.js';

export interface TopicEntry {
  name: string;
  id: string;
  noteCount: number;
  lastActivity: string;
  /** Short prose description extracted from the topic's notes. */
  description: string;
}

export interface BrainStats {
  totalNotes: number;
  totalTopics: number;
  dateRange: [string, string];
}

export interface BrainIndexInput {
  id: string;
  title: string;
  created: string;
  /** Real prose lead sentence describing what this brain covers. */
  leadText: string;
  stats: BrainStats;
  topics: TopicEntry[];
  tags: string[];
  /** Pre-rendered HTML <section> for the knowledge graph, injected as-is. */
  graphSection?: string;
}

/**
 * Build a type-badge HTML string from a typeBreakdown record (if provided)
 * or a fallback empty string.
 */
function renderTypeBadges(typeBreakdown?: Record<string, number>): string {
  if (!typeBreakdown) return '';
  return Object.entries(typeBreakdown)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `<span class="type-badge ${esc(k)}">${v} ${esc(k)}</span>`)
    .join(' ');
}

/**
 * Assemble a Wikipedia-style brain-index article from structured input.
 * Each topic gets a rich wiki-section with a link, note count badge, type
 * badges, and a prose description.
 * Returns full HTML for the article element.
 */
export function composeBrainIndex(input: BrainIndexInput): string {
  const now = new Date().toISOString();

  const infobox = renderInfobox({
    rows: [
      { label: 'Total notes', value: String(input.stats.totalNotes) },
      { label: 'Total topics', value: String(input.stats.totalTopics) },
    ],
  });

  const lead = `<section data-section="lead">
  <p><b>This brain</b> ${esc(input.leadText)}</p>
</section>`;

  // Build one rich wiki-section per topic
  const topicSections = input.topics
    .map((t) => {
      const topicSlug = t.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const desc = t.description ? `<p>${esc(t.description)}</p>` : '';
      const typeBadges = renderTypeBadges(
        (t as TopicEntry & { typeBreakdown?: Record<string, number> }).typeBreakdown,
      );
      return `<section class="wiki-section" id="project-${esc(topicSlug)}">
  <h2><a href="#/${esc(topicSlug)}" class="section-link">${esc(t.name)}</a></h2>
  <div class="section-content">
    <div class="project-meta">
      <span class="note-count">${t.noteCount} note${t.noteCount !== 1 ? 's' : ''}</span>
      ${typeBadges}
    </div>
    ${desc}
  </div>
</section>`;
    })
    .join('\n');

  const projectsSection = `<section id="topics">
  <h2>Topics</h2>
  ${topicSections}
</section>`;

  const categories = renderCategories({ tags: input.tags });

  const jsonLd = renderJsonLd({
    title: input.title,
    type: 'brain-index',
    dateCreated: input.created,
    tags: input.tags,
    description: input.leadText,
  });

  const parts = [
    `<article id="${esc(input.id)}" data-cerveau-version="${PKG_VERSION}" data-cerveau-created="${esc(input.created)}" data-cerveau-type="brain-index" data-cerveau-source="synthesize" data-cerveau-tier="working" data-cerveau-generated="dream-synthesize" data-cerveau-synthesized-at="${now}" data-cerveau-tags="${esc(input.tags.join(','))}">`,
    jsonLd,
    `<header class="wiki-header">`,
    `  <h1>${esc(input.title)}</h1>`,
    `  ${infobox}`,
    '</header>',
    lead,
    projectsSection,
    input.graphSection ?? '',
    categories,
    '</article>',
  ];

  return parts.filter((p) => p.trim().length > 0).join('\n');
}
