/**
 * Shared helpers for reconstructing a CodeNode from a stored file-neuron HTML article.
 *
 * These were extracted from commands/enrich.ts (Task 6.1) so that the injection
 * pipeline can reuse the same parsing logic without duplication.
 *
 * All functions are pure / deterministic — no I/O.
 */

import type {
  EnrichmentItem,
  FileNeuronSeeAlsoLink,
} from '../annotator/blocks/composers/file-neuron.js';
import type { NoteFile } from '../store/reader.js';
import type { CodeNode } from './code-scanner.js';

// ---------------------------------------------------------------------------
// Section parsers
// ---------------------------------------------------------------------------

/**
 * Parse imports from the architecture section of a file-neuron HTML article.
 *
 * The architecture section renders each import as:
 *   <li><a href="#/file:IMPORT"><code>IMPORT</code></a></li>   (internal)
 *   <li><code>IMPORT</code></li>                               (external)
 *
 * We extract the text content of every <code> inside the architecture section's
 * Imports subsection (between <h4>Imports</h4> and <h4>Exports</h4>).
 */
export function parseImportsFromHtml(html: string): string[] {
  const archMatch = html.match(/<section\s+data-section="architecture">([\s\S]*?)<\/section>/i);
  if (!archMatch) return [];
  const archHtml = archMatch[1];

  const importsMatch = archHtml.match(/<h4>Imports<\/h4>([\s\S]*?)(?:<h4>Exports<\/h4>|$)/i);
  if (!importsMatch) return [];
  const importsHtml = importsMatch[1];

  const imports: string[] = [];
  const codeRe = /<code>([^<]+)<\/code>/g;
  for (let m = codeRe.exec(importsHtml); m !== null; m = codeRe.exec(importsHtml)) {
    const val = m[1].trim();
    if (val && val !== 'none') imports.push(val);
  }
  return imports;
}

/**
 * Parse exports from the architecture section of a file-neuron HTML article.
 *
 * The architecture section renders each export as:
 *   <li><code>EXPORT_NAME</code></li>
 * after the <h4>Exports</h4> heading.
 */
export function parseExportsFromHtml(html: string): string[] {
  const archMatch = html.match(/<section\s+data-section="architecture">([\s\S]*?)<\/section>/i);
  if (!archMatch) return [];
  const archHtml = archMatch[1];

  const exportsMatch = archHtml.match(/<h4>Exports<\/h4>([\s\S]*)$/i);
  if (!exportsMatch) return [];
  const exportsHtml = exportsMatch[1];

  const exports: string[] = [];
  const codeRe2 = /<code>([^<]+)<\/code>/g;
  for (let m = codeRe2.exec(exportsHtml); m !== null; m = codeRe2.exec(exportsHtml)) {
    const val = m[1].trim();
    if (val && val !== 'none detected') exports.push(val);
  }
  return exports;
}

/**
 * Parse AST functions from the children section of a file-neuron HTML article.
 *
 * The children section renders each function as:
 *   <h3 id="fn-NAME">...<code>NAME(params)</code></h3>
 *
 * We reconstruct minimal astFunctions entries (name, isExported from export-badge,
 * params parsed from the code text, startLine/endLine set to 0 since not stored).
 */
export function parseAstFunctionsFromHtml(html: string): NonNullable<CodeNode['astFunctions']> {
  const childrenMatch = html.match(/<section\s+data-section="children">([\s\S]*?)<\/section>/i);
  if (!childrenMatch) return [];
  const childrenHtml = childrenMatch[1];

  const fns: NonNullable<CodeNode['astFunctions']> = [];
  // Accept both the historical `<h3 id="fn-NAME">` heading and the
  // excerpt-era `<div class="symbol" id="fn-NAME">…<h3>…</h3>` wrapper.
  const fnRe = /<(?:h3|div)[^>]*\sid="fn-([^"]+)"[^>]*>([\s\S]*?)<\/(?:h3|div)>/gi;
  for (let m = fnRe.exec(childrenHtml); m !== null; m = fnRe.exec(childrenHtml)) {
    const headingContent = m[2];
    const isExported = headingContent.includes('class="export-badge"');
    const codeMatch = headingContent.match(/<code>([^(]+)\(([^)]*)\)<\/code>/);
    if (!codeMatch) continue;
    const name = codeMatch[1].trim();
    const rawParams = codeMatch[2].trim();
    const params = rawParams
      ? rawParams
          .split(',')
          .map((p) => p.trim())
          .filter(Boolean)
      : [];
    fns.push({ name, startLine: 0, endLine: 0, params, isExported });
  }
  return fns;
}

