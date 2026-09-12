/**
 * Synthesize command: generate topic overview pages and brain index.
 *
 * Reads all notes, groups them by primary topic tag, and produces:
 *   - One topic-overview page per topic (when stale or missing)
 *   - One brain-index page listing all topics (when no specific topic is requested)
 *
 * Idempotent by design: freshness is checked via data-cerveau-synthesized-at.
 */

import { parseHTML } from 'linkedom';
import { composeBrainIndex } from '../annotator/blocks/composers/brain-index.js';
import {
  type GraphEmbedInput,
  composeGraphSection,
} from '../annotator/blocks/composers/graph-embed.js';
import { composeTopicOverview } from '../annotator/blocks/composers/topic-overview.js';
import { type BacklinksIndex, loadBacklinks } from '../graph/backlinks.js';
import {
  type BrainKnowledgeGraph,
  extractSubGraph,
  loadKnowledgeGraph,
} from '../graph/knowledge-graph.js';
import { indexNote, listAll } from '../indexer/fts.js';
import type { IndexedNote } from '../indexer/note-types.js';
import { type NoteFile, readAllNotes, readNote } from '../store/reader.js';
import { writeNote } from '../store/writer.js';
import { getLogger } from '../util/logger.js';
import { nowIso } from '../util/telemetry.js';
import { isAgentMetaText } from './dream.js';
import { isNoteMetadataResidue } from './enrich.js';

export interface SynthesizeOptions {
  topic?: string;
  dryRun?: boolean;
}

export interface SynthesizeReport {
  synthesized: string[];
  skipped: string[];
  errors: string[];
}

/** Types that represent synthesized/meta pages, excluded from grouping. */
const SYNTHESIS_TYPES = new Set(['topic-overview', 'project-summary', 'brain-index']);

/**
 * Pre-extracted per-note attributes — the fields synthesize reads off every
 * note's <article>. runSynthesize builds this ONCE from the SQLite index
 * (type/topic/created/importance are all indexed columns) instead of paying
 * a linkedom parseHTML() per note per lookup site — measured on a 5k-note
 * brain: the per-topic findExistingSynthesis + phase-1.5 allNotes.find()
 * pattern cost O(topics × notes) full DOM parses, the dominant share of
 * dream's multi-minute synthesize tail (full core + >2GB at >10min).
 * Notes without an index row (freshly written this run, or index drift)
 * get exactly one lazy parse — same behavior as before for them.
 */
export interface NoteMeta {
  type: string;
  topic: string;
  created: string;
  importance: number;
}

function metaFromIndexed(n: IndexedNote): NoteMeta {
  return {
    type: n.type ?? '',
    topic: n.topic ?? '',
    created: n.created ?? '',
    importance: n.importance ?? 0.5,
  };
}

function metaFromHtml(html: string): NoteMeta {
  const { document } = parseHTML(html);
  const article = document.querySelector('article');
  return {
    type: article?.getAttribute('data-cerveau-type') ?? '',
    topic: article?.getAttribute('data-cerveau-topic') ?? '',
    created: article?.getAttribute('data-cerveau-created') ?? '',
    importance:
      Number.parseFloat(article?.getAttribute('data-cerveau-importance') ?? '0.5') || 0.5,
  };
}

/** Build the path → meta map for a corpus: index rows when present, one
 *  lazy parse per unindexed note otherwise. */
export function buildNoteMeta(
  notes: readonly NoteFile[],
  indexed: readonly IndexedNote[],
): Map<string, NoteMeta> {
  const byPath = new Map(indexed.map((n) => [n.path, n]));
  const meta = new Map<string, NoteMeta>();
  for (const note of notes) {
    const row = byPath.get(note.path);
    meta.set(note.path, row ? metaFromIndexed(row) : metaFromHtml(note.html));
  }
  return meta;
}

/**
 * Group notes by ALL ancestor paths of their data-cerveau-topic hierarchy,
 * excluding synthesis pages.
 *
 * Example: topic "acme/mobile/architecture" → adds note to keys:
 *   "acme", "acme/mobile", "acme/mobile/architecture"
 *
 * Returns a Map<topicPath, NoteFile[]>.
 */
export function groupNotesByFullTopic(
  notes: NoteFile[],
  meta?: Map<string, NoteMeta>,
): Map<string, NoteFile[]> {
  const groups = new Map<string, NoteFile[]>();

  for (const note of notes) {
    const m = meta?.get(note.path) ?? metaFromHtml(note.html);
    if (SYNTHESIS_TYPES.has(m.type)) continue;

    const topicAttr = m.topic;
    if (!topicAttr.trim()) continue;

    const segments = topicAttr.split('/').filter(Boolean);
    for (let depth = 1; depth <= segments.length; depth++) {
      const path = segments.slice(0, depth).join('/');
      const existing = groups.get(path) ?? [];
      existing.push(note);
      groups.set(path, existing);
    }
  }

  return groups;
}

/**
 * Build a breadcrumb navigation for a hierarchical topic path.
 * E.g. "acme/mobile" → Brain › Acme › Mobile
 */
