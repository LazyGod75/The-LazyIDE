/**
 * file-neuron composer: renders a single code file as a wiki-style HTML article.
 *
 * One file-neuron per code file, with in-page anchors for each function/class
 * so the wiki can deep-link to #fn-NAME and #cls-NAME.
 *
 * Reuses existing block renderers: renderInfobox, renderToc, renderSeeAlso.
 */

import type { CodeNode } from '../../../graph/code-scanner.js';
import { canonicalProjectSegment } from '../../../util/cwd-normalizer.js';
import { PKG_VERSION } from '../../../util/pkg-version.js';
import { esc } from '../helpers.js';
import { renderInfobox } from '../infobox.js';
import { renderSeeAlso } from '../see-also.js';
import { renderToc } from '../toc.js';

// ---------------------------------------------------------------------------
// Enrichment types (Task 5)
// ---------------------------------------------------------------------------

/**
 * A single knowledge item attached to a file-neuron section.
 * Produced by the conversation enrichment pipeline.
 */
export interface EnrichmentItem {
  /** Plain-text knowledge item extracted from a conversation. */
  text: string;
  /** Confidence in [0, 1]. */
  confidence: number;
  /** ISO date (YYYY-MM-DD) of the source conversation. */
  date: string;
  /** Link to the source conversation note (e.g. "#conv-abc"). */
  sourceConvLink: string;
  /**
   * When true, this item was superseded by a newer claim of the same kind.
   * Written as data-cerveau-superseded="true" on the <li>.
   */
  superseded?: boolean;
  /**
   * ISO date when this item became invalid (the newer item's date).
   * Written as data-cerveau-valid-until="DATE" on the <li>.
   */
  validUntil?: string;
  /** Author UUID (Supabase user id) — for team attribution. */
  authorId?: string;
  /** Author display name — for team attribution. */
  author?: string;
  /** Unique item id (for dedup / compose). */
  itemId?: string;
  /** The kind of this item (decision|bug|rule|idea|qa|warning|activity). */
  kind?: string;
  /** File path this item is about (e.g. "file:src/payments/stripe.ts"). */
  about?: string;
  /** Project slug. */
  project?: string;
  /** Org UUID (team brain only). */
  orgId?: string;
  /** Status: open, resolved, etc. */
  status?: string;
}

/**
 * Enrichment payload attached to a file-neuron by the conv enrichment pipeline.
 * All fields are optional — only non-empty arrays render HTML sections.
 *
 * `activities` is an honest fallback for keyword-less conversations:
 * conversations that touched the file but produced no classifiable items
 * (no decision/bug/idea/rule/qa) are recorded here rather than mislabeled.
 */
export interface FileNeuronEnrichment {
  decisions?: EnrichmentItem[];
  bugs?: EnrichmentItem[];
  ideas?: EnrichmentItem[];
  rules?: EnrichmentItem[];
  qa?: EnrichmentItem[];
  warnings?: EnrichmentItem[];
  /** Conversations that touched this file but produced no classifiable knowledge items. */
  activities?: EnrichmentItem[];
}

// ---------------------------------------------------------------------------
// Anchor ID sanitizer
// ---------------------------------------------------------------------------

/**
 * Convert a symbol name to a valid HTML id: lowercase, non-alphanumeric → hyphen.
 * Multiple consecutive hyphens are collapsed.
 */
function toAnchorId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Section renderers (private to this composer)
// ---------------------------------------------------------------------------

