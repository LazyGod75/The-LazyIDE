import { parseHTML } from 'linkedom';

export interface StrippedNote {
  id: string | null;
  text: string;
  type?: string;
  source?: string;
  created?: string;
  importance?: number;
  tags: string[];
  facts: StrippedFact[];
  links: StrippedLink[];
  valid_from?: string;
  valid_until?: string;
  // B5: structural relations + entities surfaced for stripNoteToPrompt.
  triples?: string; // "subj|pred|obj;subj|pred|obj"
  causes?: string; // "reason|reason"
  replaces?: string; // "X,Y"
  replaced_by?: string; // "X,Y"
  supersedes?: string; // "X,Y"
  entities?: string; // "db:postgres-prod,lib:react"
  // Wikipedia layer: wikilinks, see-also, categories, infobox
  infobox?: Record<string, string>;
  seeAlso?: string[];
  wikilinks?: Array<{ term: string; href: string }>;
  categories?: string[];
  // Phase 3: pre-computed cosine neighbours
  related?: string[];
  author?: string;
  authorId?: string;
  kind?: string;
  about?: string;
  status?: string;
  project?: string;
  orgId?: string;
  /**
   * Best-effort compact "lead" excerpt (<=240 chars) for prompt injection
   * when a note carries no `[data-cerveau-fact]` elements — true for every
   * file-neuron, since facts are a capture-note construct. Computed by
   * extractLeadText() with a priority order (enrichment knowledge sections >
   * tldr > raw document-order head-slice) so authored knowledge is never
   * discarded just because it sits after a page's structural chrome. See
   * stripNoteToPrompt(), the sole consumer.
   */
  leadText?: string;
}

export interface StrippedFact {
  text: string;
  confidence: number;
  extractor?: string;
  source?: string;
}

export interface StrippedLink {
  to: string;
  type?: string;
  text: string;
  strength?: number;
}

/**
 * Strip HTML node to clean text for LLM consumption.
 *
 * This is THE killer pattern: HTML for retrieval, stripped text for LLM.
 * - Preserves logical structure (headings, lists, paragraphs as newlines)
 * - Removes ALL tags
 * - Collapses whitespace
 * - Returns minimal payload (~30-40% of raw HTML size)
 */
