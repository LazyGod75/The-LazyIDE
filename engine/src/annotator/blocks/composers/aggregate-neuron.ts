/**
 * aggregate-neuron composer: renders a module or project directory as a wiki-style
 * HTML article. One aggregate-neuron per directory (module) and one per project root.
 *
 * Navigation backbone: project → module → file-neuron.
 *
 * Reuses existing block renderers: renderInfobox, renderToc, renderSeeAlso.
 */

import { canonicalProjectSegment } from '../../../util/cwd-normalizer.js';
import { PKG_VERSION } from '../../../util/pkg-version.js';
import { esc } from '../helpers.js';
import { renderInfobox } from '../infobox.js';
import { renderSeeAlso } from '../see-also.js';
import { renderToc } from '../toc.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AggregateChild {
  id: string;
  title: string;
  kind: 'file' | 'module';
}

export interface AggregateStats {
  fileCount: number;
  totalLines: number;
  languages: string[];
}

export interface SubModule {
  id: string;
  title: string;
}

export interface SeeAlsoLink {
  id: string;
  title: string;
}

export interface AggregateNeuronDescriptor {
  /** Unique id for this aggregate, e.g. "module:src/auth" or "project:myproject" */
  id: string;
  kind: 'module' | 'project';
  /** Human-readable title: directory path or project name */
  title: string;
  /** Relative directory path (empty string for project root) */
  path: string;
  projectName: string;
  /** Immediate child neurons (sub-modules + file-neurons in this directory) */
  children: AggregateChild[];
  stats: AggregateStats;
  /** Direct sub-modules (only for project kind, subset of children) */
  subModules?: SubModule[];
  /** Sibling modules / parent to show in see-also */
  seeAlso?: SeeAlsoLink[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function renderBreadcrumb(projectName: string, path: string): string {
  const normalizedPath = path.replace(/\\/g, '/');
  const pathSegments = normalizedPath ? normalizedPath.split('/').filter(Boolean) : [];
  const allSegments = [projectName, ...pathSegments];

  const links = allSegments.slice(0, -1).map((seg, i) => {
    const href = allSegments.slice(0, i + 1).join('/');
    return `<a href="#/${esc(href)}">${esc(seg)}</a>`;
  });

  const lastSegment = allSegments[allSegments.length - 1];
  const last = `<span aria-current="page">${esc(lastSegment)}</span>`;
  const crumbs = [...links, last].join(' / ');
  return `<nav class="breadcrumb" aria-label="breadcrumb">${crumbs}</nav>`;
}

function renderTldr(descriptor: AggregateNeuronDescriptor): string {
  const { kind, title, stats } = descriptor;
  const langList = stats.languages.join(', ');
  let text: string;

  if (kind === 'project') {
    const langPart =
      stats.languages.length > 0
        ? ` across ${stats.languages.length} language${stats.languages.length !== 1 ? 's' : ''} (${esc(langList)})`
        : '';
    text = `Project ${esc(title)} — ${stats.fileCount} file${stats.fileCount !== 1 ? 's' : ''}, ${stats.totalLines} lines${langPart}.`;
  } else {
    const langPart = stats.languages.length > 0 ? ` — ${esc(langList)}` : '';
    text = `Module ${esc(title)} — ${stats.fileCount} file${stats.fileCount !== 1 ? 's' : ''}, ${stats.totalLines} lines${langPart}.`;
  }

  return `<section data-section="tldr">\n  <p>${text}</p>\n</section>`;
}

function renderChildrenSection(children: AggregateChild[]): string {
  if (children.length === 0) return '';

  const items = children
    .map((child) => {
      const href = `#/${esc(child.id)}`;
      const typeLabel = child.kind === 'module' ? '[module]' : '[file]';
      return `<li><a href="${href}">${esc(child.title)}</a> <small>${typeLabel}</small></li>`;
    })
    .join('\n    ');

  return [
    '<section data-section="children">',
    '  <h3>Contents</h3>',
    '  <ul>',
    `    ${items}`,
    '  </ul>',
    '</section>',
  ].join('\n');
}

function buildTocEntries(
  hasChildren: boolean,
  hasSeeAlso: boolean,
): Array<{ level: number; id: string; text: string }> {
  const entries: Array<{ level: number; id: string; text: string }> = [];

  if (hasChildren) {
    entries.push({ level: 1, id: 'children', text: 'Contents' });
  }

  if (hasSeeAlso) {
    entries.push({ level: 1, id: 'see-also', text: 'See also' });
  }

  return entries;
}

function buildArticleId(projectName: string, path: string): string {
  const sanitized = `aggregate-${projectName}-${path || 'root'}`
    .replace(/[^a-z0-9]/gi, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .slice(0, 80);
  return sanitized;
}

// ---------------------------------------------------------------------------
// Main composer
// ---------------------------------------------------------------------------

/**
 * Compose a complete <article data-cerveau-type="aggregate-neuron"> HTML string.
 *
 * Always included:
 * - breadcrumb (project / …/ module)
 * - infobox (kind, fileCount, totalLines, languages)
 * - tldr (one-liner summary)
 * - children (linked list of sub-modules + file-neurons — navigation backbone)
 * - toc (links to sections)
 *
 * Conditional:
 * - see-also (sibling modules / parent) — only when seeAlso is non-empty
 *
 * Not included here (out of scope per task): decisions/bugs/tool-trace sections.
 */
export function composeAggregateNeuron(descriptor: AggregateNeuronDescriptor): string {
  const now = new Date().toISOString().slice(0, 10);
  const { kind, title, path, projectName, children, stats, seeAlso = [] } = descriptor;

  const articleId = buildArticleId(projectName, path);

  const infobox = renderInfobox({
    rows: [
      { label: 'Kind', value: kind },
      { label: 'Files', value: String(stats.fileCount) },
      { label: 'Lines', value: String(stats.totalLines) },
      { label: 'Languages', value: stats.languages.join(', ') },
    ],
  });

  const hasSeeAlso = seeAlso.length > 0;
  const hasChildren = children.length > 0;
  const tocEntries = buildTocEntries(hasChildren, hasSeeAlso);
  const toc = tocEntries.length > 0 ? renderToc({ entries: tocEntries }) : '';

  const seeAlsoSection = hasSeeAlso
    ? renderSeeAlso({ links: seeAlso.map((l) => ({ id: l.id, title: l.title })) })
    : '';

  // data-cerveau-topic: canonical lowercase project/code/path or project/code for root.
  // canonicalProjectSegment() ensures the grouping key matches conversation notes
  // regardless of on-disk casing (e.g. "Acme" dir → "acme" topic segment).
  const canonicalProject = canonicalProjectSegment(projectName);
  const topicPath = path
    ? `${esc(canonicalProject)}/code/${esc(path.replace(/\\/g, '/'))}`
    : `${esc(canonicalProject)}/code`;

  const parts: string[] = [
    '<article',
    `  id="${esc(articleId)}"`,
    `  data-cerveau-version="${PKG_VERSION}"`,
    `  data-cerveau-type="aggregate-neuron"`,
    `  data-cerveau-created="${now}T00:00:00Z"`,
    `  data-cerveau-source="code-scanner:aggregate"`,
    `  data-cerveau-tags="code ${esc(kind)} ${esc(projectName)} aggregate-neuron"`,
    `  data-cerveau-topic="${topicPath}"`,
    `  data-code-project="code-${esc(projectName)}"`,
    `  data-code-kind="${esc(kind)}"`,
    `  data-code-path="${esc(path.replace(/\\/g, '/'))}"`,
    '>',
    renderBreadcrumb(projectName, path),
    `<h1>${esc(title)}</h1>`,
    infobox,
    renderTldr(descriptor),
    toc,
    renderChildrenSection(children),
    seeAlsoSection,
    '</article>',
  ];

  return parts.filter((p) => p.trim().length > 0).join('\n');
}