function buildBreadcrumb(topicPath: string): string {
  const segments = topicPath.split('/').filter(Boolean);
  const parts: string[] = ['<a href="#/brain-index">Brain</a>'];
  for (let i = 0; i < segments.length; i++) {
    const path = segments.slice(0, i + 1).join('/');
    const name = segments[i].charAt(0).toUpperCase() + segments[i].slice(1);
    if (i === segments.length - 1) {
      parts.push(`<span>${name}</span>`);
    } else {
      parts.push(`<a href="#/topic-overview-${path.replace(/\//g, '-')}">${name}</a>`);
    }
  }
  return `<nav class="breadcrumb">${parts.join(' › ')}</nav>`;
}

/**
 * Build a sub-topics section listing direct children of the given topic path
 * as clickable links with note counts.
 */
function buildChildTopicsSection(topicPath: string, fullGroups: Map<string, NoteFile[]>): string {
  const prefix = `${topicPath}/`;
  const children: Array<{ name: string; path: string; count: number }> = [];

  for (const [path, notes] of fullGroups) {
    // Direct children only: path starts with prefix and has exactly one more segment
    if (path.startsWith(prefix) && !path.slice(prefix.length).includes('/')) {
      children.push({
        name: path.slice(prefix.length),
        path,
        count: notes.length,
      });
    }
  }

  if (children.length === 0) return '';

  const rows = children
    .sort((a, b) => b.count - a.count)
    .map((c) => {
      const slug = c.path.replace(/\//g, '-');
      const title = c.name.charAt(0).toUpperCase() + c.name.slice(1);
      return `<li><a href="#/topic-overview-${slug}">${title}</a> (${c.count} notes)</li>`;
    })
    .join('\n');

  return `<section data-section="sub-topics">
  <h2>Sub-topics</h2>
  <ul class="sub-topic-list">${rows}</ul>
</section>`;
}

/**
 * Group notes by the first segment of their data-cerveau-topic hierarchy,
 * excluding synthesis pages.
 *
 * Example: topic "acme/mobile/workout" → group key "acme".
 * Falls back to the first space-separated tag when topic is absent.
 *
 * Returns a Map<topicKey, NoteFile[]>.
 */
export function groupNotesByTopic(
  notes: NoteFile[],
  meta?: Map<string, NoteMeta>,
): Map<string, NoteFile[]> {
  const groups = new Map<string, NoteFile[]>();

  for (const note of notes) {
    const m = meta?.get(note.path) ?? metaFromHtml(note.html);
    if (SYNTHESIS_TYPES.has(m.type)) continue;

    const topicTag = m.topic.split('/')[0]?.trim();
    if (!topicTag) continue;

    const existing = groups.get(topicTag) ?? [];
    existing.push(note);
    groups.set(topicTag, existing);
  }

  return groups;
}

/**
 * Aggregate statistics for a set of notes belonging to a topic.
 */
export function aggregateTopicStats(
  notes: NoteFile[],
  meta?: Map<string, NoteMeta>,
): {
  noteCount: number;
  typeBreakdown: Record<string, number>;
  dateRange: [string, string];
  avgImportance: number;
} {
  const typeBreakdown: Record<string, number> = {};
  let totalImportance = 0;
  let earliest = '';
  let latest = '';

  for (const note of notes) {
    const m = meta?.get(note.path) ?? metaFromHtml(note.html);

    const type = m.type || 'unknown';
    typeBreakdown[type] = (typeBreakdown[type] ?? 0) + 1;

    totalImportance += m.importance;

    const created = m.created;
    if (created) {
      if (!earliest || created < earliest) earliest = created;
      if (!latest || created > latest) latest = created;
    }
  }

  return {
    noteCount: notes.length,
    typeBreakdown,
    dateRange: [earliest, latest],
    avgImportance: notes.length > 0 ? totalImportance / notes.length : 0,
  };
}

/**
 * Determine whether the existing synthesis page is stale relative to the
 * most recently modified note (by filesystem mtime).
 *
 * Returns true when:
 *   - no synthesis page exists (synthHtml is null)
 *   - the synthesis page lacks a data-cerveau-synthesized-at attribute
 *   - any note was modified after the synthesis page was generated
 */
export function isStale(synthHtml: string | null, latestNoteMtimeMs: number): boolean {
  if (!synthHtml) return true;

  const { document } = parseHTML(synthHtml);
  const article = document.querySelector('article');
  const synthAt = article?.getAttribute('data-cerveau-synthesized-at');

  if (!synthAt) return true;

  return new Date(synthAt).getTime() < latestNoteMtimeMs;
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

interface NoteContent {
  id: string;
  title: string;
  tldr: string;
  tldrHtml: string;
  summaryText: string;
  summaryHtml: string;
  facts: string[];
  subTopic: string;
  type: string;
  tips: string[];
  warnings: string[];
  specsHtml: string;
  status: string;
  decisionOutcome: string;
  decisionReasoning: string;
  bugSymptom: string;
  bugFix: string;
}

/**
 * Known tech terms to wrap in <data value="..."> for triple-purpose HTML.
 * Visual: tech badge pill. Strip: term[value] notation. Query: data[value*="X"].
 */
const TECH_TERMS: string[] = [
  'React Native',
  'Expo',
  'Supabase',
  'TypeScript',
  'JavaScript',
  'Next.js',
  'Tailwind',
  'Stripe',
  'MT5',
  'MetaTrader',
  'Blender',
  'MCP',
  'Python',
  'Node.js',
  'PostgreSQL',
  'NativeWind',
  'TanStack Query',
  'expo-router',
  'FCM',
  'Notifee',
  'Electron',
  'GPT',
  'OpenAI',
  'Render',
  'Vercel',
  'GitHub',
  'Prisma',
  'Redis',
  'Docker',
  'Zod',
];

/**
 * Wrap recognized tech terms in <data value="term">term</data> for triple-purpose HTML.
 * Matches whole words only to avoid partial wrapping.
 * Processes longest terms first to prevent partial overwrites.
 */
function wrapTechTerms(text: string): string {
  if (!text) return text;
  // Sort by length descending to match longer terms first (e.g. "React Native" before "React")
  const sorted = [...TECH_TERMS].sort((a, b) => b.length - a.length);
  let result = text;
  for (const term of sorted) {
    // Skip if already wrapped (contains data value tag)
    const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<!value="|>)\\b(${escapedTerm})\\b(?![^<]*>)`, 'g');
    result = result.replace(re, `<data value="${term}">$1</data>`);
  }
  return result;
}

/**
 * Wrap the first mention of a project/feature name in <dfn>.
 * Used for the first occurrence in each section.
 */
function wrapFirstMention(text: string, term: string): string {
  if (!text || !term) return text;
  const escapedTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\b(${escapedTerm})\\b`);
  return text.replace(re, '<dfn>$1</dfn>');
}

/**
 * Returns true when a text chunk is agent-framework scaffolding or LazyBrain
 * internal note-metadata — either predicate is sufficient to discard the chunk.
 */
function isNoise(t: string): boolean {
  return isAgentMetaText(t) || isNoteMetadataResidue(t);
}

/**
 * Parse a note's HTML to extract real prose content for article generation.
 * Title comes from the first <h2>; tldr and summary from data-section attributes;
 * facts from data-cerveau-fact elements; subTopic from the second path segment.
 * Also extracts: tips, warnings, specs dl blocks for rich semantic HTML output.
 */
export function extractNoteContent(note: NoteFile): NoteContent {
  const { document } = parseHTML(note.html);
  const article = document.querySelector('article');

  // Prefer the article's own id attribute; fall back to note.id from the filesystem.
  // This guards against idFromHtml accidentally picking up a <section id="..."> that
  // appears before <article id="..."> in malformed HTML.
  // Also guard against template variable leakage (e.g. $id1, $id14).
  const rawArticleId = article?.getAttribute('id') ?? '';
  const articleId =
    rawArticleId.startsWith('$') || rawArticleId.length < 5 || /^[a-z]+$/.test(rawArticleId)
      ? ''
      : rawArticleId;
  const noteId = articleId || note.id;

  const h2 = article?.querySelector('h2');
  const title = (h2?.textContent ?? '').trim() || noteId;

  const tldrSection = article?.querySelector('[data-section="tldr"]');
  const tldrRaw = (tldrSection?.textContent ?? '').trim();
  const tldr = isNoise(tldrRaw) ? '' : tldrRaw;
  const tldrHtml = tldrSection?.innerHTML ?? '';

  const summarySection = article?.querySelector('[data-section="summary"]');
  const summaryRaw = (summarySection?.textContent ?? '').trim();
  const summaryText = isNoise(summaryRaw) ? '' : summaryRaw;
  const summaryHtml = summarySection?.innerHTML ?? '';

  const factElements = article?.querySelectorAll('[data-cerveau-fact]') ?? [];
  const facts = Array.from(factElements)
    .map((f) => (f.textContent ?? '').trim())
    .filter((x) => Boolean(x) && !isNoise(x));

  const topicAttr = article?.getAttribute('data-cerveau-topic') ?? '';
  const segments = topicAttr.split('/').filter(Boolean);
  const subTopic = segments[1] ?? 'general';

  const type = article?.getAttribute('data-cerveau-type') ?? 'reference';

  // Extract aside[role="doc-tip"] text
  const tipElements = article?.querySelectorAll('aside[role="doc-tip"]') ?? [];
  const tips = Array.from(tipElements)
    .map((el) => (el.textContent ?? '').trim())
    .filter((x) => Boolean(x) && !isNoise(x));

  // Extract aside[role="doc-warning"] text
  const warnElements = article?.querySelectorAll('aside[role="doc-warning"]') ?? [];
  const warnings = Array.from(warnElements)
    .map((el) => (el.textContent ?? '').trim())
    .filter((x) => Boolean(x) && !isNoise(x));

  // Extract first <dl> as specs HTML
  const dlEl = article?.querySelector('dl');
  const specsHtml = dlEl ? (dlEl.outerHTML ?? '') : '';

  // Extract status from data-cerveau-status or mark[data-cerveau-status]
  const statusAttr = article?.getAttribute('data-cerveau-status') ?? '';
  const statusMarkEl = article?.querySelector('mark[data-cerveau-status]');
  const status = statusAttr || (statusMarkEl?.getAttribute('data-cerveau-status') ?? '');

  // Extract decision outcome and reasoning from aside.decision-record or aside[role="doc-note"]
  const decisionEl = article?.querySelector(
    'aside[role="doc-note"], aside.decision-record, aside.decision-block',
  );
  const decisionOutcomeRaw =
    (decisionEl?.querySelector('.decision-outcome')?.textContent ?? '').trim() ||
    (decisionEl?.querySelector('p')?.textContent ?? '').trim();
  const decisionOutcome = isNoise(decisionOutcomeRaw) ? '' : decisionOutcomeRaw;
  const decisionReasoning = (
    decisionEl?.querySelector('.decision-reasoning')?.textContent ?? ''
  ).trim();

  // Extract bug symptom and fix from aside[role="doc-errata"]
  const bugEl = article?.querySelector('aside[role="doc-errata"]');
  const bugSymptomRaw =
    (bugEl?.querySelector('.bug-symptom')?.textContent ?? '').replace(/^symptom:\s*/i, '').trim() ||
    (bugEl?.querySelector('p')?.textContent ?? '').trim();
  const bugSymptom = isNoise(bugSymptomRaw) ? '' : bugSymptomRaw;
  const bugFix = (bugEl?.querySelector('.bug-fix')?.textContent ?? '')
    .replace(/^fix:\s*/i, '')
    .trim();

  return {
    id: noteId,
    title,
    tldr,
    tldrHtml,
    summaryText,
    summaryHtml,
    facts,
    subTopic,
    type,
    tips,
    warnings,
    specsHtml,
    status,
    decisionOutcome,
    decisionReasoning,
    bugSymptom,
    bugFix,
  };
}

interface ArticleParts {
  leadText: string;
  sections: string;
}

/**
 * Render fact highlights as styled HTML elements with tech term wrapping.
 */
function renderFactHighlights(facts: string[]): string {
  if (facts.length === 0) return '';
  const items = facts
    .slice(0, 4)
    .map((fact) => {
      const enriched = wrapTechTerms(fact);
      return `<div class="fact-item"><span class="fact-bullet"></span>${enriched}</div>`;
    })
    .join('\n');
  return `<div class="fact-highlights">\n${items}\n</div>`;
}

/**
 * Render callout boxes from tips and warnings extracted from notes.
 * Uses aside[role="doc-tip|doc-warning"] for triple-purpose HTML.
 */
function renderCallouts(tips: string[], warnings: string[]): string {
  const parts: string[] = [];
  for (const tip of tips.slice(0, 2)) {
    parts.push(`<aside role="doc-tip">${wrapTechTerms(tip)}</aside>`);
  }
  for (const warn of warnings.slice(0, 2)) {
    parts.push(`<aside role="doc-warning">${wrapTechTerms(warn)}</aside>`);
  }
  return parts.join('\n');
}

/**
 * Build a <dl class="specs"> from raw specs HTML extracted from notes,
 * or return empty string when none available.
 */
function renderSpecs(specsHtml: string): string {
  if (!specsHtml) return '';
  // If it's already a <dl>, add the class="specs" attribute
  if (specsHtml.trimStart().startsWith('<dl')) {
    return specsHtml.replace(/^<dl([^>]*)>/, '<dl class="specs"$1>');
  }
  return '';
}

/**
 * Render a status badge for a note with a known status.
 */
function renderStatusBadge(status: string): string {
  if (!status) return '';
  const normalized = status.toLowerCase().replace(/[^a-z0-9-]/g, '-');
  return `<mark data-cerveau-status="${normalized}" class="status-badge ${normalized}">${status}</mark>`;
}

/**
 * Render a decision box from a note of type "decision" with outcome/reasoning.
 */
function renderDecisionBox(outcome: string, reasoning: string): string {
  if (!outcome) return '';
  const reasoningHtml = reasoning
    ? `<p class="decision-reasoning">${wrapTechTerms(reasoning)}</p>`
    : '';
  return `<aside role="doc-note" class="decision-box">
  <strong>Decision:</strong> ${wrapTechTerms(outcome)}
  ${reasoningHtml}
</aside>`;
}

/**
 * Render a bug card from a note of type "episodic" with bug symptom/fix.
 */
function renderBugCard(symptom: string, fix: string): string {
  if (!symptom) return '';
  const fixHtml = fix ? `<p class="bug-fix">Fix: ${wrapTechTerms(fix)}</p>` : '';
  return `<aside role="doc-errata" class="bug-card">
  <strong>Bug:</strong> ${wrapTechTerms(symptom)}
  ${fixHtml}
</aside>`;
}

/**
 * Render a row of metric cards (note count, sub-topic count, decision count).
 */
function renderMetricRow(noteCount: number, subTopicCount: number, decisionCount: number): string {
  const cards = [
    { value: noteCount, label: 'notes' },
    { value: subTopicCount, label: 'sub-topics' },
  ];
  if (decisionCount > 0) {
    cards.push({ value: decisionCount, label: 'decisions' });
  }
  const cardHtml = cards
    .map(
      (c) =>
        `<div class="metric-card">
  <data value="${c.value}" class="metric-value">${c.value}</data>
  <span class="metric-label">${c.label}</span>
</div>`,
    )
    .join('\n');
  return `<div class="metric-row">\n${cardHtml}\n</div>`;
}

/**
 * Render a compact wikitable summarizing sub-topics.
 */
function renderSubTopicsTable(bySubTopic: Map<string, NoteContent[]>, topicSlug: string): string {
  if (bySubTopic.size < 2) return '';
  const rows = Array.from(bySubTopic.entries())
    .map(([subTopic, items]) => {
      const sectionId = subTopic.replace(/[^a-z0-9]+/g, '-').toLowerCase();
      const typeSet = new Set(items.map((i) => i.type));
      const types = Array.from(typeSet)
        .map(
          (t) =>
            `<span class="type-badge ${t}">${items.filter((i) => i.type === t).length} ${t}</span>`,
        )
        .join(' ');
      return `<tr>
  <td><a href="#/${topicSlug}/${sectionId}" class="section-link">${subTopic.charAt(0).toUpperCase() + subTopic.slice(1)}</a></td>
  <td>${items.length}</td>
  <td>${types}</td>
</tr>`;
    })
    .join('\n');

  return `<table class="wikitable compact">
  <caption>Sub-topic Distribution</caption>
  <thead><tr><th>Area</th><th>Notes</th><th>Types</th></tr></thead>
  <tbody>
    ${rows}
  </tbody>
</table>`;
}

/**
 * Render a row of clickable note chips colored by type.
 * Each chip includes a title attribute for tooltip on hover.
 */
function renderRelatedNotes(items: NoteContent[]): string {
  if (items.length === 0) return '';
  const chips = items
    .slice(0, 6)
    // Skip notes whose id is empty, suspiciously short, or a template variable
    .filter((item) => item.id.length >= 5 && !item.id.startsWith('$') && !/^[a-z]+$/.test(item.id))
    .map((item) => {
      const typeClass = item.type.replace(/[^a-z0-9]/gi, '-').toLowerCase();
      // Use tldr as tooltip text, fallback to title
      const tooltip = (item.tldr || item.title).replace(/"/g, '&quot;').slice(0, 120);
      return `<a href="#/note/${item.id}" class="note-chip ${typeClass}" title="${tooltip}">${item.title}</a>`;
    })
    .join('\n');
  if (!chips) return '';
  return `<div class="related-notes">
  <span class="related-label">Articles:</span>
  ${chips}
</div>`;
}

/**
 * Build Wikipedia-style article sections from note content.
 * Groups notes by sub-topic; each sub-topic becomes a rich <h2> section with:
 *   - <dfn> for first mention of the section subject
 *   - <data value="..."> for tech terms (visual badge + strip compact + queryable)
 *   - <aside role="doc-tip|doc-warning"> from notes
 *   - <dl class="specs"> from note definition lists
 *   - fact highlights and clickable note chips
 * The lead paragraph is built from the first 3 TLDRs with tech terms enriched.
 */
function buildArticleSections(topicName: string, notes: NoteFile[]): ArticleParts {
  const contents = notes.map((n) => extractNoteContent(n));

  // Group by sub-topic preserving insertion order
  const bySubTopic = new Map<string, NoteContent[]>();
  for (const c of contents) {
    const group = bySubTopic.get(c.subTopic) ?? [];
    bySubTopic.set(c.subTopic, [...group, c]);
  }

  // Build lead from first 3 TLDRs — enrich with tech terms
  const allTldrs = contents.map((c) => c.tldr).filter(Boolean);
  const rawLead = allTldrs.slice(0, 3).join(' ') || `Overview of ${topicName}.`;
  const leadText = wrapTechTerms(rawLead);

  // Build one rich section per sub-topic
  const topicSlug = topicName.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const sectionParts: string[] = [];

  // Count decisions for metric row
  const decisionCount = contents.filter((c) => c.type === 'decision').length;

  // Metric row at the start
  const metricRowHtml = renderMetricRow(contents.length, bySubTopic.size, decisionCount);

  for (const [subTopic, items] of bySubTopic) {
    const sectionTitle = subTopic.charAt(0).toUpperCase() + subTopic.slice(1);
    const sectionId = subTopic.replace(/[^a-z0-9]+/g, '-').toLowerCase();

    // Build prose: use summaryText when tldr is short, else combine both
    // Enrich with tech terms and dfn for first mention of section title
    const proseParts = items
      .map((item) => {
        const base = item.summaryText || item.tldr;
        return base;
      })
      .filter(Boolean);

    let prose = proseParts.length > 0 ? proseParts.join(' ') : '';
    // Wrap tech terms in prose
    prose = wrapTechTerms(prose);
    // Wrap first mention of sectionTitle in <dfn>
    prose = wrapFirstMention(prose, sectionTitle);

    // Collect all facts from all notes in this sub-topic
    const allFacts = items.flatMap((item) => item.facts);

    // Collect tips and warnings from all notes in this sub-topic
    const allTips = items.flatMap((item) => item.tips);
    const allWarnings = items.flatMap((item) => item.warnings);

    // Get first available specs dl
    const specsHtmlRaw = items.map((item) => item.specsHtml).find((s) => s) ?? '';
    const specsHtml = renderSpecs(specsHtmlRaw);

    // Render decision boxes for decision-type notes
    const decisionBoxes = items
      .filter((item) => item.type === 'decision' && (item.decisionOutcome || item.tldr))
      .map((item) => renderDecisionBox(item.decisionOutcome || item.tldr, item.decisionReasoning))
      .filter(Boolean)
      .slice(0, 3)
      .join('\n');

    // Render bug cards for episodic-type notes with error content
    const bugCards = items
      .filter((item) => item.type === 'episodic' && (item.bugSymptom || item.tldr))
      .map((item) => renderBugCard(item.bugSymptom || item.tldr, item.bugFix))
      .filter(Boolean)
      .slice(0, 3)
      .join('\n');

    // Render status badges for notes with known status
    const statusBadges = items
      .filter((item) => item.status)
      .map((item) => renderStatusBadge(item.status))
      .filter(Boolean)
      .join(' ');

    const proseParagraph = prose
      ? `<p>${prose}${statusBadges ? ` ${statusBadges}` : ''}</p>`
      : statusBadges
        ? `<p>${statusBadges}</p>`
        : '';
    const calloutsHtml = renderCallouts(allTips, allWarnings);
    const factsHtml = renderFactHighlights(allFacts);
    const relatedHtml = renderRelatedNotes(items);

    // Build section parts, skipping empty ones
    const innerParts = [
      proseParagraph,
      decisionBoxes,
      bugCards,
      calloutsHtml,
      specsHtml,
      factsHtml,
      relatedHtml,
    ]
      .filter(Boolean)
      .join('\n    ');

    sectionParts.push(
      `<section class="wiki-section" id="${sectionId}">
  <h2><a href="#/${topicSlug}/${sectionId}" class="section-link">${sectionTitle}</a></h2>
  <div class="section-content">
    ${innerParts}
  </div>
</section>`,
    );
  }

  // Add sub-topics summary table after all sections
  const subTopicsTable = renderSubTopicsTable(bySubTopic, topicSlug);

  // Prepend metric row and append table to sections
  const allSections = [metricRowHtml, ...sectionParts, subTopicsTable].filter(Boolean).join('\n');

  return { leadText, sections: allSections };
}

/**
 * Find topics that are related to the given topic via the backlinks index.
 * A topic is considered related if any of its notes link to (or are linked
 * from) notes belonging to another topic.
 */
function findRelatedTopics(
  topic: string,
  backlinks: BacklinksIndex | null,
  groups: Map<string, NoteFile[]>,
): Array<{ id: string; title: string }> {
  if (!backlinks) return [];

  const topicNoteIds = new Set((groups.get(topic) ?? []).map((n) => n.id));
  const relatedTopicNames = new Set<string>();

  // Gather all note ids that are linked to/from this topic's notes
  for (const noteId of topicNoteIds) {
    const outEdges = backlinks.outgoing[noteId] ?? [];
    const inEdges = backlinks.incoming[noteId] ?? [];

    for (const edge of [...outEdges, ...inEdges]) {
      const otherId = edge.from === noteId ? edge.to : edge.from;
      // Find which topic this other note belongs to
      for (const [otherTopic, otherNotes] of groups) {
        if (otherTopic === topic) continue;
        if (otherNotes.some((n) => n.id === otherId)) {
          relatedTopicNames.add(otherTopic);
        }
      }
    }
  }

  return Array.from(relatedTopicNames).map((name) => ({
    id: name,
    title: name.charAt(0).toUpperCase() + name.slice(1),
  }));
}

/**
 * Find the existing synthesis page for a given topic among all notes.
 * Matches on the first segment of data-cerveau-topic (e.g., "acme").
 * Returns null if none exists.
 */
function findExistingSynthesis(
  topic: string,
  allNotes: NoteFile[],
  meta?: Map<string, NoteMeta>,
): NoteFile | null {
  for (const note of allNotes) {
    const m = meta?.get(note.path) ?? metaFromHtml(note.html);
    if (m.type !== 'topic-overview') continue;
    const firstSegment = m.topic.split('/')[0]?.trim();
    if (firstSegment === topic) return note;
  }
  return null;
}

/**
 * Find the existing brain-index page among all notes.
 */
function findExistingBrainIndex(
  allNotes: NoteFile[],
  meta?: Map<string, NoteMeta>,
): NoteFile | null {
  for (const note of allNotes) {
    const m = meta?.get(note.path) ?? metaFromHtml(note.html);
    if (m.type === 'brain-index') return note;
  }
  return null;
}

/**
 * Convert a BrainKnowledgeGraph to a GraphEmbedInput for composeGraphSection.
 * Cross-project edges are derived from edges whose type starts with "cross-project:".
 */
function graphToEmbedInput(
  graph: BrainKnowledgeGraph,
  scope: 'brain' | 'project',
  project?: string,
): GraphEmbedInput {
  const crossProjectEdges =
    scope === 'project'
      ? graph.edges
          .filter((e) => e.type.startsWith('cross-project:'))
          .map((e) => {
            const targetNode = graph.nodes.find((n) => n.id === e.target);
            return {
              source: e.source,
              target: e.target,
              targetProject: targetNode?.topic ?? 'unknown',
              type: e.type.replace('cross-project:', ''),
            };
          })
      : undefined;

  return {
    scope,
    project,
    stats: {
      nodes: graph.stats.nodes,
      edges: graph.stats.edges,
      clusters: graph.stats.clusters,
      hubs: graph.stats.hubs,
    },
    clusters: graph.clusters.map((c) => ({
      id: c.id,
      label: c.label,
      nodeCount: c.nodeCount,
      hubs: graph.hubs
        .filter((h) => c.nodeIds.includes(h.id))
        .map((h) => ({ id: h.id, title: h.title })),
      connectedClusters: c.connectedClusters,
    })),
    hubs: graph.hubs.map((h) => ({
      id: h.id,
      title: h.title,
      topic: h.topic,
      inbound: h.inbound,
      outbound: h.outbound,
    })),
    edges: graph.edges
      .filter((e) => !e.type.startsWith('cross-project:'))
      .map((e) => ({
        source: e.source,
        target: e.target,
        type: e.type,
      })),
    crossProjectEdges,
    layers: graph.layers?.map((l) => ({
      id: l.id,
      name: l.name,
      description: l.description,
      nodeCount: l.nodeCount,
    })),
    tour: graph.tour?.map((t) => ({
      order: t.order,
      title: t.title,
      noteId: t.noteId,
      description: t.description,
    })),
  };
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run the synthesize phase:
 *   1. Read all notes
 *   2. Group by primary topic tag
 *   3. For each topic (or the specified one): generate/refresh topic-overview
 *   4. If no specific topic: generate/refresh brain-index
 */
export async function runSynthesize(opts: SynthesizeOptions): Promise<SynthesizeReport> {
  const log = getLogger();
  const report: SynthesizeReport = { synthesized: [], skipped: [], errors: [] };

  const allNotes = readAllNotes();
  // One meta map for the whole run: type/topic/created/importance come from
  // the SQLite index (zero file reads), with a single lazy parse per
  // unindexed note. Replaces the per-note parseHTML() that every grouping,
  // every per-topic synthesis lookup and the date-range pass used to pay.
  const metaByPath = buildNoteMeta(allNotes, listAll({ includeExpired: true }));
  // article-id → note lookup for the sub-topic freshness check below —
  // NoteFile.id is already the article id (reader.ts's idFromHtml), so this
  // map replaces what used to be an allNotes.find(parseHTML-per-note) scan
  // per sub-topic — O(subtopics × notes) DOM parses on a mature brain.
  const notesById = new Map(allNotes.map((n) => [n.id, n]));
  const groups = groupNotesByTopic(allNotes, metaByPath);
  const fullGroups = groupNotesByFullTopic(allNotes, metaByPath);
  const backlinks = loadBacklinks();
  const knowledgeGraph = loadKnowledgeGraph();
  const now = nowIso();

  const topicsToProcess = opts.topic
    ? opts.topic in Object.fromEntries(groups)
      ? [opts.topic]
      : [...groups.keys()].filter((k) => k === opts.topic)
    : [...groups.keys()];

  if (opts.topic && !groups.has(opts.topic)) {
    log.warn({ topic: opts.topic }, 'synthesize: topic not found in notes');
    return report;
  }

  // --- Phase 1: Topic overview pages (top-level, depth=1) ---
  for (const topic of topicsToProcess) {
    const topicNotes = groups.get(topic) ?? [];
    if (topicNotes.length === 0) continue;

    const existingSynth = findExistingSynthesis(topic, allNotes, metaByPath);
    const latestMtime = Math.max(...topicNotes.map((n) => n.mtimeMs));

    if (!isStale(existingSynth?.html ?? null, latestMtime)) {
      report.skipped.push(topic);
      continue;
    }

    try {
      const stats = aggregateTopicStats(topicNotes, metaByPath);
      const relatedTopics = findRelatedTopics(topic, backlinks, groups);
      const topicTitle = topic.charAt(0).toUpperCase() + topic.slice(1);
      const { leadText, sections } = buildArticleSections(topicTitle, topicNotes);

      const breadcrumb = buildBreadcrumb(topic);
      const childSection = buildChildTopicsSection(topic, fullGroups);
      let sectionsWithGraph = `${breadcrumb}\n${childSection}\n${sections}`;
      if (knowledgeGraph) {
        const subGraph = extractSubGraph(knowledgeGraph, topic);
        if (subGraph.nodes.length > 0) {
          const graphHtml = composeGraphSection(graphToEmbedInput(subGraph, 'project', topic));
          sectionsWithGraph = `${sectionsWithGraph}\n${graphHtml}`;
        }
      }

      const html = composeTopicOverview({
        id: `topic-overview-${topic}`,
        title: topicTitle,
        created: now,
        leadText,
        sections: sectionsWithGraph,
        stats,
        relatedTopics,
        tags: [topic, 'synthesis'],
        topic,
      });

      if (!opts.dryRun) {
        const written = writeNote(html, { overwrite: true });
        try {
          indexNote(readNote(written.path));
        } catch (err) {
          log.warn(
            { path: written.path, err: (err as Error).message },
            'synthesize: topic overview reindex',
          );
        }
      }

      report.synthesized.push(topic);
      log.debug({ topic, noteCount: stats.noteCount }, 'synthesize: topic overview generated');
    } catch (err) {
      const msg = (err as Error).message;
      report.errors.push(`${topic}: ${msg}`);
      log.warn({ topic, err: msg }, 'synthesize: topic overview failed');
    }
  }

  // --- Phase 1.5: Sub-topic pages (hierarchical wiki, depth >= 2) ---
  for (const [topicPath, topicNotes] of fullGroups) {
    const depth = topicPath.split('/').length;
    if (depth < 2) continue;
    if (topicNotes.length === 0) continue;
    if (opts.topic && !topicPath.startsWith(opts.topic)) continue;

    const pageId = `topic-overview-${topicPath.replace(/\//g, '-')}`;

    // Check freshness against an existing page with this id
    const existingPage = notesById.get(pageId);
    const latestMtime = Math.max(...topicNotes.map((n) => n.mtimeMs));
    if (!isStale(existingPage?.html ?? null, latestMtime)) {
      report.skipped.push(topicPath);
      continue;
    }

    try {
      const topicTitle = topicPath
        .split('/')
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(' / ');
      const stats = aggregateTopicStats(topicNotes);
      const relatedTopics = findRelatedTopics(topicPath.split('/')[0], backlinks, groups);

      const breadcrumb = buildBreadcrumb(topicPath);
      const childSection = buildChildTopicsSection(topicPath, fullGroups);

      // Notes whose topic is exactly this path or any descendant
      const directNotes = topicNotes.filter((n) => {
        const { document } = parseHTML(n.html);
        const topic = document.querySelector('article')?.getAttribute('data-cerveau-topic') ?? '';
        return topic === topicPath || topic.startsWith(`${topicPath}/`);
      });

      const { leadText, sections } = buildArticleSections(topicTitle, directNotes);

      let sectionsWithGraph = `${breadcrumb}\n${childSection}\n${sections}`;
      if (knowledgeGraph) {
        const subGraph = extractSubGraph(knowledgeGraph, topicPath, { matchPrefix: true });
        if (subGraph.nodes.length > 0) {
          const graphHtml = composeGraphSection(graphToEmbedInput(subGraph, 'project', topicPath));
          sectionsWithGraph = `${sectionsWithGraph}\n${graphHtml}`;
        }
      }

      const html = composeTopicOverview({
        id: pageId,
        title: topicTitle,
        created: now,
        leadText,
        sections: sectionsWithGraph,
        stats,
        relatedTopics,
        tags: [topicPath.split('/')[0], ...topicPath.split('/').slice(1), 'synthesis'],
        topic: topicPath,
      });

      if (!opts.dryRun) {
        const written = writeNote(html, { overwrite: true });
        try {
          indexNote(readNote(written.path));
        } catch (err) {
          log.warn(
            { path: written.path, err: (err as Error).message },
            'synthesize: sub-topic overview reindex',
          );
        }
      }

      report.synthesized.push(topicPath);
      log.debug(
        { topicPath, noteCount: topicNotes.length },
        'synthesize: sub-topic overview generated',
      );
    } catch (err) {
      const msg = (err as Error).message;
      report.errors.push(`${topicPath}: ${msg}`);
      log.warn({ topicPath, err: msg }, 'synthesize: sub-topic overview failed');
    }
  }

  // --- Phase 2: Brain index (only when not filtering by topic) ---
  if (!opts.topic) {
    const existingIndex = findExistingBrainIndex(allNotes, metaByPath);
    const latestNoteOverall = allNotes.length > 0 ? Math.max(...allNotes.map((n) => n.mtimeMs)) : 0;

    if (isStale(existingIndex?.html ?? null, latestNoteOverall)) {
      try {
        // Build global date range from all non-synthesis notes
        let globalEarliest = '';
        let globalLatest = '';
        let totalNotesCount = 0;

        const topicEntries = [...groups.entries()].map(([topicName, topicNotes]) => {
          totalNotesCount += topicNotes.length;
          const mtimes = topicNotes.map((n) => n.mtimeMs);
          const lastMtime = Math.max(...mtimes);
          const lastActivity = new Date(lastMtime).toISOString().slice(0, 10);

          // Track global date range — `created` comes from the meta map
          // (index column), not a per-note DOM parse.
          for (const n of topicNotes) {
            const created = metaByPath.get(n.path)?.created ?? '';
            if (created) {
              if (!globalEarliest || created < globalEarliest) globalEarliest = created;
              if (!globalLatest || created > globalLatest) globalLatest = created;
            }
          }

          // Extract a short description from the first note's TLDR
          const firstContent = extractNoteContent(topicNotes[0]);
          const description = firstContent.tldr || firstContent.summaryText || '';

          return {
            name: topicName.charAt(0).toUpperCase() + topicName.slice(1),
            id: `topic-overview-${topicName}`,
            noteCount: topicNotes.length,
            lastActivity,
            description,
          };
        });

        const topicNames = topicEntries.map((t) => t.name).join(', ');
        const leadText = `This brain covers ${groups.size} main topic${groups.size !== 1 ? 's' : ''}: ${topicNames}. It contains ${totalNotesCount} notes with detailed architecture, decisions, and operational knowledge.`;

        const graphSection = knowledgeGraph
          ? composeGraphSection(graphToEmbedInput(knowledgeGraph, 'brain'))
          : '';

        const html = composeBrainIndex({
          id: 'brain-index',
          title: 'Brain Index',
          created: now,
          leadText,
          stats: {
            totalNotes: totalNotesCount,
            totalTopics: groups.size,
            dateRange: [globalEarliest, globalLatest],
          },
          topics: topicEntries,
          tags: ['index', 'synthesis'],
          graphSection,
        });

        if (!opts.dryRun) {
          const written = writeNote(html, { overwrite: true });
          try {
            indexNote(readNote(written.path));
          } catch (err) {
            log.warn(
              { path: written.path, err: (err as Error).message },
              'synthesize: brain index reindex',
            );
          }
        }

        report.synthesized.push('__brain-index__');
        log.debug({ topics: groups.size }, 'synthesize: brain index generated');
      } catch (err) {
        const msg = (err as Error).message;
        report.errors.push(`brain-index: ${msg}`);
        log.warn({ err: msg }, 'synthesize: brain index failed');
      }
    } else {
      report.skipped.push('__brain-index__');
    }
  }

  return report;
}
