/**
 * Wikipedia-style HTML template for brain notes — REFONTE 22-axes.
 *
 * Emits a fully structured <article> with:
 * - <head> enrichi: <meta name="answers">, <meta name="aliases">, <meta name="commit-ref">
 * - Header + infobox (dl of metadata)
 * - Glossary aside (<dl>/<dt>/<dd>) when ≥ 2 entities detected
 * - Q/A section auto-détectée des facts "why"/"how"
 * - Summary section (first fact, wrapped in <details open>)
 * - Facts section (remaining facts, each wrapped in <details>)
 * - Error patterns: <details data-error> pour kind="error"
 * - Outcomes & counterfactuals (asides role="doc-note"/"doc-warning")
 * - References section (file/tool citations)
 * - Footer with category nav
 *
 * All data-cerveau-* attrs remain on <article> so existing retrieval is unchanged.
 */

import { PKG_VERSION } from '../util/pkg-version.js';
import { renderAntipatterns } from './blocks/antipatterns.js';
import { renderCategories } from './blocks/categories.js';
import { renderCounterfactuals } from './blocks/counterfactuals.js';
import { renderErrors } from './blocks/errors.js';
import { renderFactsSection } from './blocks/facts-section.js';
import { renderGlossary } from './blocks/glossary.js';
import { addDays, esc } from './blocks/helpers.js';
import { renderMetaHead } from './blocks/meta-head.js';
import { renderOutcome } from './blocks/outcome.js';
import { extractQaPatterns, renderQaSection } from './blocks/qa-section.js';
import { renderReferences } from './blocks/references.js';
import { renderToolTrace } from './blocks/tool-trace.js';

export interface WikipediaTemplateInput {
  id: string;
  title: string;
  type: string;
  created: string;
  source: string;
  tier: 'working' | 'archival';
  importance: number;
  tags: string[];
  facts: Array<{ text: string; confidence: number; kind: string; extractor?: string }>;
  relations?: {
    replaces?: string[];
    causes?: string[];
    triples?: string[];
    entities?: string[];
  };
  toolMeta?: {
    tool?: string;
    cwd?: string;
    filesModified?: string[];
    filesRead?: string[];
  };
  saliencyKind?: string | null;
  /** Validity duration in days (e.g. 30). When set, emits <time datetime="P30D"> */
  validForDays?: number | null;
  /** Mean confidence of facts for <meter> rendering */
  meanConfidence?: number | null;
  /** Git commit hash for commit-ref meta */
  commitRef?: string | null;
  /** Aliases for searchability */
  aliases?: string[];
  /** Backlink count for saliency ranking */
  backlinkCount?: number | null;
  /** TLDR: 1-sentence summary for efficient injection */
  tldr?: string;
  /** Topic hierarchy (e.g., "myproject/auth/oauth") for navigation */
  topic?: string;
  /** Provenance: producing agent ("claude-code" | "vibe"). */
  agent?: string;
  /** Provenance: transcript | subagent | plan | history | compaction-summary. */
  sourceKind?: string;
  /** Compaction lineage parent session id. */
  sessionParent?: string;
  /** Git branch at session start (commit hash rides the existing commitRef). */
  gitBranch?: string;
}

/**
 * Emit the Wikipedia-style article HTML.
 * data-cerveau-* attrs are on <article> AND mirrored in the infobox <dl>
 * so the LLM sees them both ways.
 */
