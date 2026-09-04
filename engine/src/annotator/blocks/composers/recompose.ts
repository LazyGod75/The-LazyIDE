/**
 * recompose.ts — patch enrichment sections of a file-neuron WITHOUT rescanning code.
 *
 * Used after a team pull or post-capture: the structural parts of the
 * file-neuron (breadcrumb, infobox, architecture, children) are preserved
 * verbatim; only the data-section="decisions|bugs|ideas|rules|qa|warnings|activity"
 * sections are rebuilt from a supplied list of authored items.
 *
 * Deterministic: two authors with the same items produce identical HTML.
 */

import { parseHTML } from 'linkedom';
import { normalizeItemText, type EnrichmentItem } from './file-neuron.js';

export interface AuthoredItem extends EnrichmentItem {
  kind: string;
  about?: string;
  project?: string;
  authorId?: string;
  author?: string;
  itemId?: string;
  orgId?: string;
  status?: string;
}

const SECTION_META: ReadonlyArray<{ kind: string; sectionId: string; heading: string }> = [
  { kind: 'decision', sectionId: 'decisions', heading: 'Decisions' },
  { kind: 'bug', sectionId: 'bugs', heading: 'Bugs' },
  { kind: 'idea', sectionId: 'ideas', heading: 'Ideas' },
  { kind: 'rule', sectionId: 'rules', heading: 'Rules' },
  { kind: 'qa', sectionId: 'qa', heading: 'Q & A' },
  { kind: 'warning', sectionId: 'warnings', heading: 'Warnings' },
  { kind: 'activity', sectionId: 'activity', heading: 'Touched in Conversations' },
];

function sortByDateDesc(items: AuthoredItem[]): AuthoredItem[] {
  return [...items].sort((a, b) => b.date.localeCompare(a.date));
}

function dedupByItemId(items: AuthoredItem[]): AuthoredItem[] {
  const seen = new Set<string>();
  const out: AuthoredItem[] = [];
  for (const item of items) {
    if (item.itemId) {
      if (seen.has(item.itemId)) continue;
      seen.add(item.itemId);
    }
    out.push(item);
  }
  return out;
}

function buildLi(document: Document, item: AuthoredItem): HTMLElement {
  const li = document.createElement('li');
  li.setAttribute('data-cerveau-confidence', String(item.confidence));
  li.setAttribute('data-cerveau-date', item.date);
  if (item.superseded) {
    li.setAttribute('data-cerveau-superseded', 'true');
    li.setAttribute('data-cerveau-valid-until', item.validUntil ?? '');
  }
  if (item.authorId) li.setAttribute('data-cerveau-author-id', item.authorId);
  if (item.author) li.setAttribute('data-cerveau-author', item.author);
  if (item.kind) li.setAttribute('data-cerveau-kind', item.kind);
  if (item.itemId) li.setAttribute('data-cerveau-item-id', item.itemId);
  if (item.about) li.setAttribute('data-cerveau-about', item.about);
  if (item.project) li.setAttribute('data-cerveau-project', item.project);
  li.textContent = normalizeItemText(item.text);
  if (item.sourceConvLink) {
    const a = document.createElement('a');
    a.setAttribute('href', item.sourceConvLink);
    a.setAttribute('class', 'conv-source');
    a.textContent = '[source]';
    li.appendChild(document.createTextNode(' '));
    li.appendChild(a);
  }
  return li;
}

function buildSection(document: Document, meta: { sectionId: string; heading: string }, items: AuthoredItem[]): HTMLElement {
  const section = document.createElement('section');
  section.setAttribute('data-section', meta.sectionId);
  const h3 = document.createElement('h3');
  h3.textContent = meta.heading;
  section.appendChild(h3);
  const ul = document.createElement('ul');
  for (const item of items) {
    ul.appendChild(buildLi(document, item));
  }
  section.appendChild(ul);
  return section;
}

/**
 * Patch the enrichment sections of a file-neuron HTML article from a list
 * of authored items. Does NOT rescan the code — the structure (breadcrumb,
 * infobox, architecture, children) is preserved verbatim. Only the
 * data-section="decisions|bugs|ideas|rules|qa|warnings|activity" sections
 * are rebuilt from the items.
 *
 * Deterministic: two authors with the same items produce identical HTML.
 * Items are sorted by date descending within each section.
 */
export function recomposeFileNeuronEnrichment(existingHtml: string, items: AuthoredItem[]): string {
  const { document } = parseHTML(`<!doctype html><html><body>${existingHtml}</body></html>`);
  const article = document.querySelector('article[data-cerveau-type="file-neuron"]');
  if (!article) return existingHtml;

  const grouped = new Map<string, AuthoredItem[]>();
  for (const item of items) {
    const list = grouped.get(item.kind) ?? [];
    list.push(item);
    grouped.set(item.kind, list);
  }

  for (const meta of SECTION_META) {
    const raw = grouped.get(meta.kind) ?? [];
    const processed = dedupByItemId(sortByDateDesc(raw));

    const existing = article.querySelector(`section[data-section="${meta.sectionId}"]`);
    if (existing) {
      existing.remove();
    }

    if (processed.length === 0) continue;

    const newSection = buildSection(document, meta, processed);
    const seeAlso = article.querySelector('section[data-section="see-also"]');
    if (seeAlso) {
      article.insertBefore(newSection, seeAlso);
    } else {
      article.appendChild(newSection);
    }
  }

  return article.outerHTML;
}