export function stripTags(html: string): string {
  if (!html) return '';
  const { document } = parseHTML(`<!doctype html><html><head></head><body>${html}</body></html>`);
  const root = (document.body || document.documentElement) as Element | null;
  const walked = extractText(root);
  if (walked) return walked;
  // Fallback: linkedom's body access is unreliable on some fragments; use textContent.
  const text = root?.textContent ?? '';
  return text
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractText(node: Element | null): string {
  if (!node) return '';
  // Remove script/style/template entirely (security + irrelevance)
  for (const el of Array.from(node.querySelectorAll('script, style, template, noscript'))) {
    el.remove();
  }
  const out: string[] = [];
  walk(node, out);
  return out
    .join('')
    .replace(/[\t\f\v]+/g, ' ')
    .replace(/[ \u00A0]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const BLOCK_TAGS = new Set([
  'p',
  'div',
  'section',
  'article',
  'header',
  'footer',
  'aside',
  'main',
  'nav',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'li',
  'tr',
  'dt',
  'dd',
  'blockquote',
  'pre',
  'figure',
  'figcaption',
  'br',
  'hr',
]);

const LIST_ITEM_TAGS = new Set(['li', 'dt', 'dd']);

function walk(node: Element, out: string[]): void {
  for (const child of Array.from(node.childNodes)) {
    if ((child as unknown as { nodeType: number }).nodeType === 3) {
      // text
      out.push((child as unknown as { textContent: string | null }).textContent ?? '');
    } else if ((child as unknown as { nodeType: number }).nodeType === 1) {
      const el = child as Element;
      const tag = el.tagName.toLowerCase();
      if (LIST_ITEM_TAGS.has(tag)) {
        out.push('\n- ');
        walk(el, out);
      } else if (tag === 'section') {
        // Wikipedia sections: emit a leading [section-name] marker
        const sectionName = el.getAttribute('data-section');
        if (sectionName === 'see-also') {
          // Emit see-also as compact line
          const ids: string[] = [];
          for (const a of Array.from(el.querySelectorAll('a[href]'))) {
            const href = (a as Element).getAttribute('href') ?? '';
            const id = href.startsWith('#') ? href.slice(1) : href;
            if (id) ids.push(id);
          }
          if (ids.length > 0) {
            out.push(`\nSee also: [${ids.map((id) => `#${id}`).join(', ')}]\n`);
          }
        } else if (sectionName === 'references') {
          // Skip references section from plain text (file cites are noise)
          // but keep the text content for searchability
          out.push('\n');
          walk(el, out);
          out.push('\n');
        } else {
          if (sectionName && sectionName !== 'summary' && sectionName !== 'facts') {
            out.push(`\n[${sectionName}]\n`);
          } else {
            out.push('\n');
          }
          walk(el, out);
          out.push('\n');
        }
      } else if (tag === 'details') {
        // <details open> (primary fact) or <details> (secondary facts).
        // Emit the content of the nested <p data-cerveau-fact> for backward compat.
        const factEl = el.querySelector('[data-cerveau-fact]');
        if (factEl) {
          out.push('\n');
          out.push((factEl.textContent ?? '').trim());
          out.push('\n');
        } else {
          walk(el, out);
        }
      } else if (tag === 'summary') {
        // <summary> inside <details> — skip standalone emission (content is in the <p>)
      } else if (tag === 'data') {
        const val = el.getAttribute('value');
        if (val) out.push(val, ' ');
        walk(el, out);
      } else if (tag === 'aside' && el.classList.contains('disambig')) {
        // Disambiguation aside — surface as compact [X? choices: #id1, #id2]
        const choices: string[] = [];
        for (const a of Array.from(el.querySelectorAll('a[href]'))) {
          const href = (a as Element).getAttribute('href') ?? '';
          const linkId = href.startsWith('#') ? href.slice(1) : href;
          if (linkId) choices.push(`#${linkId}`);
        }
        const title = el.getAttribute('data-disambig-term') ?? 'X';
        if (choices.length > 0) {
          out.push(`[${title}? choices: ${choices.join(', ')}]\n`);
        }
      } else if (tag === 'aside' && el.hasAttribute('role')) {
        // DPub-ARIA roles — emit prefixed text
        const role = el.getAttribute('role') ?? '';
        const prefixMap: Record<string, string> = {
          'doc-tip': '[TIP]',
          'doc-warning': '[WARNING]',
          'doc-example': '[EXAMPLE]',
          'doc-errata': '[ERRATA]',
          'doc-note': '[DECISION]',
        };
        const prefix = prefixMap[role];
        if (prefix) {
          out.push(`${prefix} `);
          walk(el, out);
          out.push('\n');
        } else {
          walk(el, out);
        }
      } else if (tag === 'aside' && el.hasAttribute('data-cerveau-suggested-links')) {
        // Unlinked-mentions aside — surface as compact "Mentioned (unlinked): #id1, #id2"
        const ids: string[] = [];
        for (const a of Array.from(el.querySelectorAll('a[href]'))) {
          const href = (a as Element).getAttribute('href') ?? '';
          const linkId = href.startsWith('#') ? href.slice(1) : href;
          if (linkId) ids.push(`#${linkId}`);
        }
        if (ids.length > 0) {
          out.push(`Mentioned (unlinked): ${ids.join(', ')}\n`);
        }
      } else if (tag === 'aside' && el.classList.contains('glossary')) {
        // Glossary aside — skip, it's only for HTML rendering
      } else if (tag === 'aside' && el.classList.contains('infobox')) {
        // Flatten infobox dl to key: value | key: value on one line
        const pairs: string[] = [];
        const dts = Array.from(el.querySelectorAll('dt'));
        for (const dt of dts) {
          const dtText = (dt.textContent ?? '').trim();
          const dd = dt.nextElementSibling;
          const ddText = dd ? (dd.textContent ?? '').trim() : '';
          if (dtText && ddText) pairs.push(`${dtText}: ${ddText}`);
        }
        if (pairs.length > 0) {
          out.push(`${pairs.join(' | ')}\n`);
        }
      } else if (tag === 'header' || tag === 'footer') {
        // Keep interesting content but skip wrapper boilerplate
        walk(el, out);
      } else if (tag === 'nav' && el.classList.contains('categories')) {
        // Categories: strip prefix and join
        const cats: string[] = [];
        for (const a of Array.from(el.querySelectorAll('a'))) {
          const text = (a as Element).textContent?.trim();
          if (text) cats.push(text);
        }
        if (cats.length > 0) out.push(`Categories: ${cats.join(', ')}\n`);
      } else if (tag === 'nav' && el.classList.contains('see-also')) {
        // Already handled in section, skip double-emission
      } else if (BLOCK_TAGS.has(tag)) {
        out.push('\n');
        walk(el, out);
        out.push('\n');
      } else if (tag === 'a') {
        const href = el.getAttribute('href');
        const redLink = el.getAttribute('data-red-link');
        const rel = el.getAttribute('rel');
        const term = (el.textContent ?? '').trim();
        if (redLink) {
          // Red-link: [term?]
          out.push(`[${term}?]`);
        } else if (href?.startsWith('#') && rel) {
          // Typed graph edge with rel — e.g. [term→#id|prev]
          const id = href.slice(1);
          out.push(`[${term}→#${id}|${rel}]`);
        } else if (href?.startsWith('#')) {
          // Internal wikilink: [term→#id]
          const id = href.slice(1);
          out.push(`[${term}→#${id}]`);
        } else {
          out.push(term);
          if (href) out.push(` (${href})`);
        }
      } else if (tag === 'mark') {
        // Status badges and bug status marks
        const status = el.getAttribute('data-cerveau-status');
        const bugStatus = el.getAttribute('data-cerveau-bug-status');
        if (status) {
          out.push(`[${status.toUpperCase()}] `);
        } else if (bugStatus) {
          out.push(`[BUG:${bugStatus}] `);
        }
        walk(el, out);
      } else if (tag === 'del') {
        // Deprecated inline content
        const until = el.getAttribute('data-cerveau-valid-until');
        if (until) {
          out.push(`[DEPRECATED until ${until}] `);
        } else {
          out.push('[DEPRECATED] ');
        }
        walk(el, out);
      } else if (tag === 'meter') {
        // <meter value="0.85"> → "0.85 conf" or "N% done" for progress
        const progress = el.getAttribute('data-cerveau-progress');
        if (progress) {
          out.push(`${progress}% done`);
        } else {
          const value = el.getAttribute('value') ?? '';
          out.push(value ? `${value} conf` : (el.textContent ?? '').trim());
        }
      } else if (tag === 'time') {
        // <time datetime="P30D">30 days</time> → "valid 30d" when datetime is duration
        const dt = el.getAttribute('datetime') ?? '';
        if (/^P\d+D$/.test(dt)) {
          const days = dt.replace(/[^0-9]/g, '');
          out.push(`valid ${days}d`);
        } else {
          out.push((el.textContent ?? '').trim());
        }
      } else {
        walk(el, out);
      }
    }
  }
}

/**
 * Section ids that carry AUTHORED knowledge in a file-neuron — the
 * decisions/bugs/rules/etc. sections composeFileNeuron() (engine/src/
 * annotator/blocks/composers/file-neuron.ts, renderEnrichmentSection calls)
 * renders conditionally, after the structural chrome (breadcrumb, infobox,
 * tldr, architecture, children). Ordered by priority for extractLeadText():
 * decisions and bugs are the most load-bearing ("what we decided" / "what
 * broke"), then durable guidance (rules/warnings), then lower-confidence
 * items (ideas/qa), then activity — composeFileNeuron's own "honest fallback
 * for keyword-less conversations", so it is the least specific and goes last.
 *
 * This list must stay in sync with composeFileNeuron's enrichment sections;
 * it is deliberately NOT derived by scanning the DOM for `section[data-section]`
 * so priority order stays explicit and reviewable rather than "whatever
 * order the HTML happens to declare them in".
 */
const ENRICHMENT_SECTION_IDS = [
  'decisions',
  'bugs',
  'rules',
  'warnings',
  'ideas',
  'qa',
  'activity',
] as const;

/** Hard cap on extractLeadText()'s output — keeps the fallback path cheap. */
const LEAD_TEXT_BUDGET = 240;

/**
 * Compute the best compact (<=240 char) "lead" excerpt for a note when it has
 * no `[data-cerveau-fact]` elements — the case for every file-neuron.
 *
 * A blind `note.text.slice(0, 240)` (the prior behaviour) counts characters
 * from the very top of the document. composeFileNeuron() always emits
 * breadcrumb -> infobox -> tldr -> architecture -> symbols BEFORE any
 * decisions/bugs/rules section, so for any non-trivial file that budget is
 * consumed entirely by structural chrome and the authored knowledge — the
 * reason the brain exists — never reaches the model.
 *
 * Priority, first non-empty wins:
 *   1. Enrichment knowledge sections (ENRICHMENT_SECTION_IDS, in that
 *      priority order), concatenated until the budget is filled — this is
 *      the fix: meaningful content over document order.
 *   2. `section[data-section="tldr"]` — a one-line file summary. Still far
 *      more informative than breadcrumb/infobox chrome, so it is a better
 *      fallback than the raw head-slice, but never as good as authored
 *      knowledge when both exist.
 *   3. Raw head-slice of the full document text (original behaviour) — the
 *      true last resort, for notes with neither facts nor any of the above.
 *
 * Deterministic (no randomness, no async) and intentionally still capped at
 * LEAD_TEXT_BUDGET: this path exists to be cheap, not to become a second
 * full-subtree dump.
 */
function extractLeadText(root: Element): string {
  const enrichedParts: string[] = [];
  let enrichedLen = 0;
  for (const sectionId of ENRICHMENT_SECTION_IDS) {
    const section = root.querySelector(`section[data-section="${sectionId}"]`);
    if (!section) continue;
    const text = extractText(section as Element).trim();
    if (!text) continue;
    enrichedParts.push(text);
    enrichedLen += text.length;
    if (enrichedLen >= LEAD_TEXT_BUDGET) break;
  }
  if (enrichedParts.length > 0) {
    return enrichedParts.join(' ').slice(0, LEAD_TEXT_BUDGET);
  }

  const tldr = root.querySelector('section[data-section="tldr"]');
  if (tldr) {
    const text = extractText(tldr as Element).trim();
    if (text) return text.slice(0, LEAD_TEXT_BUDGET);
  }

  return extractText(root).trim().slice(0, LEAD_TEXT_BUDGET);
}

/**
 * Extract structured note from HTML — primary serialization for LLM injection.
 * This produces a compact object that the LLM can consume directly.
 */
export function stripNote(html: string): StrippedNote {
  const { document } = parseHTML(`<!doctype html><body>${html}</body>`);
  const root =
    document.querySelector('article[data-cerveau-version]') ??
    document.querySelector('article') ??
    document.body;

  if (!root) {
    return { id: null, text: stripTags(html), tags: [], facts: [], links: [] };
  }

  const tags = (root.getAttribute('data-cerveau-tags') ?? '').split(/\s+/).filter(Boolean);

  const facts: StrippedFact[] = Array.from(root.querySelectorAll('[data-cerveau-fact]')).map(
    (el) => ({
      text: extractText(el).trim(),
      confidence: Number.parseFloat(el.getAttribute('data-cerveau-confidence') ?? '1') || 1,
      extractor: el.getAttribute('data-cerveau-extracted-by') ?? undefined,
      source: el.getAttribute('data-cerveau-source') ?? undefined,
    }),
  );

  const links: StrippedLink[] = Array.from(
    root.querySelectorAll('a[href][data-cerveau-link-type]'),
  ).map((el) => ({
    to: el.getAttribute('href') ?? '',
    type: el.getAttribute('data-cerveau-link-type') ?? undefined,
    text: (el.textContent ?? '').trim(),
    strength: Number.parseFloat(el.getAttribute('data-cerveau-link-strength') ?? '') || undefined,
  }));

  // Wikipedia layer: parse infobox, see-also, wikilinks, categories
  const infobox = extractInfobox(root);
  const seeAlso = extractSeeAlso(root);
  const wikilinks = extractWikilinks(root);
  const categories = extractCategories(root);

  const relatedAttr = root.getAttribute('data-cerveau-related') ?? undefined;
  const related = relatedAttr ? relatedAttr.split(',').filter(Boolean) : undefined;

  return {
    id: root.getAttribute('id'),
    text: extractText(root),
    type: root.getAttribute('data-cerveau-type') ?? undefined,
    source: root.getAttribute('data-cerveau-source') ?? undefined,
    created: root.getAttribute('data-cerveau-created') ?? undefined,
    importance: Number.parseFloat(root.getAttribute('data-cerveau-importance') ?? '') || undefined,
    tags,
    facts,
    links,
    valid_from: root.getAttribute('data-cerveau-valid-from') ?? undefined,
    valid_until: root.getAttribute('data-cerveau-valid-until') ?? undefined,
    triples: root.getAttribute('data-cerveau-triples') ?? undefined,
    causes: root.getAttribute('data-cerveau-causes') ?? undefined,
    replaces: root.getAttribute('data-cerveau-replaces') ?? undefined,
    replaced_by: root.getAttribute('data-cerveau-replaced-by') ?? undefined,
    supersedes: root.getAttribute('data-cerveau-supersedes') ?? undefined,
    entities: root.getAttribute('data-cerveau-entities') ?? undefined,
    infobox: Object.keys(infobox).length > 0 ? infobox : undefined,
    seeAlso: seeAlso.length > 0 ? seeAlso : undefined,
    wikilinks: wikilinks.length > 0 ? wikilinks : undefined,
    categories: categories.length > 0 ? categories : undefined,
    related: related && related.length > 0 ? related : undefined,
    author: root.getAttribute('data-cerveau-author') ?? undefined,
    authorId: root.getAttribute('data-cerveau-author-id') ?? undefined,
    kind: root.getAttribute('data-cerveau-kind') ?? undefined,
    about: root.getAttribute('data-cerveau-about') ?? undefined,
    status: root.getAttribute('data-cerveau-status') ?? undefined,
    project: root.getAttribute('data-cerveau-project') ?? undefined,
    orgId: root.getAttribute('data-cerveau-org-id') ?? undefined,
    leadText: extractLeadText(root),
  };
}

/**
 * Strip only the elements matching a CSS selector from an HTML note.
 * Returns the concatenated text content of matched elements.
 *
 * Fallback behaviour: when the requested selector matches nothing in a note
 * that is non-empty, we attempt the following selectors in order before
 * giving up:
 *   1. section[data-section="tldr"]
 *   2. section[data-section="summary"]
 *   3. The first 240 characters of the full note text (lead)
 *
 * This guarantees that a real search hit is never stripped to empty string
 * even when the inferred section selector does not exist in the note's HTML.
 *
 * Use cases:
 * - stripSection(html, 'section[data-section="tldr"]') → 1-sentence summary (~30 tokens)
 * - stripSection(html, 'aside[role="doc-warning"]') → anti-pattern warnings (~20 tokens)
 * - stripSection(html, 'section[data-section="reasoning"]') → full reasoning (~100 tokens)
 * - stripSection(html, 'nav.topic-tree a') → topic tree links
 * - stripSection(html, 'details[open] summary') → primary facts only
 * - stripSection(html, 'table') → structured data tables
 */
export function stripSection(html: string, selector: string): string {
  if (!html || !selector) return '';
  const { document } = parseHTML(`<!doctype html><body>${html}</body>`);

  let matches: Element[];
  try {
    matches = Array.from(document.querySelectorAll(selector));
  } catch {
    // Invalid selector — fall through to fallback below with empty matches
    matches = [];
  }

  if (matches.length > 0) {
    const parts: string[] = [];
    for (const el of matches) {
      const text = extractText(el as Element);
      if (text.trim()) parts.push(text.trim());
    }
    const joined = parts.join('\n').trim();
    if (joined.length > 0) return joined;
  }

  // Selector matched nothing (or yielded only whitespace) — apply fallback
  // to guarantee non-empty output for a real hit.
  //
  // linkedom quirk: `document.body` returns an empty shell with no childNodes
  // even when body content is present. Use document.querySelector('body') or
  // document.documentElement to get the real populated root.
  const root =
    (document.querySelector('body') as Element | null) ??
    (document.documentElement as Element | null);
  if (!root || (root.textContent ?? '').trim().length === 0) return '';

  // Fallback 1: tldr section
  const tldr = root.querySelector('section[data-section="tldr"]');
  if (tldr) {
    const text = extractText(tldr as Element).trim();
    if (text.length > 0) return text;
  }

  // Fallback 2: summary section
  const summarySection = root.querySelector('section[data-section="summary"]');
  if (summarySection) {
    const text = extractText(summarySection as Element).trim();
    if (text.length > 0) return text.slice(0, 240);
  }

  // Fallback 3: first 240 characters of full note text (lead)
  const fullText = extractText(root as Element).trim();
  return fullText.slice(0, 240);
}

/**
 * Strip multiple sections from an HTML note in a single parse pass.
 * Returns a map of selector → stripped text.
 *
 * More efficient than calling stripSection() multiple times because
 * the HTML is only parsed once.
 */
export function stripSections(html: string, selectors: string[]): Record<string, string> {
  if (!html || selectors.length === 0) return {};
  const { document } = parseHTML(`<!doctype html><body>${html}</body>`);

  const result: Record<string, string> = {};
  for (const selector of selectors) {
    let matches: Element[];
    try {
      matches = Array.from(document.querySelectorAll(selector));
    } catch {
      result[selector] = '';
      continue;
    }

    const parts: string[] = [];
    for (const el of matches) {
      const text = extractText(el as Element);
      if (text.trim()) parts.push(text.trim());
    }
    result[selector] = parts.join('\n').trim();
  }

  return result;
}

function extractInfobox(root: Element): Record<string, string> {
  const result: Record<string, string> = {};
  const aside = root.querySelector('aside.infobox');
  if (!aside) return result;
  const dts = Array.from(aside.querySelectorAll('dt'));
  for (const dt of dts) {
    const key = (dt.textContent ?? '').trim();
    const dd = dt.nextElementSibling;
    if (key && dd) {
      result[key] = (dd.textContent ?? '').trim();
    }
  }
  return result;
}

function extractSeeAlso(root: Element): string[] {
  const ids: string[] = [];
  const nav =
    root.querySelector('nav.see-also') ?? root.querySelector('[data-section="see-also"] nav');
  if (!nav) return ids;
  for (const a of Array.from(nav.querySelectorAll('a[href]'))) {
    const href = (a as Element).getAttribute('href') ?? '';
    const id = href.startsWith('#') ? href.slice(1) : href;
    if (id) ids.push(id);
  }
  return ids;
}

function extractWikilinks(root: Element): Array<{ term: string; href: string }> {
  const result: Array<{ term: string; href: string }> = [];
  for (const a of Array.from(root.querySelectorAll('a[href][data-cerveau-link-type="see-also"]'))) {
    const href = (a as Element).getAttribute('href') ?? '';
    const term = ((a as Element).textContent ?? '').trim();
    if (term && href) result.push({ term, href });
  }
  return result;
}

function extractCategories(root: Element): string[] {
  const nav = root.querySelector('nav.categories');
  if (!nav) return [];
  return Array.from(nav.querySelectorAll('a'))
    .map((a) => ((a as Element).textContent ?? '').trim())
    .filter(Boolean);
}

const TYPE_LETTER: Record<string, string> = {
  decision: 'D',
  episodic: 'E',
  reference: 'R',
  semantic: 'S',
  procedural: 'P',
};

function shortNoteId(id: string | null | undefined): string {
  if (!id) return '';
  return id.replace(/^\d{4}-\d{2}-\d{2}-/, '').slice(0, 32);
}

/**
 * Compact textual representation of a stripped note for prompt injection.
 *
 * Density target: header ~12 tokens (vs ~25 before), facts ~5-15 each.
 * Format: `T YYYY-MM-DD #short (t1,t2)` + indented facts + relation glyphs.
 *
 * B5: relation hints (↺ replaces, ∵ causes, ◦ triples, ⊕ entities) are now
 * surfaced here too, matching the compactLine emitted by inject-context so the
 * recall path (skill, /search hydrate) sees the same graph signals as the
 * SessionStart inject path.
 */
export function stripNoteToPrompt(note: StrippedNote): string {
  const date = (note.created ?? '').slice(0, 10);
  const letter = TYPE_LETTER[note.type ?? ''] ?? '·';
  const id = shortNoteId(note.id);
  const tags = note.tags.length ? ` (${note.tags.slice(0, 4).join(', ')})` : '';
  const head = `${letter} ${date}${id ? ` #${id}` : ''}${tags}`.trim();
  // Fallback order when there are no [data-cerveau-fact] elements (every
  // file-neuron): prefer the precomputed leadText (enrichment knowledge >
  // tldr > head-slice — see extractLeadText()) over a blind head-slice of
  // the full note.text, so authored knowledge that sits after structural
  // chrome in document order still reaches the model. note.leadText is only
  // absent for the degenerate case where stripNote() found no root element
  // at all (empty/malformed HTML) — note.text.slice(0, 240) covers that.
  const leadFallback = note.leadText ?? note.text.split('\n').join(' ').slice(0, 240);
  const facts = note.facts.length
    ? `\n${note.facts.map((f) => `  - ${f.text}`).join('\n')}`
    : leadFallback
      ? `\n  ${leadFallback.split('\n').join(' ')}`
      : '';
  const links = note.links.length
    ? `\n  links: ${note.links.map((l) => `${l.type ?? '→'}${l.to}`).join(', ')}`
    : '';
  const rels = relationLine(note);
  // Wikipedia: see-also and wikilinks surfaced for cross-note activation
  const seeAlsoLine =
    note.seeAlso && note.seeAlso.length > 0
      ? `\n  See also: ${note.seeAlso.map((id) => `#${id}`).join(', ')}`
      : '';
  const wikiLine =
    note.wikilinks && note.wikilinks.length > 0
      ? `\n  → links: [${note.wikilinks
          .slice(0, 4)
          .map((w) => `${w.term}→${w.href}`)
          .join(', ')}]`
      : '';
  // Phase 3: pre-computed related neighbours (free cross-note candidates for LLM)
  const relatedLine =
    note.related && note.related.length > 0
      ? `\n  Related: [${note.related.map((id) => `#${id}`).join(', ')}]`
      : '';
  return `${head}${rels}${facts}${links}${seeAlsoLine}${wikiLine}${relatedLine}`;
}

function relationLine(note: StrippedNote): string {
  const parts: string[] = [];
  if (note.replaces) parts.push(`↺${note.replaces.split(',')[0]}`);
  if (note.replaced_by) parts.push(`↻${note.replaced_by.split(',')[0]}`);
  if (note.causes) {
    const first = note.causes.split('|')[0];
    if (first) parts.push(`∵${first.slice(0, 32)}`);
  }
  if (note.triples) {
    const first = note.triples.split(';')[0];
    if (first) parts.push(`◦${first}`);
  }
  if (note.entities) {
    const ents = note.entities.split(',').slice(0, 2).join(',');
    if (ents) parts.push(`⊕${ents}`);
  }
  return parts.length ? ` · ${parts.join(' · ')}` : '';
}