/**
 * Parse AST classes from the children section of a file-neuron HTML article.
 *
 * The children section renders each class as:
 *   <h3 id="cls-NAME">...<code>NAME[extends BASE]</code></h3>
 *   <ul class="method-list"><li><code>METHOD()</code></li>...</ul>
 */
export function parseAstClassesFromHtml(html: string): NonNullable<CodeNode['astClasses']> {
  const childrenMatch = html.match(/<section\s+data-section="children">([\s\S]*?)<\/section>/i);
  if (!childrenMatch) return [];
  const childrenHtml = childrenMatch[1];

  const classes: NonNullable<CodeNode['astClasses']> = [];
  // Legacy: <h3 id="cls-X">…</h3> optionally followed by <ul class="method-list">.
  // Current: <div class="symbol" id="cls-X">…heading + method-list…</div>.
  // Do NOT use a single (h3|div)…</(h3|div)> regex — the non-greedy body would
  // stop at the inner </h3> and drop the method list.
  const clsRe =
    /<div[^>]*\sid="cls-([^"]+)"[^>]*>([\s\S]*?)<\/div>|<h3[^>]*\sid="cls-([^"]+)"[^>]*>([\s\S]*?)<\/h3>(?:\s*<ul\s+class="method-list">([\s\S]*?)<\/ul>)?/gi;
  for (let m = clsRe.exec(childrenHtml); m !== null; m = clsRe.exec(childrenHtml)) {
    const headingContent = m[2] ?? m[4] ?? '';
    const methodsHtml = (headingContent.match(/<ul\s+class="method-list">([\s\S]*?)<\/ul>/i) ||
      [null, m[5] ?? ''])[1];
    const isExported = headingContent.includes('class="export-badge"');

    const codeMatch = headingContent.match(/<h3[\s\S]*?<code>([^<]+)<\/code>|id="cls-[^"]+"[^>]*>[\s\S]*?<code>([^<]+)<\/code>/i)
      ?? headingContent.match(/<code>([^<]+)<\/code>/);
    if (!codeMatch) continue;
    const codeText = (codeMatch[1] ?? codeMatch[2] ?? '').trim();
    const extendsMatch = codeText.match(/^(\S+)\s+extends\s+(\S+)$/);
    const name = extendsMatch ? extendsMatch[1] : codeText;
    const extendsVal = extendsMatch ? extendsMatch[2] : undefined;

    const methods: string[] = [];
    const methodRe = /<code>([A-Za-z_][\w]*)\(\)<\/code>/g;
    for (let mm = methodRe.exec(methodsHtml); mm !== null; mm = methodRe.exec(methodsHtml)) {
      methods.push(mm[1].trim());
    }

    classes.push({ name, methods, isExported, ...(extendsVal ? { extends: extendsVal } : {}) });
  }
  return classes;
}

/**
 * Parse the see-also links already rendered on a file-neuron article back
 * into FileNeuronSeeAlsoLink[] (id/title pairs).
 *
 * Mirrors the shape rendered by renderSeeAlso() (annotator/blocks/see-also.ts):
 *   <section data-section="see-also">
 *     <h2>See also</h2>
 *     <ul><li><a href="#/ID" class="section-link">TITLE</a></li>...</ul>
 *   </section>
 *
 * See-also links are NOT part of FileNeuronEnrichment (they come from graph
 * edges / topic siblings computed at code-scan time, not from conversations),
 * so conv-file-enrichment.ts's re-render would otherwise silently drop them
 * every time a conversation attaches a decision/bug/idea to a file-neuron —
 * this parser lets that re-render carry the existing links through instead
 * of erasing them (same "parse back and preserve" pattern already used for
 * imports/exports/decisions/bugs above).
 *
 * @param html Full file-neuron article HTML.
 */
export function parseSeeAlsoFromHtml(html: string): FileNeuronSeeAlsoLink[] {
  const secMatch = html.match(/<section\s+data-section="see-also">([\s\S]*?)<\/section>/i);
  if (!secMatch) return [];

  const links: FileNeuronSeeAlsoLink[] = [];
  const linkRe = /<a\s+href="#\/([^"]+)"\s+class="section-link">([^<]*)<\/a>/gi;
  for (let m = linkRe.exec(secMatch[1]); m !== null; m = linkRe.exec(secMatch[1])) {
    const id = m[1];
    const title = unescapeHtml(m[2]).trim();
    if (id && title) links.push({ id, title });
  }
  return links;
}

// ---------------------------------------------------------------------------
// Enrichment section parsers (Task 5 carry-through)
// ---------------------------------------------------------------------------