export function emitWikipediaNote(input: WikipediaTemplateInput): string {
  const {
    id,
    title,
    type,
    created,
    source,
    tier,
    importance,
    tags,
    facts,
    relations,
    toolMeta,
    saliencyKind,
    validForDays,
    meanConfidence,
    commitRef,
    aliases,
    backlinkCount,
    tldr,
    topic,
    agent,
    sourceKind,
    sessionParent,
    gitBranch,
  } = input;

  const tagsAttr = esc(tags.join(' '));
  const dateShort = created.slice(0, 10);

  // Extract Q/A patterns from facts (new axis 1)
  const qaFacts = extractQaPatterns(facts);

  // --- Article opening tag with all data-cerveau-* attrs ---
  const relAttrs = buildRelationAttrs(relations);
  const toolAttrs = buildToolAttrs(toolMeta);
  const saliencyAttr = saliencyKind
    ? `\n         data-cerveau-saliency-kind="${esc(saliencyKind)}"`
    : '';
  const topicAttr = topic ? `\n         data-cerveau-topic="${esc(topic)}"` : '';
  // ARIA: aria-current="page" when note replaces others AND is not yet expired
  const ariaCurrentAttr =
    (relations?.replaces?.length ?? 0) > 0 && !validForDays ? `\n         aria-current="page"` : '';
  // Add article-level confidence and validity window
  const confidenceAttr =
    meanConfidence != null && meanConfidence > 0
      ? `\n         data-cerveau-confidence="${meanConfidence.toFixed(2)}"`
      : '';
  const validFromAttr = `\n         data-cerveau-valid-from="${esc(created)}"`;
  const validUntilAttr = validForDays
    ? `\n         data-cerveau-valid-until="${esc(addDays(created, validForDays))}"`
    : '';
  // Add CSS class for note type
  const typeClass = `type-${type.toLowerCase().replace(/\s+/g, '-')}`;
  const articleOpen = [
    `<article id="${esc(id)}"`,
    `         class="${typeClass}"`,
    `         data-cerveau-version="${PKG_VERSION}"`,
    `         data-cerveau-created="${esc(created)}"`,
    `         data-cerveau-type="${esc(type)}"`,
    `         data-cerveau-source="${esc(source)}"`,
    `         data-cerveau-tier="${tier}"`,
    `         data-cerveau-importance="${importance.toFixed(2)}"`,
    `         data-cerveau-tags="${tagsAttr}"${saliencyAttr}${topicAttr}${ariaCurrentAttr}${confidenceAttr}${validFromAttr}${validUntilAttr}`,
    ...relAttrs,
    ...toolAttrs,
    ...buildProvenanceAttrs({ agent, sourceKind, sessionParent, commitRef, gitBranch }),
    '>',
  ].join('\n');

  // --- Header + infobox ---
  // renderInfobox escapes values so cannot be used here (rows contain raw HTML like <a>, <meter>).
  // Keep inline to preserve the exact HTML output.
  const infoboxRows = buildInfoboxRows(
    type,
    tags,
    source,
    relations,
    toolMeta,
    meanConfidence,
    validForDays,
  );
  const header = [
    '  <header>',
    `    <h2><time datetime="${esc(created)}">${esc(dateShort)}</time> ${esc(title)}</h2>`,
    `    <aside class="infobox">`,
    '      <dl>',
    ...infoboxRows.map((r) => `        ${r}`),
    '      </dl>',
    '    </aside>',
    '  </header>',
  ].join('\n');

  // --- Glossary aside: shown when ≥ 2 entities detected ---
  const glossaryAside = renderGlossary({ entities: relations?.entities ?? [] });

  // --- Facts sections: tldr + summary + remaining facts ---
  const factsHtml = renderFactsSection({ facts, tldr });

  // --- References section ---
  const refSection = renderReferences({
    filesModified: toolMeta?.filesModified,
    filesRead: toolMeta?.filesRead,
  });

  // --- Footer with category nav ---
  const footer = renderCategories({ tags: [type, ...tags] });

  // --- JSON-LD structured data for SEO/schema ---
  // Cannot use renderJsonLd: it uses title as @id and lacks about/supersedes fields.
  // Keep inline to preserve exact output.
  const jsonLdData: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    '@id': `memory://${esc(id)}`,
    name: title,
    dateCreated: created,
    keywords: tags.join(','),
  };
  if ((relations?.entities?.length ?? 0) > 0) {
    jsonLdData.about = relations!.entities!.map((e) => ({ '@id': `memory://${esc(e)}` }));
  }
  if ((relations?.replaces?.length ?? 0) > 0) {
    jsonLdData.supersedes = relations!.replaces!.map((r) => ({ '@id': `memory://${esc(r)}` }));
  }
  const jsonLd = `  <script type="application/ld+json">\n${JSON.stringify(jsonLdData, null, 2)
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')}\n  </script>`;

  // --- Meta head enriched (new axes) ---
  const answersContent = extractAnswers(facts).join('; ');
  const aliasesContent = (aliases ?? []).join(',');
  const metaHead = renderMetaHead({
    answers: answersContent,
    aliases: aliasesContent,
    commitRef,
    backlinkCount,
  });

  // --- Q/A section (new axis) ---
  const qaSection = renderQaSection({
    pairs: qaFacts.map(([question, answer]) => ({ question, answer })),
  });

  // --- Error patterns section (new axis) ---
  const errorSection = renderErrors({ facts });

  // --- Outcomes & counterfactuals (new axes) ---
  const outcomeSection = renderOutcome({ replaces: relations?.replaces });
  const counterfactualSection = renderCounterfactuals({ facts });
  const antiPatternSection = renderAntipatterns({ facts });
  const toolTraceSection = renderToolTrace({ facts, tool: toolMeta?.tool });

  // <meta charset> MUST be the first head element: notes are written as
  // standalone .html files (store/writer.ts) with no <!DOCTYPE>/<head>
  // wrapper, so a browser opening one directly relies on this tag (within
  // the first 1024 bytes) to detect UTF-8 — without it accented characters
  // can render as mojibake even though the file on disk is clean UTF-8.
  const charsetMeta = '<meta charset="utf-8">';

  const parts = [
    charsetMeta,
    metaHead,
    articleOpen,
    header,
    glossaryAside,
    qaSection,
    factsHtml,
    toolTraceSection,
    errorSection,
    outcomeSection,
    counterfactualSection,
    antiPatternSection,
    refSection,
    footer,
    jsonLd,
    '</article>',
  ];
  return parts.filter(Boolean).join('\n');
}

