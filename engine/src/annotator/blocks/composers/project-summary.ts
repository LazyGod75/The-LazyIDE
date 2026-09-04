import { PKG_VERSION } from '../../../util/pkg-version.js';
import { renderCategories } from '../categories.js';
import { renderDataTable } from '../data-table.js';
import { esc } from '../helpers.js';
import { renderInfobox } from '../infobox.js';
import { renderJsonLd } from '../json-ld.js';
import { renderLeadSection } from '../lead-section.js';
import { renderSeeAlso } from '../see-also.js';
import { renderToc } from '../toc.js';

export interface ProjectNote {
  title: string;
  date: string;
  type: string;
  importance: string;
}

export interface ProjectStats {
  noteCount: number;
  typeBreakdown: Record<string, number>;
  dateRange: [string, string];
  avgImportance: number;
}

export interface ProjectSummaryInput {
  id: string;
  title: string;
  created: string;
  leadText: string;
  stack: string;
  status: string;
  stats: ProjectStats;
  notes: ProjectNote[];
  relatedTopics: Array<{ id: string; title: string }>;
  tags: string[];
}

/**
 * Assemble a complete project-summary article from structured input.
 * Includes Stack and Status rows in the infobox, in addition to the
 * standard stats rows shared with topic-overview.
 */
export function composeProjectSummary(input: ProjectSummaryInput): string {
  const now = new Date().toISOString();

  const typeBreakdownStr = Object.entries(input.stats.typeBreakdown)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ');

  const infobox = renderInfobox({
    rows: [
      { label: 'Stack', value: input.stack },
      { label: 'Status', value: input.status },
      { label: 'Notes', value: String(input.stats.noteCount) },
      { label: 'Types', value: typeBreakdownStr },
      { label: 'Period', value: `${input.stats.dateRange[0]} – ${input.stats.dateRange[1]}` },
      { label: 'Avg importance', value: input.stats.avgImportance.toFixed(2) },
    ],
  });

  const lead = renderLeadSection({
    subject: input.title,
    description: input.leadText,
  });

  const toc = renderToc({
    entries: [
      { level: 1, id: 'notes', text: 'Notes' },
      { level: 1, id: 'see-also', text: 'See also' },
    ],
  });

  const dataTable = renderDataTable({
    caption: `Notes in ${esc(input.title)}`,
    headers: ['Title', 'Date', 'Type', 'Importance'],
    rows: input.notes.map((n) => [n.title, n.date, n.type, n.importance]),
    sortable: true,
  });

  const seeAlso = renderSeeAlso({ links: input.relatedTopics });

  const categories = renderCategories({ tags: input.tags });

  const jsonLd = renderJsonLd({
    title: input.title,
    type: 'project-summary',
    dateCreated: input.created,
    tags: input.tags,
    description: input.leadText,
  });

  const parts = [
    `<article id="${esc(input.id)}" data-cerveau-version="${PKG_VERSION}" data-cerveau-created="${esc(input.created)}" data-cerveau-type="project-summary" data-cerveau-source="synthesize" data-cerveau-tier="working" data-cerveau-generated="dream-synthesize" data-cerveau-synthesized-at="${now}" data-cerveau-tags="${esc(input.tags.join(','))}">`,
    jsonLd,
    infobox,
    lead,
    toc,
    `  <section id="notes">`,
    '    <h2>Notes</h2>',
    `    ${dataTable}`,
    '  </section>',
    `  <section id="see-also">`,
    `    ${seeAlso}`,
    '  </section>',
    categories,
    '</article>',
  ];

  return parts.filter((p) => p.trim().length > 0).join('\n');
}