/**
 * Unescape the small set of HTML entities produced by esc() (annotator/blocks/helpers.ts).
 * Inverse of esc(): &amp; &lt; &gt; &quot; &#39; → & < > " '.
 * &amp; is decoded last so an already-escaped "&amp;lt;" never turns into "<".
 */
function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Parse one conditional enrichment section (decisions/bugs/ideas/rules/qa, or
 * the singular "activity" section id that maps to the plural `activities`
 * field) from a file-neuron HTML article back into EnrichmentItem[].
 *
 * Mirrors the shape rendered by renderEnrichmentItem() in
 * annotator/blocks/composers/file-neuron.ts:
 *   <li [data-cerveau-superseded="true" data-cerveau-valid-until="D"]
 *       data-cerveau-confidence="C" data-cerveau-date="D">TEXT [<a href="LINK"
 *       class="conv-source">[source]</a>]</li>
 *
 * Used by extractFileNeuronStubsFromHtml/parseFileNeuronHtml so that
 * re-composing a touched file-neuron (conv-file-enrichment.ts) merges with —
 * rather than erases — whatever conversations already attached to it.
 *
 * @param html      Full file-neuron article HTML.
 * @param sectionId The data-section value to look for (e.g. "decisions", "activity").
 */
function parseEnrichmentSectionFromHtml(html: string, sectionId: string): EnrichmentItem[] {
  const secRe = new RegExp(`<section\\s+data-section="${sectionId}">([\\s\\S]*?)<\\/section>`, 'i');
  const secMatch = html.match(secRe);
  if (!secMatch) return [];

  const items: EnrichmentItem[] = [];
  const liRe = /<li([^>]*)>([\s\S]*?)<\/li>/gi;
  for (let m = liRe.exec(secMatch[1]); m !== null; m = liRe.exec(secMatch[1])) {
    const attrs = m[1];
    const inner = m[2];

    const confidenceMatch = attrs.match(/data-cerveau-confidence="([^"]*)"/i);
    const dateMatch = attrs.match(/data-cerveau-date="([^"]*)"/i);
    const isSuperseded = /data-cerveau-superseded="true"/i.test(attrs);
    const validUntilMatch = attrs.match(/data-cerveau-valid-until="([^"]*)"/i);

    // The [source] link is always the last element in the <li> — strip it off
    // and recover its href separately so it survives the round-trip too.
    const linkMatch = inner.match(/<a href="([^"]*)" class="conv-source">\[source\]<\/a>\s*$/i);
    const sourceConvLink = linkMatch ? unescapeHtml(linkMatch[1]) : '';
    const textHtml = linkMatch ? inner.slice(0, linkMatch.index).trim() : inner.trim();
    const text = unescapeHtml(textHtml);
    if (!text) continue;

    items.push({
      text,
      confidence: Number.parseFloat(confidenceMatch?.[1] ?? '') || 0.5,
      date: dateMatch?.[1] ?? '',
      sourceConvLink,
      ...(isSuperseded ? { superseded: true } : {}),
      ...(validUntilMatch?.[1] ? { validUntil: validUntilMatch[1] } : {}),
    });
  }
  return items;
}

/** The 6 enrichment fields carried on a CodeNode, populated only when present. */
interface ParsedEnrichment {
  decisions?: EnrichmentItem[];
  bugs?: EnrichmentItem[];
  ideas?: EnrichmentItem[];
  rules?: EnrichmentItem[];
  qa?: EnrichmentItem[];
  warnings?: EnrichmentItem[];
  activities?: EnrichmentItem[];
}

/**
 * Parse all conditional enrichment sections out of a file-neuron article.
 * Note: the composer's section id for `activities` is the singular "activity"
 * (annotator/blocks/composers/file-neuron.ts renderEnrichmentSection call) —
 * this asymmetry is mirrored here deliberately, not a typo.
 */