function buildRelationAttrs(relations?: WikipediaTemplateInput['relations']): string[] {
  if (!relations) return [];
  const attrs: string[] = [];
  if (relations.replaces?.length) {
    attrs.push(`         data-cerveau-replaces="${esc(relations.replaces.join(','))}"`);
  }
  if (relations.causes?.length) {
    attrs.push(`         data-cerveau-causes="${esc(relations.causes.join('|'))}"`);
  }
  if (relations.triples?.length) {
    attrs.push(`         data-cerveau-triples="${esc(relations.triples.join(';'))}"`);
  }
  if (relations.entities?.length) {
    attrs.push(`         data-cerveau-entities="${esc(relations.entities.join(','))}"`);
  }
  return attrs;
}

function buildProvenanceAttrs(input: {
  agent?: string;
  sourceKind?: string;
  sessionParent?: string;
  commitRef?: string | null;
  gitBranch?: string;
}): string[] {
  const attrs: string[] = [];
  if (input.agent) attrs.push(`         data-cerveau-agent="${esc(input.agent)}"`);
  if (input.sourceKind) {
    attrs.push(`         data-cerveau-source-kind="${esc(input.sourceKind)}"`);
  }
  if (input.sessionParent) {
    attrs.push(`         data-cerveau-session-parent="${esc(input.sessionParent)}"`);
  }
  if (input.commitRef) {
    attrs.push(`         data-cerveau-git-commit="${esc(input.commitRef)}"`);
  }
  if (input.gitBranch) {
    attrs.push(`         data-cerveau-git-branch="${esc(input.gitBranch)}"`);
  }
  return attrs;
}

function buildToolAttrs(toolMeta?: WikipediaTemplateInput['toolMeta']): string[] {
  if (!toolMeta) return [];
  const attrs: string[] = [];
  if (toolMeta.cwd) attrs.push(`         data-cerveau-cwd="${esc(toolMeta.cwd)}"`);
  if (toolMeta.tool) attrs.push(`         data-cerveau-tool="${esc(toolMeta.tool)}"`);
  if (toolMeta.filesModified?.length) {
    attrs.push(`         data-cerveau-files-modified="${esc(toolMeta.filesModified.join(','))}"`);
  }
  if (toolMeta.filesRead?.length) {
    attrs.push(`         data-cerveau-files-read="${esc(toolMeta.filesRead.join(','))}"`);
  }
  return attrs;
}

function buildInfoboxRows(
  type: string,
  tags: string[],
  source: string,
  relations?: WikipediaTemplateInput['relations'],
  toolMeta?: WikipediaTemplateInput['toolMeta'],
  meanConfidence?: number | null,
  validForDays?: number | null,
): string[] {
  const rows: string[] = [];
  rows.push(`<dt>Type</dt><dd>${esc(type)}</dd>`);
  rows.push('<dt>Status</dt><dd>active</dd>');
  if (tags.length > 0) rows.push(`<dt>Tags</dt><dd>${esc(tags.join(', '))}</dd>`);
  rows.push(`<dt>Source</dt><dd>${esc(source)}</dd>`);

  if (relations?.replaces?.length) {
    // rel="prev" — this note supersedes the previous version (IANA link relation)
    const links = relations.replaces
      .map(
        (r) =>
          `<a href="#/note/${encodeURIComponent(r)}" rel="prev" data-cerveau-link-type="replaces">${esc(r)}</a>`,
      )
      .join(', ');
    rows.push(`<dt>Replaces</dt><dd>${links}</dd>`);
  }

  if (toolMeta?.tool) {
    rows.push(`<dt>Tool</dt><dd>${esc(toolMeta.tool)}</dd>`);
  }

  // MDN Phase 4C: <meter> for confidence, <time> for validity duration
  if (meanConfidence != null && meanConfidence > 0) {
    const conf = meanConfidence.toFixed(2);
    rows.push(
      `<dt>Confidence</dt><dd><meter value="${conf}" min="0" max="1" optimum="1">${conf}</meter></dd>`,
    );
  }
  if (validForDays != null && validForDays > 0) {
    rows.push(
      `<dt>Valid for</dt><dd><time datetime="P${validForDays}D">${validForDays} days</time></dd>`,
    );
  }

  return rows;
}

/**
 * Extract questions answered by facts (heuristic: fact is answer if it follows Q word)
 */
function extractAnswers(
  facts: Array<{ text: string; confidence: number; kind: string }>,
): string[] {
  const answers: string[] = [];
  for (const f of facts) {
    const qMatch = f.text.match(/^(?:why|how|what|when|where)\s+([^?]+)/i);
    if (qMatch) {
      answers.push(qMatch[1].trim());
    }
  }
  return answers;
}