/**
 * Compute the note id of the aggregate-neuron for a project-relative path.
 *
 * MUST mirror aggregate-neuron.ts's buildArticleId() exactly — that function
 * is private (not exported), so the formula is duplicated here; keep the two
 * in sync if either changes. It is the only real producer of aggregate-neuron
 * ids: buildAggregateNeurons() (code-scanner.ts) assigns every module/project
 * descriptor this id via composeAggregateNeuron(), for every ancestor
 * directory of every scanned file.
 *
 * Idempotency note: the real pipeline feeds this formula scanProject()'s
 * already-lowercased/sanitized projectName, while this file only has the raw
 * (case-preserved) last path segment of node.projectRoot available. That is
 * safe: replacing every non-[a-z0-9] char with "-", collapsing repeats, and
 * lowercasing is idempotent, so applying it once to the raw name yields the
 * same id as applying it to an already-sanitized name.
 */
function aggregateNoteId(projectName: string, path: string): string {
  return `aggregate-${projectName}-${path || 'root'}`
    .replace(/[^a-z0-9]/gi, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .slice(0, 80);
}

/**
 * Render the project / module / file breadcrumb for a file-neuron.
 *
 * Each non-leaf segment links to the aggregate-neuron note for that path
 * prefix (project root, then each intermediate directory) using the bare
 * "#<id>" format — the same format the auto-linker emits and WikiPage's
 * click handler resolves via DOM-presence disambiguation.
 *
 * When `knownAggregateIds` is supplied and a segment's computed id is not a
 * member, that segment renders as plain text instead of a dead link. When
 * omitted (the default), every segment links unconditionally — correct for
 * the normal graph-build flow, where buildAggregateNeurons() guarantees an
 * aggregate note for every ancestor directory of every scanned file.
 */
function renderBreadcrumb(
  projectName: string,
  filePath: string,
  knownAggregateIds?: ReadonlySet<string>,
): string {
  const segments = [projectName, ...filePath.replace(/\\/g, '/').split('/')];
  const links = segments.slice(0, -1).map((seg, i) => {
    // Path relative to the project root for this breadcrumb level: empty for
    // the project-root level (i === 0), else the dir segments after the
    // project name — mirrors the `dir` grouping key in buildAggregateNeurons.
    const path = i === 0 ? '' : segments.slice(1, i + 1).join('/');
    const targetId = aggregateNoteId(projectName, path);
    if (knownAggregateIds && !knownAggregateIds.has(targetId)) {
      return esc(seg);
    }
    return `<a href="#${esc(targetId)}">${esc(seg)}</a>`;
  });
  const last = `<span aria-current="page">${esc(segments[segments.length - 1])}</span>`;
  const crumbs = [...links, last].join(' / ');
  return `<nav class="breadcrumb" aria-label="breadcrumb">${crumbs}</nav>`;
}

function renderTldr(node: CodeNode): string {
  const fnCount = node.astFunctions?.length ?? 0;
  const clsCount = node.astClasses?.length ?? 0;
  let text: string;
  if (fnCount > 0 || clsCount > 0) {
    const parts: string[] = [];
    if (fnCount > 0) parts.push(`${fnCount} function${fnCount !== 1 ? 's' : ''}`);
    if (clsCount > 0) parts.push(`${clsCount} class${clsCount !== 1 ? 'es' : ''}`);
    text = `${esc(node.language)} file with ${parts.join(', ')} (${node.lineCount} lines)`;
  } else {
    text = `${esc(node.language)} file — ${node.lineCount} lines, ${node.exports.length} export${node.exports.length !== 1 ? 's' : ''}`;
  }
  return `<section data-section="tldr">\n  <p>${text}</p>\n</section>`;
}

function renderArchitectureSection(node: CodeNode): string {
  const importItems =
    node.imports.length > 0
      ? node.imports
          .map((imp) => {
            // Imports that look like internal file references get a link
            const isInternal = imp.startsWith('.') || imp.startsWith('/');
            const id = isInternal ? `file:${imp}` : imp;
            return isInternal
              ? `<li><a href="#/${esc(id)}"><code>${esc(imp)}</code></a></li>`
              : `<li><code>${esc(imp)}</code></li>`;
          })
          .join('\n      ')
      : '<li><em>none</em></li>';

  const exportItems =
    node.exports.length > 0
      ? node.exports.map((e) => `<li><code>${esc(e)}</code></li>`).join('\n      ')
      : '<li><em>none detected</em></li>';

  return [
    '<section data-section="architecture">',
    '  <h3>Imports &amp; Exports</h3>',
    '  <h4>Imports</h4>',
    '  <ul>',
    `      ${importItems}`,
    '  </ul>',
    '  <h4>Exports</h4>',
    '  <ul>',
    `      ${exportItems}`,
    '  </ul>',
    '</section>',
  ].join('\n');
}

function renderJsdocAndExcerpt(jsdoc?: string, excerpt?: string): string {
  const parts: string[] = [];
  if (jsdoc?.trim()) {
    parts.push(`  <aside data-section="jsdoc"><pre><code>${esc(jsdoc.trim())}</code></pre></aside>`);
  }
  if (excerpt?.trim()) {
    parts.push(`  <pre data-section="excerpt"><code>${esc(excerpt.trim())}</code></pre>`);
  }
  return parts.join('\n');
}

function renderFunctionAnchor(fn: NonNullable<CodeNode['astFunctions']>[number]): string {
  const anchorId = `fn-${toAnchorId(fn.name)}`;
  const params = fn.params.map(esc).join(', ');
  const exportBadge = fn.isExported
    ? '<span class="export-badge" aria-label="exported">export</span> '
    : '';
  const heading = `<h3>${exportBadge}<code>${esc(fn.name)}(${params})</code></h3>`;
  const body = renderJsdocAndExcerpt(fn.jsdoc, fn.excerpt);
  // Wrapper keeps #fn-<slug> matching the WHOLE excerpt (JSDoc + body), not
  // just the heading — otherwise `lazybrain query "#fn-parsefile"` would
  // inject the signature and drop the facts the 24-q bench needs.
  return [
    `<div class="symbol" id="${anchorId}" data-cerveau-symbol="${esc(fn.name)}" data-cerveau-symbol-kind="function">`,
    `  ${heading}`,
    body,
    '</div>',
  ]
    .filter((line) => line.length > 0)
    .join('\n');
}

function renderClassAnchor(cls: NonNullable<CodeNode['astClasses']>[number]): string {
  const anchorId = `cls-${toAnchorId(cls.name)}`;
  const extendsPart = cls.extends ? ` extends ${esc(cls.extends)}` : '';
  const exportBadge = cls.isExported
    ? '<span class="export-badge" aria-label="exported">export</span> '
    : '';
  const methodList =
    cls.methods.length > 0
      ? `<ul class="method-list">${cls.methods.map((m) => `<li><code>${esc(m)}()</code></li>`).join('')}</ul>`
      : '';
  const body = renderJsdocAndExcerpt(cls.jsdoc, cls.excerpt);
  return [
    `<div class="symbol" id="${anchorId}" data-cerveau-symbol="${esc(cls.name)}" data-cerveau-symbol-kind="class">`,
    `  <h3>${exportBadge}<code>${esc(cls.name)}${extendsPart}</code></h3>`,
    methodList ? `  ${methodList}` : '',
    body,
    '</div>',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderBindingAnchor(bind: NonNullable<CodeNode['astBindings']>[number]): string {
  const anchorId = `bind-${toAnchorId(bind.name)}`;
  const exportBadge = bind.isExported
    ? '<span class="export-badge" aria-label="exported">export</span> '
    : '';
  const body = renderJsdocAndExcerpt(bind.jsdoc, bind.excerpt);
  return [
    `<div class="symbol" id="${anchorId}" data-cerveau-symbol="${esc(bind.name)}" data-cerveau-symbol-kind="${esc(bind.kind)}">`,
    `  <h3>${exportBadge}<code>${esc(bind.name)}</code></h3>`,
    body,
    '</div>',
  ]
    .filter(Boolean)
    .join('\n');
}

function renderChildrenSection(node: CodeNode): string {
  const fnAnchors = (node.astFunctions ?? []).map(renderFunctionAnchor);
  const clsAnchors = (node.astClasses ?? []).map(renderClassAnchor);
  const bindAnchors = (node.astBindings ?? []).map(renderBindingAnchor);
  const all = [...clsAnchors, ...fnAnchors, ...bindAnchors];
  if (all.length === 0) return '';

  return [
    '<section data-section="children">',
    '  <h3>Symbols</h3>',
    ...all.map((a) => `  ${a}`),
    '</section>',
  ].join('\n');
}

function buildTocEntries(
  node: CodeNode,
  enrichment?: FileNeuronEnrichment,
  hasSeeAlso?: boolean,
): Array<{ level: number; id: string; text: string }> {
  const entries: Array<{ level: number; id: string; text: string }> = [
    { level: 1, id: 'architecture', text: 'Imports & Exports' },
  ];

  const hasSymbols = (node.astFunctions?.length ?? 0) > 0 || (node.astClasses?.length ?? 0) > 0;
  if (hasSymbols) {
    entries.push({ level: 1, id: 'children', text: 'Symbols' });
    for (const cls of node.astClasses ?? []) {
      entries.push({ level: 2, id: `cls-${toAnchorId(cls.name)}`, text: cls.name });
    }
    for (const fn of node.astFunctions ?? []) {
      entries.push({ level: 2, id: `fn-${toAnchorId(fn.name)}`, text: fn.name });
    }
    for (const bind of node.astBindings ?? []) {
      entries.push({ level: 2, id: `bind-${toAnchorId(bind.name)}`, text: bind.name });
    }
  }

  // Enrichment sections — only add TOC entry when the array is non-empty
  if (enrichment) {
    if ((enrichment.decisions?.length ?? 0) > 0)
      entries.push({ level: 1, id: 'decisions', text: 'Decisions' });
    if ((enrichment.bugs?.length ?? 0) > 0) entries.push({ level: 1, id: 'bugs', text: 'Bugs' });
    if ((enrichment.ideas?.length ?? 0) > 0) entries.push({ level: 1, id: 'ideas', text: 'Ideas' });
    if ((enrichment.rules?.length ?? 0) > 0) entries.push({ level: 1, id: 'rules', text: 'Rules' });
    if ((enrichment.qa?.length ?? 0) > 0) entries.push({ level: 1, id: 'qa', text: 'Q & A' });
    if ((enrichment.warnings?.length ?? 0) > 0)
      entries.push({ level: 1, id: 'warnings', text: 'Warnings' });
    if ((enrichment.activities?.length ?? 0) > 0)
      entries.push({ level: 1, id: 'activity', text: 'Referenced in Conversations' });
  }

  // Only add see-also TOC entry when there are real links to show
  if (hasSeeAlso) {
    entries.push({ level: 1, id: 'see-also', text: 'See also' });
  }

  return entries;
}

// ---------------------------------------------------------------------------
// Enrichment section renderer (Task 5)
// ---------------------------------------------------------------------------

/**
 * Remove wiki-link markup that leaks into enrichment item text when the source
 * conversation note was processed by the wikilinks annotator before enrichment.
 *
 * Three patterns are cleaned:
 *
 * 1. Complete wiki-link: `[Label→#target]` or `[Label→#/route/...]`
 *    Replaced with just `Label` — the human-readable label is preserved, the
 *    arrow + anchor target are dropped because the item text is plain prose.
 *
 * 2. Dangling/truncated opening bracket: `[word/path...` with no closing `]`
 *    (produced when a file path was partially linkified before the string was
 *    cut off). The `[` is stripped so the raw text token remains readable.
 *    A trailing ` in` connector left by the removal is also trimmed.
 *
 * 3. Orphan `word→#anchor]` fragment with no opening `[` — produced when
 *    the opening bracket was lost upstream (e.g. `[config.` was truncated,
 *    leaving `ts→#file-acme-src-config-ts]: all secrets...`).
 *    The whole token up to and including the `]` is removed so surrounding
 *    prose is left clean.
 *
 * The real `[source]` hyperlink is added as a separate `<a>` element by the
 * caller — this function must NOT touch that element.
 */
export function normalizeItemText(text: string): string {
  // Pass 1: replace complete wiki-links `[Label→#...]` with `Label`.
  // The arrow character is U+2192 (→). The target starts with `#`.
  // Label may contain any chars except `→` and `]`.
  const withoutComplete = text.replace(/\[([^\]→]+)→#[^\]]*\]/g, '$1');

  // Pass 2: remove dangling `[` that starts a wiki-link fragment but has no
  // closing `]`. Only the opening bracket is removed — the content after it
  // is preserved as-is (so `[src/auth/session` becomes `src/auth/session`).
  // After removing the bracket, trim a trailing ` in` connector if it is the
  // very last token before end-of-string (artifact of a mid-sentence link that
  // was partially cut, e.g. "...session management [code→#...] in [src/...").
  const withoutDangling = withoutComplete
    .replace(/\[(?=[^\]]*$)/g, '')
    .replace(/\s+in\s*$/i, '')
    .trimEnd();

  // Pass 3: remove orphan `word→#anchor]` fragments that have no matching
  // opening `[` — produced when the opening bracket was lost upstream
  // (e.g. `[config.` was truncated, leaving `ts→#file-acme-src-config-ts]:`).
  // Pattern: non-whitespace/non-bracket token, then `→#`, then non-bracket
  // chars up to the closing `]`.  Surrounding whitespace is collapsed.
  const withoutOrphan = withoutDangling.replace(/\S*→#[^\]\s]*\]\s*/g, '').trimEnd();

  return withoutOrphan;
}

/**
 * Render a single enrichment item as an <li> element.
 * Superseded items carry data-cerveau-valid-until and data-cerveau-superseded.
 *
 * Item text is passed through normalizeItemText before HTML-escaping to strip
 * any wiki-link markup (`[Label→#target]`) or dangling `[fragment` artifacts
 * that may have been introduced by the wikilinks annotator.
 */
function renderEnrichmentItem(item: EnrichmentItem): string {
  const supersededAttrs = item.superseded
    ? ` data-cerveau-superseded="true" data-cerveau-valid-until="${esc(item.validUntil ?? '')}"`
    : '';
  const authorAttrs = [
    item.authorId ? ` data-cerveau-author-id="${esc(item.authorId)}"` : '',
    item.author ? ` data-cerveau-author="${esc(item.author)}"` : '',
    item.kind ? ` data-cerveau-kind="${esc(item.kind)}"` : '',
    item.itemId ? ` data-cerveau-item-id="${esc(item.itemId)}"` : '',
    item.about ? ` data-cerveau-about="${esc(item.about)}"` : '',
    item.project ? ` data-cerveau-project="${esc(item.project)}"` : '',
  ].join('');
  const link = item.sourceConvLink
    ? ` <a href="${esc(item.sourceConvLink)}" class="conv-source">[source]</a>`
    : '';
  const cleanText = normalizeItemText(item.text);
  return `<li${supersededAttrs}${authorAttrs} data-cerveau-confidence="${item.confidence}" data-cerveau-date="${esc(item.date)}">${esc(cleanText)}${link}</li>`;
}

/**
 * Render a single conditional enrichment section (decisions, bugs, ideas…).
 * Returns empty string when the items array is empty.
 */
function renderEnrichmentSection(
  sectionId: string,
  heading: string,
  items: EnrichmentItem[] | undefined,
): string {
  if (!items || items.length === 0) return '';
  const listItems = items.map(renderEnrichmentItem).join('\n    ');
  return [
    `<section data-section="${sectionId}">`,
    `  <h3>${heading}</h3>`,
    '  <ul>',
    `    ${listItems}`,
    '  </ul>',
    '</section>',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Safe article id
// ---------------------------------------------------------------------------

function buildArticleId(projectName: string, filePath: string): string {
  const sanitized = `${projectName}-${filePath}`
    .replace(/[^a-z0-9]/gi, '-')
    .replace(/-+/g, '-')
    .toLowerCase()
    .slice(0, 80);
  return `file-${sanitized}`;
}

/**
 * Compute the persisted note id (slug) for a file-neuron from its CodeNode —
 * the SAME id composeFileNeuron assigns to the rendered `<article>` below.
 *
 * Exported so callers that need to look up an already-written file-neuron
 * note by id (e.g. conv-file-enrichment.ts's resolveExistingFileNeuronMeta)
 * use this same persisted-id namespace, instead of the CodeNode's internal
 * graph id (`node.id`, shaped `file:<relPath>`) — a different namespace that
 * never matches a row in the notes index and would silently look up nothing.
 */
export function fileNeuronArticleId(node: Pick<CodeNode, 'projectRoot' | 'filePath'>): string {
  const projectName =
    node.projectRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'project';
  return buildArticleId(projectName, node.filePath);
}

// ---------------------------------------------------------------------------
// Main composer
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Importance formula for file-neurons
// ---------------------------------------------------------------------------

/**
 * Derive an importance score for a file-neuron from its structural signals.
 *
 * Formula:
 *   importance = clamp(BASE + INBOUND_BONUS * min(inbound, INBOUND_CAP) / INBOUND_CAP
 *                      + EXPORT_BONUS * min(exports, EXPORT_CAP) / EXPORT_CAP, 0, 1)
 *
 *   BASE        = 0.55  — slightly above the FTS default of 0.5 so file-neurons
 *                         are not systematically under-ranked vs un-annotated notes.
 *   INBOUND_BONUS = 0.35 — a hub file imported by many peers is highly relevant;
 *                          reward up to +0.35 for high fan-in.
 *   INBOUND_CAP  = 20   — normalisation ceiling: 20+ inbound edges → full bonus.
 *   EXPORT_BONUS = 0.10 — large public API surface is a secondary hub signal.
 *   EXPORT_CAP   = 10   — normalisation ceiling for exports.
 *
 * Result is in [0.55, 1.0] for any file and monotonically increases with inbound count.
 */
const IMPORTANCE_BASE = 0.55;
const INBOUND_BONUS = 0.35;
const INBOUND_CAP = 20;
const EXPORT_BONUS = 0.1;
const EXPORT_CAP = 10;

// ---------------------------------------------------------------------------
// Adaptive composition: table of contents
// ---------------------------------------------------------------------------

/**
 * Minimum number of TOC entries required before the table of contents is
 * rendered at all (see composeFileNeuron). buildTocEntries() always emits
 * one entry for "architecture"; a file with no symbols, no enrichment, and
 * no see-also links produces exactly that one entry. Small/trivial files
 * commonly land at 1-4 entries (architecture + children + 1-2 symbols) —
 * a jump-list for a 1-4-item page a reader can scroll in one screen adds
 * cost without adding navigation value. Measured (bench/token-economy
 * token-economy-measurement.mjs, 25-file size-stratified sample of this
 * repo's own source): omitting the TOC below this threshold cuts small-file
 * neuron cost by roughly a third with zero effect on files that actually
 * need a jump-list.
 */
const TOC_MIN_ENTRIES_TO_RENDER = 4;

function computeFileNeuronImportance(inbound: number, exportCount: number): number {
  const inboundFraction = Math.min(inbound, INBOUND_CAP) / INBOUND_CAP;
  const exportFraction = Math.min(exportCount, EXPORT_CAP) / EXPORT_CAP;
  const raw = IMPORTANCE_BASE + INBOUND_BONUS * inboundFraction + EXPORT_BONUS * exportFraction;
  return Math.min(1, Math.max(0, raw));
}

/**
 * A single see-also link for a file-neuron.
 * Derived from real graph edges (imports / imported-by) or shared topic prefix.
 */
export interface FileNeuronSeeAlsoLink {
  /** Note id of the related neuron. */
  id: string;
  /** Display title of the related neuron. */
  title: string;
}

/**
 * Compose a complete <article data-cerveau-type="file-neuron"> HTML string.
 *
 * Always included:
 * - breadcrumb (project / dir / file)
 * - infobox (language, line count, inbound, exports)
 * - tldr (from AST counts or fallback text)
 * - architecture (imports + exports, linked where internal)
 * - children (function/class anchors for deep-linking)
 * - toc (links to sections and symbol anchors)
 *
 * Conditional conversation sections (decisions/bugs/ideas/rules/qa) are
 * rendered from the optional `enrichment` argument — only when non-empty.
 * They are placed after the code/structure sections.
 *
 * See-also links are derived from real graph edges (imports/imported-by) and
 * shared topic-path prefix siblings, NOT from cluster membership. Pass them
 * via the `seeAlso` argument. When empty (the default), the see-also section
 * is omitted from the rendered page.
 *
 * @param node               The CodeNode representing the file.
 * @param inbound            Number of files that import this file (default 0).
 * @param enrichment         Optional enrichment payload from the conv pipeline.
 * @param seeAlso            Optional see-also links from real graph edges / topic siblings.
 * @param knownAggregateIds  Optional set of real aggregate-neuron ids. When
 *                           supplied, breadcrumb segments whose computed id is
 *                           not a member render as plain text instead of a
 *                           dead link — see renderBreadcrumb().
 */
export function composeFileNeuron(
  node: CodeNode,
  inbound = 0,
  enrichment?: FileNeuronEnrichment,
  seeAlso?: FileNeuronSeeAlsoLink[],
  knownAggregateIds?: ReadonlySet<string>,
): string {
  const now = new Date().toISOString().slice(0, 10);
  // Preserve the original directory name for human-readable display (breadcrumb, title).
  const projectName =
    node.projectRoot.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? 'project';
  // Canonical topic key: always lowercase so code notes and conversation notes
  // share the same first topic segment regardless of on-disk casing.
  const canonicalProject = canonicalProjectSegment(projectName);

  const articleId = fileNeuronArticleId(node);

  // Importance derived from fan-in (inbound) and export count so that hub
  // files rank competitively against conversation notes (which carry 0.7-0.9).
  const importance = computeFileNeuronImportance(inbound, node.exports.length);

  const infobox = renderInfobox({
    rows: [
      { label: 'Language', value: node.language },
      { label: 'Lines', value: String(node.lineCount) },
      { label: 'Inbound', value: String(inbound) },
      { label: 'Exports', value: String(node.exports.length) },
    ],
  });

  // See-also: use real links passed by the caller (derived from graph edges /
  // topic siblings). Fall back to empty — better to omit than to cross-link
  // unrelated projects via a degenerate cluster bucket.
  const seeAlsoLinks = seeAlso ?? [];
  const seeAlsoSection = renderSeeAlso({
    links: seeAlsoLinks.map((l) => ({ id: l.id, title: l.title })),
  });

  // Adaptive TOC: only render the table of contents when it has enough
  // entries to earn its keep. renderToc()'s fixed <nav>/<h2>/<ol> wrapper
  // plus one <li> (tocnumber + toctext spans) per entry costs ~35-45
  // estimated tokens of markup on top of whatever it links to — for a
  // trivial file (1 architecture entry + 1-2 symbols) that wrapper is pure
  // overhead: the exact same headings are already present, in the same
  // document, one scroll away (see renderArchitectureSection /
  // renderChildrenSection below). TOC_MIN_ENTRIES_TO_RENDER is the point
  // where a jump-list starts earning its cost back — below it, omitting the
  // TOC materially shrinks small file-neurons without touching anything a
  // retrieval consumer depends on: no `data-cerveau-*`/`data-section`
  // attribute lives on the TOC (verified: it is not referenced by
  // structural.ts, strip.ts, file-neuron-parse.ts, or recompose.ts — those
  // all key off data-section="tldr"/"architecture"/"children"/"see-also"
  // and aside.infobox, none of which this touches), and the Brain wiki view
  // degrades gracefully to "no jump-list on a short page", not to broken
  // navigation.
  const tocEntries = buildTocEntries(node, enrichment, seeAlsoLinks.length > 0);
  const toc = tocEntries.length > TOC_MIN_ENTRIES_TO_RENDER ? renderToc({ entries: tocEntries }) : '';

  // Callers linked by inbound edges — if inbound > 0 but no caller list is
  // available on the node itself, render a minimal "used by N files" note.
  // Full caller resolution is left to the enrichment task.
  const usedBy =
    inbound > 0
      ? `<section data-section="used-by">\n  <h3>Used by</h3>\n  <p>Imported by ${inbound} file${inbound !== 1 ? 's' : ''}.</p>\n</section>`
      : '';

  // Conditional enrichment sections — only rendered when non-empty
  const decisionsSection = renderEnrichmentSection('decisions', 'Decisions', enrichment?.decisions);
  const bugsSection = renderEnrichmentSection('bugs', 'Bugs', enrichment?.bugs);
  const ideasSection = renderEnrichmentSection('ideas', 'Ideas', enrichment?.ideas);
  const rulesSection = renderEnrichmentSection('rules', 'Rules', enrichment?.rules);
  const qaSection = renderEnrichmentSection('qa', 'Q & A', enrichment?.qa);
  const warningsSection = renderEnrichmentSection('warnings', 'Warnings', enrichment?.warnings);
  // Activity section: honest fallback for keyword-less conversations.
  // Rendered with a low-key heading so it is visually distinct from decisions/bugs.
  const activitySection = renderEnrichmentSection(
    'activity',
    'Touched in Conversations',
    enrichment?.activities,
  );

  const parts: string[] = [
    '<article',
    `  id="${esc(articleId)}"`,
    `  data-cerveau-version="${PKG_VERSION}"`,
    `  data-cerveau-type="file-neuron"`,
    `  data-cerveau-created="${now}T00:00:00Z"`,
    `  data-cerveau-source="code-scanner:${esc(node.projectRoot)}"`,
    `  data-cerveau-tags="code ${esc(node.language)} ${esc(projectName)} file-neuron"`,
    `  data-cerveau-topic="${esc(canonicalProject)}/code/${esc(node.language)}"`,
    `  data-cerveau-project="${esc(canonicalProject)}"`,
    `  data-cerveau-importance="${importance.toFixed(4)}"`,
    `  data-code-file="${esc(node.filePath)}"`,
    `  data-code-project="code-${esc(projectName)}"`,
    `  data-code-language="${esc(node.language)}"`,
    `  data-code-lines="${node.lineCount}"`,
    `  data-code-inbound="${inbound}"`,
    `  data-code-exports="${node.exports.length}"`,
    '>',
    renderBreadcrumb(projectName, node.filePath, knownAggregateIds),
    `<h1>${esc(node.filePath)}</h1>`,
    infobox,
    renderTldr(node),
    toc,
    renderArchitectureSection(node),
    renderChildrenSection(node),
    usedBy,
    // Enrichment sections placed after code/structure, before see-also
    decisionsSection,
    bugsSection,
    ideasSection,
    rulesSection,
    qaSection,
    warningsSection,
    // Activity section is last among enrichment: least important, most honest
    activitySection,
    seeAlsoSection,
    '</article>',
  ];

  return parts.filter((p) => p.trim().length > 0).join('\n');
}