function parseEnrichmentFromHtml(html: string): ParsedEnrichment {
  const decisions = parseEnrichmentSectionFromHtml(html, 'decisions');
  const bugs = parseEnrichmentSectionFromHtml(html, 'bugs');
  const ideas = parseEnrichmentSectionFromHtml(html, 'ideas');
  const rules = parseEnrichmentSectionFromHtml(html, 'rules');
  const qa = parseEnrichmentSectionFromHtml(html, 'qa');
  const warnings = parseEnrichmentSectionFromHtml(html, 'warnings');
  const activities = parseEnrichmentSectionFromHtml(html, 'activity');
  return {
    ...(decisions.length > 0 ? { decisions } : {}),
    ...(bugs.length > 0 ? { bugs } : {}),
    ...(ideas.length > 0 ? { ideas } : {}),
    ...(rules.length > 0 ? { rules } : {}),
    ...(qa.length > 0 ? { qa } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(activities.length > 0 ? { activities } : {}),
  };
}

// ---------------------------------------------------------------------------
// High-level stub extractor
// ---------------------------------------------------------------------------

/**
 * Extract file-neuron CodeNode stubs from stored file-neuron HTML notes.
 *
 * Reads data-code-file, data-code-language, data-code-lines, data-cerveau-source
 * from the article element's attributes, then parses the existing architecture and
 * children sections to recover imports, exports, astFunctions and astClasses.
 * Also parses any decisions/bugs/ideas/rules/qa/activities sections already
 * attached by the conv→file-neuron enrichment pipeline (parseEnrichmentFromHtml).
 *
 * This ensures that when enrich re-renders a touched file-neuron via composeFileNeuron,
 * the architecture (imports/exports) and children (function/class anchors) sections
 * — and any already-attached conversational knowledge — are preserved, not erased.
 */
export function extractFileNeuronStubsFromHtml(notes: NoteFile[]): CodeNode[] {
  const stubs: CodeNode[] = [];
  for (const note of notes) {
    if (!note.html.includes('data-cerveau-type="file-neuron"')) continue;
    const fileMatch = note.html.match(/data-code-file\s*=\s*["']([^"']+)["']/i);
    const langMatch = note.html.match(/data-code-language\s*=\s*["']([^"']+)["']/i);
    const linesMatch = note.html.match(/data-code-lines\s*=\s*["']([^"']+)["']/i);
    const srcMatch = note.html.match(/data-cerveau-source\s*=\s*["']code-scanner:([^"']+)["']/i);
    if (!fileMatch || !srcMatch) continue;
    const filePath = fileMatch[1];
    const projectRoot = srcMatch[1];
    const language = langMatch?.[1] ?? 'unknown';
    const lineCount = Number.parseInt(linesMatch?.[1] ?? '0', 10) || 0;

    const imports = parseImportsFromHtml(note.html);
    const exports = parseExportsFromHtml(note.html);
    const astFunctions = parseAstFunctionsFromHtml(note.html);
    const astClasses = parseAstClassesFromHtml(note.html);
    const enrichment = parseEnrichmentFromHtml(note.html);

    stubs.push({
      id: `file:${filePath}`,
      title: filePath,
      type: 'file',
      filePath,
      projectRoot,
      language,
      lineCount,
      imports,
      exports,
      ...(astFunctions.length > 0 ? { astFunctions } : {}),
      ...(astClasses.length > 0 ? { astClasses } : {}),
      ...enrichment,
    });
  }
  return stubs;
}

/**
 * Parse a single file-neuron HTML note into a CodeNode, or return null if not
 * a valid file-neuron. Used by inject-context to parse on-the-fly without
 * loading the full note list.
 *
 * Carries through any decisions/bugs/ideas/rules/qa/activities already
 * attached by the conv→file-neuron enrichment pipeline (parseEnrichmentFromHtml)
 * so that compressFileNeuron (retrieval/compress-file-neuron.ts) can surface
 * them in the recall context alongside the code structure.
 */
export function parseFileNeuronHtml(html: string): CodeNode | null {
  if (!html.includes('data-cerveau-type="file-neuron"')) return null;
  const fileMatch = html.match(/data-code-file\s*=\s*["']([^"']+)["']/i);
  const srcMatch = html.match(/data-cerveau-source\s*=\s*["']code-scanner:([^"']+)["']/i);
  if (!fileMatch || !srcMatch) return null;

  const filePath = fileMatch[1];
  const projectRoot = srcMatch[1];
  const langMatch = html.match(/data-code-language\s*=\s*["']([^"']+)["']/i);
  const linesMatch = html.match(/data-code-lines\s*=\s*["']([^"']+)["']/i);
  const language = langMatch?.[1] ?? 'unknown';
  const lineCount = Number.parseInt(linesMatch?.[1] ?? '0', 10) || 0;

  const imports = parseImportsFromHtml(html);
  const exports = parseExportsFromHtml(html);
  const astFunctions = parseAstFunctionsFromHtml(html);
  const astClasses = parseAstClassesFromHtml(html);
  const enrichment = parseEnrichmentFromHtml(html);

  return {
    id: `file:${filePath}`,
    title: filePath,
    type: 'file',
    filePath,
    projectRoot,
    language,
    lineCount,
    imports,
    exports,
    ...(astFunctions.length > 0 ? { astFunctions } : {}),
    ...(astClasses.length > 0 ? { astClasses } : {}),
    ...enrichment,
  };
}
